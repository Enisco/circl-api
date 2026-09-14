import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { Observable, catchError, concatMap, from, map, of, switchMap, throwError } from 'rxjs';
import { createHash } from 'crypto';
import { PrismaError, PrismaService } from '@/infrastructure';
import { ApiErrorCode } from '../constants/api-error-code.constant';
import { ApiException } from '../exceptions/api.exception';
import { IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';
import { AuthenticatedUser } from '../decorators/current-user.decorator';
import { toJson } from '../utils/json.util';

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long an unfinished reservation is believed. A process that dies mid-request would otherwise
 * hold its key for the whole 24 hours; past this the next attempt takes it over. Long enough that
 * no real request is still running, short enough that a crash is not felt for the rest of the day.
 */
const IN_FLIGHT_TTL_MS = 5 * 60 * 1000;

/** A duplicate of something the server is still working on. There is no result to hand back yet. */
const inProgress = () =>
  ApiException.conflict(
    ApiErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS,
    'That is already going through. Give it a moment rather than sending it again.',
  );

type Reservation = { replay: Prisma.JsonValue } | { replay: null };

/**
 * Honours `Idempotency-Key` on the creates that declare `@Idempotent()` (spec 0.12).
 *
 * The key is claimed **before** the handler runs, not recorded after it. Recording afterwards left
 * two ways to create the same thing twice: a client retrying the instant it had a response could
 * beat the write, and two attempts genuinely in flight at once both read "no record" and both went
 * through. A member who taps Post again after a minute is the second case, and it is the one that
 * happens.
 */
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
    const where = { userId_key_endpoint: { userId, key, endpoint } };

    return from(this.reserve({ userId, key, endpoint, requestHash })).pipe(
      switchMap(reservation => {
        // Answered before: the same response, rather than a second of whatever it made.
        if (reservation.replay !== null) return of(reservation.replay);

        return next.handle().pipe(
          concatMap(response =>
            from(
              this.database.idempotencyRecord
                .update({
                  where,
                  data: {
                    statusCode: context.switchToHttp().getResponse().statusCode ?? 201,
                    responseBody: toJson(response),
                  },
                })
                // Never fails the create that already succeeded: the resource exists, and refusing
                // to hand back the id of a thing now in the database is a worse answer than an
                // unrecorded key.
                .catch(() => undefined),
            ).pipe(map(() => response)),
          ),
          // Nothing was created, so the key goes back immediately. Holding it would leave a member
          // whose post failed unable to try the same post again until tomorrow.
          catchError((error: unknown) =>
            from(this.database.idempotencyRecord.delete({ where }).catch(() => undefined)).pipe(
              switchMap(() => throwError(() => error)),
            ),
          ),
        );
      }),
    );
  }

  /**
   * Claims the key for this attempt, or says what the caller should get instead: the earlier
   * response where there is one, and a refusal where the earlier attempt is still running.
   */
  private async reserve(input: {
    userId: string;
    key: string;
    endpoint: string;
    requestHash: string;
  }): Promise<Reservation> {
    const { userId, key, endpoint, requestHash } = input;
    const now = new Date();
    const fresh = {
      requestHash,
      statusCode: null,
      responseBody: Prisma.DbNull,
      startedAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
    };

    const existing = await this.database.idempotencyRecord.findUnique({
      where: { userId_key_endpoint: { userId, key, endpoint } },
    });

    if (existing) {
      // A key sent again with a different body is a different request, and the member editing the
      // text of a post that failed is exactly that. Same body within the window is the retry.
      const same = existing.expiresAt > now && existing.requestHash === requestHash;

      if (same && existing.statusCode !== null) return { replay: existing.responseBody };
      if (same && existing.startedAt.getTime() > now.getTime() - IN_FLIGHT_TTL_MS)
        throw inProgress();

      // Expired, a different body, or abandoned by a process that died. Taking it over is a write
      // against the row as it was read, so two attempts cannot both believe they took it.
      const taken = await this.database.idempotencyRecord.updateMany({
        where: { id: existing.id, startedAt: existing.startedAt },
        data: fresh,
      });

      if (!taken.count) throw inProgress();

      return { replay: null };
    }

    try {
      await this.database.idempotencyRecord.create({
        data: { userId, key, endpoint, ...fresh },
      });
    } catch (error) {
      // Somebody claimed it between the read and the insert. Whatever they are doing with it, this
      // attempt is the duplicate.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PrismaError.UniqueConstraintViolation
      ) {
        throw inProgress();
      }

      throw error;
    }

    return { replay: null };
  }
}
