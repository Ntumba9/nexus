import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { ApiErrorBody } from '@nexus/shared';
import type { Response } from 'express';
import { ApiError } from './api-error';
import type { AppRequest } from './request-context';

const STATUS_CODES: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'Bad request' },
  401: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
  403: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
  404: { code: 'NOT_FOUND', message: 'Not found' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type' },
};

/**
 * Converts every failure into `{ error: { code, message, details?, requestId } }`.
 * Unknown errors become a generic 500: stack traces and internal messages are logged server-side
 * and never sent to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<AppRequest>();
    const response = http.getResponse<Response>();
    const requestId = request.id;

    let status = 500;
    let body: ApiErrorBody['error'] = {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong',
      requestId,
    };

    if (exception instanceof ApiError) {
      status = exception.getStatus();
      body = { code: exception.code, message: exception.message, requestId };
      if (exception.details) body.details = exception.details;
      for (const [name, value] of Object.entries(exception.headers ?? {})) {
        response.setHeader(name, value);
      }
    } else if (exception instanceof HttpException || hasClientStatus(exception)) {
      status = exception instanceof HttpException ? exception.getStatus() : exception.status;
      const known = STATUS_CODES[status];
      body = {
        code: known?.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'),
        message: known?.message ?? (status >= 500 ? 'Something went wrong' : 'Request failed'),
        requestId,
      };
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl?.split('?')[0]} -> ${status} [${requestId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({ error: body });
  }
}

/** Errors thrown by Express middleware (e.g. malformed JSON bodies) carry a numeric `status`. */
function hasClientStatus(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    (error as { status: number }).status >= 400 &&
    (error as { status: number }).status < 500
  );
}
