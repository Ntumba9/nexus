import { HttpException, HttpStatus } from '@nestjs/common';

export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * The only error type application code should throw. Carries a stable machine-readable `code`
 * and a client-safe `message`; the exception filter turns it into the uniform error envelope.
 */
export class ApiError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetail[],
    public readonly headers?: Record<string, string>,
  ) {
    super({ code, message }, status);
  }

  static badRequest(code: string, message: string): ApiError {
    return new ApiError(HttpStatus.BAD_REQUEST, code, message);
  }

  static validation(details: ErrorDetail[]): ApiError {
    return new ApiError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Invalid request', details);
  }

  static unauthenticated(code = 'UNAUTHENTICATED', message = 'Authentication required'): ApiError {
    return new ApiError(HttpStatus.UNAUTHORIZED, code, message);
  }

  static forbidden(
    code = 'FORBIDDEN',
    message = 'You do not have permission to perform this action',
  ): ApiError {
    return new ApiError(HttpStatus.FORBIDDEN, code, message);
  }

  /** Also used for resources that exist but belong to another tenant: they must look identical. */
  static notFound(message = 'Not found'): ApiError {
    return new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', message);
  }

  static conflict(code: string, message: string): ApiError {
    return new ApiError(HttpStatus.CONFLICT, code, message);
  }

  static tooManyRequests(retryAfterSeconds: number): ApiError {
    return new ApiError(
      HttpStatus.TOO_MANY_REQUESTS,
      'RATE_LIMITED',
      'Too many attempts. Please try again later.',
      undefined,
      { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    );
  }

  static unavailable(code: string, message: string): ApiError {
    return new ApiError(HttpStatus.SERVICE_UNAVAILABLE, code, message);
  }
}
