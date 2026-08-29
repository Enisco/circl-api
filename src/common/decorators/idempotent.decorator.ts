import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'isIdempotent';

/** Marks a create endpoint as honouring `Idempotency-Key` (spec 0.12). */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);
