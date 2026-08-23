/**
 * Money is an integer in minor units (pence) plus a currency code (spec 0.6).
 * `£30.00` is `{ amount: 3000, currency: 'GBP' }`. Never a float, never a string
 * with a symbol.
 *
 * Circl handles no money anywhere in this product (2.0.1, 4.0.1). These are
 * numbers two people agree between themselves, and nothing here is a ledger.
 */
export interface Money {
  amount: number;
  currency: string;
}

export const money = (amount: number | null | undefined, currency = 'GBP'): Money | null =>
  amount === null || amount === undefined ? null : { amount, currency };
