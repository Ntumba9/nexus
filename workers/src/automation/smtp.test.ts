import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EmailError } from './email';
import { classifySmtpError, createSmtpEmailSender, createSmtpTransporter } from './smtp';

/**
 * A minimal SMTP server, so the real nodemailer transport is exercised end to end (connection,
 * envelope, headers, body) without any external service.
 */
async function fakeSmtp(options: { rejectRecipient?: boolean } = {}) {
  const messages: { from: string; to: string[]; data: string }[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let inData = false;
    let current = { from: '', to: [] as string[], data: '' };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 localhost ESMTP fake');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(current);
          current = { from: '', to: [], data: '' };
          reply('250 queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') reply('250 localhost');
        else if (verb === 'MAIL') {
          current.from = line;
          reply('250 ok');
        } else if (verb === 'RCPT') {
          if (options.rejectRecipient) reply('550 5.1.1 mailbox unavailable');
          else {
            current.to.push(line);
            reply('250 ok');
          }
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 go ahead');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `smtp://127.0.0.1:${(server.address() as AddressInfo).port}`,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe('classifySmtpError', () => {
  it.each([
    [{ code: 'ETIMEDOUT' }, true],
    [{ code: 'ECONNECTION' }, true],
    [{ code: 'ESOCKET' }, true],
    [{ code: 'EPROTOCOL', responseCode: 421 }, true],
    [{ code: 'EENVELOPE', responseCode: 550 }, false],
    [{ code: 'EAUTH' }, false],
    [{ code: 'EPROTOCOL', responseCode: 550 }, false],
    [{ responseCode: 554 }, false],
    [new Error('who knows'), true],
  ])('%j is retryable: %s', (error, retryable) => {
    const result = classifySmtpError(error);
    expect(result).toBeInstanceOf(EmailError);
    expect(result.retryable).toBe(retryable);
  });

  it('never carries the original message (it could contain the credentials in the URL)', () => {
    const result = classifySmtpError(
      new Error('connect failed for smtp://user:hunter2@mail.example.com'),
    );
    expect(result.message).not.toContain('hunter2');
    expect(result.message).not.toContain('mail.example.com');
  });
});

describe('the SMTP sender (real nodemailer, fake server)', () => {
  const open: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  it('delivers a plain-text message with the right envelope and headers', async () => {
    const server = await fakeSmtp();
    open.push(server);
    const sender = createSmtpEmailSender({
      from: 'NEXUS <nexus@example.com>',
      transporter: createSmtpTransporter(server.url),
    });
    await sender.send({
      to: 'alex@example.com',
      subject: '[NEXUS] INC-7: Checkout is down',
      text: 'Details.\n\nhttps://nexus.example.com/orgs/x',
    });

    expect(server.messages).toHaveLength(1);
    const [message] = server.messages;
    expect(message!.from).toContain('nexus@example.com');
    expect(message!.to.join(' ')).toContain('alex@example.com');
    expect(message!.data).toContain('Subject: [NEXUS] INC-7: Checkout is down');
    expect(message!.data).toContain('Content-Type: text/plain');
    expect(message!.data).not.toMatch(/text\/html/i);
    expect(message!.data).toContain('Details.');
  });

  it('cannot be made to add a header or a recipient through the subject or address', async () => {
    const server = await fakeSmtp();
    open.push(server);
    const sender = createSmtpEmailSender({
      from: 'nexus@example.com',
      transporter: createSmtpTransporter(server.url),
    });
    await sender.send({
      to: 'alex@example.com',
      subject: 'Hello Bcc: attacker@example.com',
      text: 'x',
    });
    const data = server.messages[0]!.data;
    expect(data).not.toMatch(/^Bcc:/im);
    expect(server.messages[0]!.to.join(' ')).not.toContain('attacker');
  });

  it('reports a rejected mailbox as permanent, and an unreachable server as worth retrying', async () => {
    const rejecting = await fakeSmtp({ rejectRecipient: true });
    open.push(rejecting);
    const permanent = createSmtpEmailSender({
      from: 'nexus@example.com',
      transporter: createSmtpTransporter(rejecting.url),
    });
    await expect(
      permanent.send({ to: 'nobody@example.com', subject: 's', text: 't' }),
    ).rejects.toMatchObject({ retryable: false });

    const dead = await fakeSmtp();
    const url = dead.url;
    await dead.close(); // nothing is listening any more
    const transient = createSmtpEmailSender({
      from: 'nexus@example.com',
      transporter: createSmtpTransporter(url),
    });
    await expect(
      transient.send({ to: 'a@example.com', subject: 's', text: 't' }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it('does not put the connection URL in an error', async () => {
    const dead = await fakeSmtp();
    const port = new URL(dead.url).port;
    await dead.close();
    const url = `smtp://user:hunter2@127.0.0.1:${port}`;
    const sender = createSmtpEmailSender({
      from: 'nexus@example.com',
      transporter: createSmtpTransporter(url),
    });
    const error = await sender
      .send({ to: 'a@example.com', subject: 's', text: 't' })
      .catch((e: unknown) => e as Error);
    expect(String((error as Error).message)).not.toContain('hunter2');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('hunter2');
  });
});
