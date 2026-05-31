import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ErrorMessage, ErrorResponse } from '@/common';

interface StructuredExceptionResponse {
  message?: string | string[];
  errorType?: string;
  [key: string]: unknown;
}

@Catch()
export class HttpExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Extract status, single-string message, and a string errorType
    const { status, message, errorType } = this.extractErrorDetails(exception);

    // Log the full details for debugging/monitoring
    this.logger.error(
      `Error on ${request.method} ${request.url}`,
      JSON.stringify({
        status,
        message,
        errorType,
        timestamp: new Date().toISOString(),
        stack: exception instanceof Error ? exception.stack : undefined,
      }),
    );

    // Build the standardized response shape
    const errorResponse: ErrorResponse = {
      status: 'error',
      error: {
        message,
        errorType,
      },
    };

    response.status(status).json(errorResponse);
  }

  private extractErrorDetails(exception: unknown): {
    status: number;
    message: string;
    errorType: string;
  } {
    // 1) If it’s an HttpException (including BadRequestException/ValidationPipe errors)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const rawRes = exception.getResponse();

      // Handle the special case of ValidationError from class-validator
      // Nest’s ValidationPipe throws a BadRequestException whose getResponse() is often:
      if (
        exception instanceof BadRequestException &&
        typeof rawRes === 'object' &&
        Array.isArray((rawRes as StructuredExceptionResponse).message)
      ) {
        const messages = (rawRes as StructuredExceptionResponse).message as string[];
        // Pick the first validation error:
        const firstMessage = messages.length > 0 ? messages[0] : 'Validation failed';

        return {
          status,
          message: firstMessage,
          errorType: 'ValidationError',
        };
      }

      // If getResponse() is a string, use that as the message
      if (typeof rawRes === 'string') {
        return {
          status,
          message: rawRes,
          // Use exception.name (e.g. "NotFoundException", "ConflictException")
          errorType: exception.name,
        };
      }

      // Otherwise, getResponse() is an object. We read its "message" and "errorType" if present.
      const structured = rawRes as StructuredExceptionResponse;
      let msg: string;

      // If the payload’s "message" is an array (but we didn’t hit BadRequestException above),
      // we still join it into a string. Otherwise, convert to string if it’s something else.
      if (Array.isArray(structured.message)) {
        msg = (structured.message as string[]).join(', ');
      } else if (typeof structured.message === 'string') {
        msg = structured.message;
      } else {
        // Fallback to a default if no message field
        msg = 'An unexpected error occurred';
      }

      // If the payload included an "errorType" field, use it; otherwise, use exception.name
      const code = typeof structured.errorType === 'string' ? structured.errorType : exception.name;

      return {
        status,
        message: msg,
        errorType: code,
      };
    }

    // 2) If it’s a plain JS Error (not an HttpException), treat as 500
    if (exception instanceof Error) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: ErrorMessage.INTERNAL_SERVER_ERROR,
        errorType: 'InternalServerError',
      };
    }

    // 3) For anything else (unlikely), also return 500
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: ErrorMessage.INTERNAL_SERVER_ERROR,
      errorType: 'InternalServerError',
    };
  }
}
