/** Money is an integer in minor units (pence) plus a currency code (spec 0.6). */
export interface Money {
  amount: number;
  currency: string;
}

export const money = (amount: number | null | undefined, currency = 'GBP'): Money | null =>
  amount === null || amount === undefined ? null : { amount, currency };
