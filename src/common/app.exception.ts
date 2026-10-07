/**
 * Error type carrying everything the HTTP error contract needs: the numeric
 * status, a stable machine code and optional extra fields to merge into the
 * response body (for example `attemptsRemaining` on a failed login).
 *
 * Thrown anywhere in the request path; the global exception filter renders it
 * as `{statusCode, code, message}` with the message localized per request.
 * The `message` passed to `Error` is only for logs — clients never see it.
 */
export class AppException extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    details?: Record<string, unknown>
  ) {
    super(code);
    this.name = 'AppException';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const isAppException = (error: unknown): error is AppException =>
  error instanceof AppException;
