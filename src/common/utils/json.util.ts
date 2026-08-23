import { Prisma } from '@prisma/client';

/**
 * Narrows a plain object to Prisma's `InputJsonValue`.
 *
 * Prisma's generated input type is a recursive union that `Record<string,
 * unknown>` does not structurally satisfy, even when the value is valid JSON.
 * One cast here beats one at every call site.
 */
export const toJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export const toJsonOrUndefined = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined || value === null ? undefined : (value as Prisma.InputJsonValue);
