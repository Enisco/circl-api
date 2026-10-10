import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'isIdempotent';
export const IDEMPOTENT_REQUIRED_KEY = 'isIdempotentRequired';

export interface IdempotentOptions {
  /**
   * Refuse the request outright when no `Idempotency-Key` is sent, rather than letting it through
   * unprotected. For actions where a double-apply is not recoverable by the person it happened to:
   * suspending a member, sending an announcement, anonymising an account.
   */
  required?: boolean;
}

/** Marks an endpoint as honouring `Idempotency-Key` (spec 0.12, admin §2.9). */
export const Idempotent = (options: IdempotentOptions = {}) => {
  const decorators = [SetMetadata(IDEMPOTENT_KEY, true)];

  if (options.required) decorators.push(SetMetadata(IDEMPOTENT_REQUIRED_KEY, true));

  return (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    for (const decorate of decorators) {
      (decorate as (t: object, k?: string | symbol, d?: PropertyDescriptor) => void)(
        target,
        key,
        descriptor,
      );
    }
  };
};
