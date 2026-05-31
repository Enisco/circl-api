import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SuccessResponse } from '@/common';

@Injectable()
export class TransformResponseInterceptor<T> implements NestInterceptor<T, SuccessResponse<T>> {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<SuccessResponse<T>> {
    return next.handle().pipe(
      map((data: any) => {
        const message = data?.message || 'Operation successful';
        const meta = data?.meta;
        const payload = data?.data !== undefined ? data.data : data;

        const response: SuccessResponse<T> = {
          status: 'success',
          message,
          data: payload,
        };

        if (meta) {
          response.meta = meta;
        }

        return response;
      }),
    );
  }
}
