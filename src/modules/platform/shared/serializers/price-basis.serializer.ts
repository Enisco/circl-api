import { PriceBasis } from '@prisma/client';

/**
 * Worded once, here, so four clients cannot word it differently.
 *
 * `unit` and `category` arrive as `{ code, label }`, and `priceBasis` arriving as a bare code was
 * read as free text by at least one client, which then sent the display words back and had them
 * rejected. The code stays exactly where it is; this rides beside it.
 */
const PRICE_BASIS_LABELS: Record<PriceBasis, string> = {
  PER_HOUR: 'per hour',
  PER_JOB: 'per job',
  PER_DAY: 'per day',
  // Standalone rather than trailing a price, so it reads as a sentence on its own.
  NEGOTIABLE: 'Negotiable',
};

export const toPriceBasisLabel = (basis: PriceBasis): string => PRICE_BASIS_LABELS[basis];
