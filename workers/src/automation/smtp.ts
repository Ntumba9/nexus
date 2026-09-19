import nodemailer from 'nodemailer';
import { EmailError, type EmailSender } from './email';

/**
 * Decide whether trying again could help. A timeout, a dropped connection or a 4xx "try later" answer
 * might pass on a second attempt; a rejected mailbox or a 5xx answer will not.
 */
export function classifySmtpError(error: unknown): EmailError {
  const err = error as { code?: string; responseCode?: number; message?: string };
  const message = `smtp: ${String(err?.code ?? 'error')}${err?.responseCode ? ` ${err.responseCode}` : ''}`;
  if (err?.code === 'EENVELOPE' || err?.code === 'EAUTH') return new EmailError(message, false);
  if (typeof err?.responseCode === 'number' && err.responseCode >= 500) {
    return new EmailError(message, false);
  }
  return new EmailError(message, true);
}

/**
 * Sends through a real SMTP server. `transporter` is injectable so it can be tested. The connection
 * URL contains credentials, so it is only ever passed to nodemailer and never logged or echoed:
 * errors are reduced to a short code above before they go anywhere.
 */
/** The one method of a nodemailer transporter that we use (lets tests substitute a fake). */
export interface MailTransporter {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export function createSmtpEmailSender(options: {
  from: string;
  transporter: MailTransporter;
}): EmailSender {
  return {
    async send(message) {
      try {
        await options.transporter.sendMail({
          from: options.from,
          to: message.to,
          subject: message.subject,
          text: message.text, // plain text only: user-controlled content is never treated as HTML
        });
      } catch (error) {
        throw classifySmtpError(error);
      }
    },
  };
}

export function createSmtpTransporter(smtpUrl: string): MailTransporter {
  return nodemailer.createTransport({
    url: smtpUrl,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}
