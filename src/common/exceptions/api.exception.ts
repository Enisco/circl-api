import { HttpException, HttpStatus } from '@nestjs/common';
import { ApiErrorCode } from '../constants/api-error-code.constant';

export interface ApiErrorDetail {
  field: string;
  message: string;
}

export interface ApiExceptionOptions {
  /** Extra payload returned in `data`. Spec 2.1.6: "already done" hands back the
   *  existing record so the client can open it rather than showing an error. */
  data?: unknown;
  /** One entry per offending field, so the client attaches the message to the
   *  right input (0.4). */
  details?: ApiErrorDetail[];
}

/**
 * The one exception every service throws.
 *
 * `code` is what the client branches on and `message` is what it shows; the two
 * are deliberately separate so wording can change without breaking a branch.
 */
export class ApiException extends HttpException {
  readonly code: ApiErrorCode;
  readonly details?: ApiErrorDetail[];
  readonly data?: unknown;

  constructor(
    status: HttpStatus,
    code: ApiErrorCode,
    message: string,
    options: ApiExceptionOptions = {},
  ) {
    super({ message, errorType: code, code, ...options }, status);
    this.code = code;
    this.details = options.details;
    this.data = options.data;
  }

  static badRequest(code: ApiErrorCode, message: string, options?: ApiExceptionOptions) {
    return new ApiException(HttpStatus.BAD_REQUEST, code, message, options);
  }

  static unprocessable(code: ApiErrorCode, message: string, options?: ApiExceptionOptions) {
    return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, code, message, options);
  }

  /**
   * 401 must mean "the access token is invalid or expired", nothing else — the
   * client logs the user out on it (0.2). Use `forbidden` for a permissions
   * problem.
   */
  static unauthorized(message: string, code: ApiErrorCode = ApiErrorCode.UNAUTHORIZED) {
    return new ApiException(HttpStatus.UNAUTHORIZED, code, message);
  }

  static forbidden(code: ApiErrorCode, message: string, options?: ApiExceptionOptions) {
    return new ApiException(HttpStatus.FORBIDDEN, code, message, options);
  }

  static notFound(message: string, code: ApiErrorCode = ApiErrorCode.NOT_FOUND) {
    return new ApiException(HttpStatus.NOT_FOUND, code, message);
  }

  /** A post that was removed, so the client renders a tombstone (0.4). */
  static deleted(resource = 'This content') {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ApiErrorCode.RESOURCE_DELETED,
      `${resource} is no longer available.`,
    );
  }

  static conflict(code: ApiErrorCode, message: string, options?: ApiExceptionOptions) {
    return new ApiException(HttpStatus.CONFLICT, code, message, options);
  }

  static gone(code: ApiErrorCode, message: string) {
    return new ApiException(HttpStatus.GONE, code, message);
  }

  static rateLimited(code: ApiErrorCode, message: string, options?: ApiExceptionOptions) {
    return new ApiException(HttpStatus.TOO_MANY_REQUESTS, code, message, options);
  }
}
