import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { Observable, of, throwError } from 'rxjs';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode } from '../../constants/api-error-code.constant';
import { IdempotencyInterceptor } from '../idempotency.interceptor';

const RESPONSE = { data: { id: 'created-1' } };
const BODY = { title: 'A request' };

/** The interceptor hashes the body to tell a retry from a different request sent under one key. */
const hashOf = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

const contextFor = (
  body: unknown = BODY,
  options: { path?: string } = {},
): ExecutionContext =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { 'idempotency-key': 'key-1' },
        user: { id: 'user-1' },
        method: 'POST',
        // The pattern and the concrete path differ on any route with a parameter, which is the
        // whole of B5: the interceptor must key on the second.
        route: { path: '/api/v1/admin/members/:id/suspend' },
        path: options.path ?? '/api/v1/community/requests',
        body,
      }),
      getResponse: () => ({ statusCode: 201 }),
    }),
  }) as unknown as ExecutionContext;

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: 'test',
  });

/** A row as the interceptor reads it back. `statusCode: null` is a claim with no answer yet. */
const record = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'rec-1',
  requestHash: hashOf(BODY),
  statusCode: 201,
  responseBody: RESPONSE,
  startedAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  ...over,
});

const settle = () => new Promise(resolve => setImmediate(resolve));

/**
 * The guarantee: one resource per key, whichever order the attempts arrive in. The interceptor used
 * to record the key after answering, which let a retry beat the write, and let two attempts in
 * flight at once both go through.
 */
describe('IdempotencyInterceptor', () => {
  const reflector = { getAllAndOverride: () => true } as unknown as Reflector;

  const run = (
    idempotencyRecord: Record<string, unknown>,
    handler: () => Observable<unknown> = () => of(RESPONSE),
    bodyOrOptions?: unknown,
  ) => {
    const options =
      bodyOrOptions && typeof bodyOrOptions === 'object' && 'path' in bodyOrOptions
        ? (bodyOrOptions as { path: string })
        : undefined;

    return new IdempotencyInterceptor(reflector, { idempotencyRecord } as unknown as PrismaService)
      .intercept(contextFor(options ? BODY : bodyOrOptions, options ?? {}), {
        handle: handler,
      } as CallHandler)
      .toPromise();
  };

  const caught = async (promise: Promise<unknown>) => {
    try {
      await promise;

      return null;
    } catch (error) {
      return error as { errorCode?: string; code?: string; getStatus?: () => number };
    }
  };

  it('claims the key before the handler runs', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const order: string[] = [];

    await run(
      {
        findUnique: () => Promise.resolve(null),
        create: (...args: unknown[]) => {
          order.push('claim');

          return create(...args);
        },
        update: () => {
          order.push('record');

          return Promise.resolve(undefined);
        },
      },
      () => {
        order.push('handler');

        return of(RESPONSE);
      },
    );

    expect(order).toEqual(['claim', 'handler', 'record']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('replays the first answer rather than making a second of whatever it made', async () => {
    const handler = jest.fn(() => of({ data: { id: 'created-2' } }));
    const response = await run(
      { findUnique: () => Promise.resolve(record()), create: jest.fn(), update: jest.fn() },
      handler,
    );

    expect(response).toEqual(RESPONSE);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a duplicate of something still running, and never reaches the handler', async () => {
    const handler = jest.fn(() => of(RESPONSE));
    const error = await caught(
      run(
        {
          findUnique: () => Promise.resolve(record({ statusCode: null, responseBody: null })),
          create: jest.fn(),
          update: jest.fn(),
        },
        handler,
      ),
    );

    expect(error?.getStatus?.()).toBe(409);
    expect(JSON.stringify(error)).toContain(ApiErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS);
    expect(handler).not.toHaveBeenCalled();
  });

  it('and refuses one that claims the key between the read and the insert', async () => {
    const handler = jest.fn(() => of(RESPONSE));
    const error = await caught(
      run(
        {
          findUnique: () => Promise.resolve(null),
          create: () => Promise.reject(uniqueViolation()),
          update: jest.fn(),
        },
        handler,
      ),
    );

    expect(JSON.stringify(error)).toContain(ApiErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS);
    expect(handler).not.toHaveBeenCalled();
  });

  it('takes over a claim abandoned by a process that died', async () => {
    const handler = jest.fn(() => of(RESPONSE));
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });

    const response = await run(
      {
        findUnique: () =>
          Promise.resolve(
            record({
              statusCode: null,
              responseBody: null,
              startedAt: new Date(Date.now() - 10 * 60 * 1000),
            }),
          ),
        updateMany,
        update: () => Promise.resolve(undefined),
        create: jest.fn(),
      },
      handler,
    );

    expect(response).toEqual(RESPONSE);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('but not one another attempt took over first', async () => {
    const error = await caught(
      run({
        findUnique: () =>
          Promise.resolve(
            record({
              statusCode: null,
              responseBody: null,
              startedAt: new Date(Date.now() - 10 * 60 * 1000),
            }),
          ),
        updateMany: () => Promise.resolve({ count: 0 }),
        update: jest.fn(),
        create: jest.fn(),
      }),
    );

    expect(JSON.stringify(error)).toContain(ApiErrorCode.IDEMPOTENT_REQUEST_IN_PROGRESS);
  });

  it('refuses a key that already succeeded for a different request', async () => {
    const handler = jest.fn(() => of(RESPONSE));

    const error = await run(
      {
        findUnique: () => Promise.resolve(record({ requestHash: 'A DIFFERENT BODY' })),
        updateMany: () => Promise.resolve({ count: 1 }),
        update: () => Promise.resolve(undefined),
        create: jest.fn(),
      },
      handler,
    ).catch((caught: unknown) => caught);

    // Not a retry — a retry sends what it sent before. Running it would apply a second, different
    // action under a key the caller believes covers one, and hand back the first one's receipt.
    expect(JSON.stringify(error)).toContain(ApiErrorCode.IDEMPOTENCY_KEY_REUSED);
    expect(handler).not.toHaveBeenCalled();
  });

  it('but lets a different body take over a key whose window has passed', async () => {
    const handler = jest.fn(() => of(RESPONSE));

    await run(
      {
        findUnique: () =>
          Promise.resolve(
            record({ requestHash: 'A DIFFERENT BODY', expiresAt: new Date(Date.now() - 1000) }),
          ),
        updateMany: () => Promise.resolve({ count: 1 }),
        update: () => Promise.resolve(undefined),
        create: jest.fn(),
      },
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keys on the concrete path, so one key cannot answer for two resources', async () => {
    const seen: string[] = [];
    const handler = jest.fn(() => of(RESPONSE));

    for (const path of ['/api/v1/admin/members/aaa/suspend', '/api/v1/admin/members/bbb/suspend']) {
      await run(
        {
          findUnique: () => Promise.resolve(null),
          create: (args: { data: { endpoint: string } }) => {
            seen.push(args.data.endpoint);

            return Promise.resolve(undefined);
          },
          update: () => Promise.resolve(undefined),
        },
        handler,
        { path },
      );
    }

    // Keyed on the route PATTERN these were one endpoint, so the second call replayed the first
    // member's response and the second suspension silently never happened (B5).
    expect(new Set(seen).size).toBe(2);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('holds the response until the answer is recorded', async () => {
    let release: () => void = () => undefined;
    const recorded = new Promise<void>(resolve => {
      release = resolve;
    });
    const emitted: unknown[] = [];

    void run({
      findUnique: () => Promise.resolve(null),
      create: () => Promise.resolve(undefined),
      update: () => recorded,
    }).then(value => emitted.push(value));

    await settle();
    expect(emitted).toHaveLength(0);

    release();
    await settle();

    expect(emitted).toEqual([RESPONSE]);
  });

  it('gives the key back when the create fails, so the same post can be tried again', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const error = await caught(
      run(
        {
          findUnique: () => Promise.resolve(null),
          create: () => Promise.resolve(undefined),
          update: jest.fn(),
          delete: remove,
        },
        () => throwError(() => new Error('the handler refused it')),
      ),
    );

    expect((error as Error).message).toBe('the handler refused it');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('still answers when the record cannot be written: the resource exists either way', async () => {
    const response = await run({
      findUnique: () => Promise.resolve(null),
      create: () => Promise.resolve(undefined),
      update: () => Promise.reject(new Error('database down')),
    });

    expect(response).toEqual(RESPONSE);
  });
});
