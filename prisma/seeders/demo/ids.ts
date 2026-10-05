import { createHash } from 'crypto';

/** A stable UUID derived from a label (B.7: idempotent). */
export const seedId = (label: string): string => {
  const hash = createHash('sha256').update(`circl-seed:${label}`).digest('hex');

  // Shaped as a v4 UUID so nothing downstream can tell it was derived.
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
};

/**
 * A stable report token for a seeded row. Here rather than in one of the section seeders because
 * both sides of a module cycle need it, and a second copy of the formula would eventually drift.
 */
export const reportToken = (label: string): string =>
  `rpt_${seedId(label).replace(/-/g, '').slice(0, 20)}`;

/** Marks every row this seeder owns, so a reset can find them all. */
export const SEED_TAG = 'circl-seed';

/** `now - n` in whole hours, so every timestamp is relative to the run (B.2.1). */
export const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);
export const daysAgo = (days: number): Date => hoursAgo(days * 24);
export const daysAhead = (days: number): Date => new Date(Date.now() + days * 86_400_000);
