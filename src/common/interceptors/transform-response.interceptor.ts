import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SuccessResponse } from '@/common/types/response.type';

/** Wraps every successful handler return in the envelope from spec 0.3. */
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
