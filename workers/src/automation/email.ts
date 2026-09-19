import type { Logger } from '../logger';

export interface EmailMessage {
  to: string;
  /** Single line: the caller strips line breaks (header injection is a real attack). */
  subject: string;
  /** Plain text only. Nothing user-controlled is ever interpreted as HTML. */
  text: string;
}

/** A delivery failure, saying whether trying again could help (a timeout) or not (a bad address). */
export class EmailError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmailError';
  }
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * The default transport: writes to the worker log instead of sending. It needs no external service,
 * so notifications work in development and in CI. The body is not logged.
 */
export function createLogEmailSender(logger: Logger): EmailSender {
  return {
    async send(message) {
      logger.info('email (log transport, not sent)', {
        to: message.to,
        subject: message.subject,
        bodyLength: message.text.length,
      });
    },
  };
}
