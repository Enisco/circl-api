import { Prisma } from '@prisma/client';

/** Narrows a plain object to Prisma's `InputJsonValue`. */
export const toJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export const toJsonOrUndefined = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined || value === null ? undefined : (value as Prisma.InputJsonValue);
