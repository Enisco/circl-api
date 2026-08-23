import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SuccessResponse } from '@/common/types/response.type';

/**
 * Wraps every successful handler return in the envelope from spec 0.3.
 *
 * A handler may return the payload directly, or `{ data, message, meta }` when it
 * wants to set either. A collection goes straight into `data` as an array —
 * never wrapped in a further `{ items: [...] }` layer — with paging in `meta`.
 *
 * The unwrapping rule matches what the shipped auth endpoints already rely on: a
 * `message` key anywhere on the returned object becomes the envelope message, and
 * a `data` key (when present) becomes the payload.
 */
@Injectable()
export class TransformResponseInterceptor<T> implements NestInterceptor<T, SuccessResponse<T>> {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<SuccessResponse<T>> {
    return next.handle().pipe(
      map((result: any) => {
        const message: string = result?.message ?? 'Operation successful';
        const payload = result?.data !== undefined ? result.data : result;
        const meta = result?.meta;

        const response: SuccessResponse<T> = {
          success: true,
          status: 'success',
          message,
          data: payload === undefined ? null : payload,
        };

        if (meta) {
          response.meta = meta;
        }

        return response;
      }),
    );
  }
}
