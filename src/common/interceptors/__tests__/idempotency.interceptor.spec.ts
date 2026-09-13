import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { PrismaService } from '@/infrastructure';
import { IdempotencyInterceptor } from '../idempotency.interceptor';

const contextFor = (): ExecutionContext =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { 'idempotency-key': 'key-1' },
        user: { id: 'user-1' },
        method: 'POST',
        route: { path: '/api/v1/community/requests' },
        path: '/api/v1/community/requests',
        body: { title: 'A request' },
      }),
      getResponse: () => ({ statusCode: 201 }),
    }),
  }) as unknown as ExecutionContext;

/**
 * The one thing this interceptor exists to guarantee: by the time a caller holds the response, the
 * key is recorded. It used to write fire-and-forget, so a client retrying the moment it got a
 * response could find no record and create a second resource.
 */
describe('IdempotencyInterceptor', () => {
  const reflector = { getAllAndOverride: () => true } as unknown as Reflector;

  const run = (upsert: () => Promise<unknown>) => {
    const database = {
      idempotencyRecord: { findUnique: () => Promise.resolve(null), upsert },
    } as unknown as PrismaService;
    const next = { handle: () => of({ data: { id: 'created-1' } }) } as CallHandler;

    return new IdempotencyInterceptor(reflector, database).intercept(contextFor(), next);
  };

  it('holds the response until the record is written', async () => {
    let release: () => void = () => undefined;
    const written = new Promise<void>(resolve => {
      release = resolve;
    });

    const emitted: unknown[] = [];

    run(() => written).subscribe(value => emitted.push(value));

    // The handler has already produced its value; the record has not landed.
    await Promise.resolve();
    expect(emitted).toHaveLength(0);

    release();
    await written;
    await new Promise(resolve => setImmediate(resolve));

    expect(emitted).toEqual([{ data: { id: 'created-1' } }]);
  });

  it('still answers when the record cannot be written: the resource exists either way', async () => {
    const emitted = await new Promise<unknown>(resolve =>
      run(() => Promise.reject(new Error('database down'))).subscribe(value => resolve(value)),
    );

    expect(emitted).toEqual({ data: { id: 'created-1' } });
  });
});
