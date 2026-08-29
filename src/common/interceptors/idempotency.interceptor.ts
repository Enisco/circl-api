import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import { createHash } from 'crypto';
import { PrismaService } from '@/infrastructure';
import { IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';
import { AuthenticatedUser } from '../decorators/current-user.decorator';
import { toJson } from '../utils/json.util';

const TTL_MS = 24 * 60 * 60 * 1000;

/** Honours `Idempotency-Key` on the creates that declare `@Idempotent()` (spec 0.12). */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly database: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!isIdempotent) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const key = request.headers['idempotency-key'];
    const userId = (request.user as AuthenticatedUser | undefined)?.id;

    if (typeof key !== 'string' || !key || !userId) return next.handle();

    const endpoint = `${request.method} ${request.route?.path ?? request.path}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(request.body ?? {}))
      .digest('hex');

    return from(
      this.database.idempotencyRecord.findUnique({
        where: { userId_key_endpoint: { userId, key, endpoint } },
      }),
    ).pipe(
      switchMap(existing => {
        if (existing && existing.expiresAt > new Date() && existing.requestHash === requestHash) {
          return of(existing.responseBody);
        }

        return next.handle().pipe(
          tap(response => {
            void this.database.idempotencyRecord
              .upsert({
                where: { userId_key_endpoint: { userId, key, endpoint } },
                update: {
                  requestHash,
                  responseBody: toJson(response),
                  expiresAt: new Date(Date.now() + TTL_MS),
                },
                create: {
                  userId,
                  key,
                  endpoint,
                  requestHash,
                  statusCode: context.switchToHttp().getResponse().statusCode ?? 201,
                  responseBody: toJson(response),
                  expiresAt: new Date(Date.now() + TTL_MS),
                },
              })
              // A failure to record idempotency must never fail the create that already succeeded.
              .catch(() => undefined);
          }),
        );
      }),
    );
  }
}
