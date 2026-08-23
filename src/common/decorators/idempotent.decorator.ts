import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'isIdempotent';

/**
 * Marks a create endpoint as honouring `Idempotency-Key` (spec 0.12).
 *
 * Replaying the same key within 24 hours returns the original response rather
 * than creating a duplicate. Mobile networks retry, and a duplicate post in a
 * community feed is a visible embarrassment.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);
