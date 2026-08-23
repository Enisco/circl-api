import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ErrorMessage } from '@/common/constants/error.message';
import { ApiErrorCode } from '@/common/constants/api-error-code.constant';
import { ErrorResponse } from '@/common/types/response.type';
import { ApiException, ApiErrorDetail } from '@/common/exceptions/api.exception';

interface StructuredExceptionResponse {
  message?: string | string[];
  errorType?: string;
  code?: string;
  details?: ApiErrorDetail[];
  data?: unknown;
  [key: string]: unknown;
}

interface ExtractedError {
  status: number;
  message: string;
  code: string;
  details?: ApiErrorDetail[];
  data?: unknown;
}

/**
 * The one error shape (spec 0.4).
 *
 * `error.code` is UPPER_SNAKE and is the only thing the client branches on;
 * `message` is human-readable and never parsed. `errorType` is kept alongside
 * `code` with the same value, because the shipped build reads it.
 */
@Catch()
export class HttpExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, message, code, details, data } = this.extractErrorDetails(exception);

    // Log the full details for debugging/monitoring. The details are folded into the message
    // because Nest's Logger treats a trailing string argument as the context and drops it
    // otherwise — deployed logs would carry no status, code or stack.
    // Client errors log at warn so genuine server faults stay findable amongst the 4xx noise.
    const summary = `Error on ${request.method} ${request.url} — [${status} ${code}] ${message}`;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const stack = exception instanceof Error ? exception.stack : undefined;

      this.logger.error(stack ? `${summary}\n${stack}` : summary);
    } else {
      this.logger.warn(summary);
    }

    const errorResponse: ErrorResponse = {
      success: false,
      status: 'error',
      message,
      // Spec 2.1.6: an "already done" conflict returns the existing record here so
      // the client can open it rather than dead-ending on the error.
      data: (data ?? null) as null,
      error: {
        code,
        errorType: code,
        message,
        ...(details?.length ? { details } : {}),
      },
    };

    response.status(status).json(errorResponse);
  }

  private extractErrorDetails(exception: unknown): ExtractedError {
    // 1) Our own exception, which already carries a stable code.
    if (exception instanceof ApiException) {
      const body = exception.getResponse() as StructuredExceptionResponse;

      return {
        status: exception.getStatus(),
        message: typeof body.message === 'string' ? body.message : ErrorMessage.GENERAL_ERROR,
        code: exception.code,
        details: exception.details,
        data: exception.data,
      };
    }

    // 2) Any other HttpException, including ValidationPipe's BadRequestException.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const rawRes = exception.getResponse();

      // class-validator failures arrive as an array of messages. Turn them into
      // one entry per offending field so the client can attach each message to
      // the right input (0.4).
      if (
        exception instanceof BadRequestException &&
        typeof rawRes === 'object' &&
        Array.isArray((rawRes as StructuredExceptionResponse).message)
      ) {
        const messages = (rawRes as StructuredExceptionResponse).message as string[];

        return {
          status,
          message: messages[0] ?? 'Validation failed',
          code: ApiErrorCode.VALIDATION_FAILED,
          details: messages.map(msg => ({ field: this.fieldFromMessage(msg), message: msg })),
        };
      }

      if (typeof rawRes === 'string') {
        return {
          status,
          message: rawRes,
          code: this.codeForStatus(status, exception.name),
        };
      }

      const structured = rawRes as StructuredExceptionResponse;
      let msg: string;

      if (Array.isArray(structured.message)) {
        msg = structured.message.join(', ');
      } else if (typeof structured.message === 'string') {
        msg = structured.message;
      } else {
        msg = ErrorMessage.GENERAL_ERROR;
      }

      const code =
        (typeof structured.code === 'string' && structured.code) ||
        (typeof structured.errorType === 'string' && structured.errorType) ||
        this.codeForStatus(status, exception.name);

      return {
        status,
        message: msg,
        code,
        details: structured.details,
        data: structured.data,
      };
    }

    // 3) Anything else is a server fault. Never leak the internal message.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: ErrorMessage.GENERAL_ERROR,
      code: ApiErrorCode.INTERNAL_ERROR,
    };
  }

  /**
   * Recovers the offending field from a flattened validation message.
   *
   * `field` has to match the request body key exactly, because the client
   * attaches each message to that input (0.4, 1.2.3). class-validator normally
   * puts the property first — but ValidationPipe's `forbidNonWhitelisted` writes
   * "property cityId should not exist", where the first word is the literal
   * "property" and the key is the second. Getting that wrong points every
   * unknown-field error at an input that does not exist.
   */
  private fieldFromMessage(message: string): string {
    const words = message.trim().split(/\s+/);

    return (words[0] === 'property' ? words[1] : words[0]) ?? 'unknown';
  }

  private codeForStatus(status: number, fallback: string): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ApiErrorCode.VALIDATION_FAILED;
      case HttpStatus.UNAUTHORIZED:
        return ApiErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ApiErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ApiErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ApiErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ApiErrorCode.RATE_LIMITED;
      default:
        return status >= 500 ? ApiErrorCode.INTERNAL_ERROR : fallback;
    }
  }
}
