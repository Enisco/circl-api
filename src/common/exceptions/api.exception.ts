import { HttpException, HttpStatus } from '@nestjs/common';
import { ApiErrorCode } from '../constants/api-error-code.constant';

export interface ApiErrorDetail {
  field: string;
  message: string;
}

export interface ApiExceptionOptions {
  /** Extra payload returned in `data`. Spec 2.1.6: "already done" hands back the existing record so the client can open it rather than showing an error. */
  data?: unknown;
  /** One entry per offending field, so the client attaches the message to the right input (0.4). */
  details?: ApiErrorDetail[];
}

/** The one exception every service throws. */
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

  /** 401 must mean "the access token is invalid or expired", nothing else — the client logs the user out on it (0.2). */
  static unauthorized(message: string, code: ApiErrorCode = ApiErrorCode.UNAUTHORIZED) {
    return new ApiException(HttpStatus.UNAUTHORIZED, code, message);
  }

  static forbidden(code: ApiErrorCode, message: string, options?: ApiExceptionOptions) {
    return new ApiException(HttpStatus.FORBIDDEN, code, message, options);
  }

  /**
   * `options` so a 404 can carry something useful — the list of valid content types behind a
   * mistyped `/content/:type`, for instance. Added for the same reason `gone` has it: a refusal
   * that can only say "no" makes the caller guess what would have worked.
   */
  static notFound(
    message: string,
    code: ApiErrorCode = ApiErrorCode.NOT_FOUND,
    options?: ApiExceptionOptions,
  ) {
    return new ApiException(HttpStatus.NOT_FOUND, code, message, options);
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

  static gone(code: ApiErrorCode, message: string, options?: ApiExceptionOptions) {
    return new ApiException(HttpStatus.GONE, code, message, options);
  }

  static rateLimited(code: ApiErrorCode, message: string, options?: ApiExceptionOptions) {
    return new ApiException(HttpStatus.TOO_MANY_REQUESTS, code, message, options);
  }

  /**
   * 503: the request was fine and we could not answer it in time.
   *
   * Distinct from a 429, which says "you are asking too often", and from a 500, which says "we are
   * broken". An analytics query that hits its statement timeout is neither — the honest answer is
   * "ask for less", and the status has to say retrying later might work.
   */
  static unavailable(code: ApiErrorCode, message: string, options?: ApiExceptionOptions) {
    return new ApiException(HttpStatus.SERVICE_UNAVAILABLE, code, message, options);
  }
}
