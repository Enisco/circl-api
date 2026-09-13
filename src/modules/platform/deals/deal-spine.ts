import { DealRole, DealStage, DealTiming, DealTrack } from '@prisma/client';

/**
 * The order of a deal's steps, computed from its terms rather than fixed.
 *
 * A fixed order would be wrong for a large share of real deals: paying on collection is normal in a
 * marketplace and paying on completion is normal for a trade, so `timing` moves the payment pair to
 * either side of fulfilment. A deposit always sits right after AGREED and forces the balance to the
 * end, so "deposit first" and "all of it upfront" cannot contradict each other.
 */
export const spineFor = (terms: {
  track: DealTrack;
  timing: DealTiming;
  depositAmount: number | null;
}): DealStage[] => {
  const deposit = terms.depositAmount ? [DealStage.DEPOSIT_PAID, DealStage.DEPOSIT_CONFIRMED] : [];
  const payment = [DealStage.PAID, DealStage.PAYMENT_CONFIRMED];

  const fulfilment =
    terms.track === DealTrack.COMMERCE
      ? [DealStage.DISPATCHED, DealStage.GOODS_RECEIVED]
      : [DealStage.STARTED, DealStage.WORK_DELIVERED, DealStage.ACCEPTED];

  // A deposit pushes the balance to the end whatever the timing says, because money up front is
  // already covered by the deposit and asking for the rest first as well is not a real deal.
  const paymentLast = deposit.length > 0 || terms.timing === DealTiming.ON_COMPLETION;

  return [
    DealStage.AGREED,
    ...deposit,
    ...(paymentLast ? [...fulfilment, ...payment] : [...payment, ...fulfilment]),
    DealStage.DONE,
  ];
};

/** Who may mark each stage. The basis of the record: nobody ticks the other side's box (3.1). */
const MARKED_BY: Record<DealStage, DealRole | 'EITHER'> = {
  // The party who did NOT propose, which is checked against proposedByRole rather than by role.
  [DealStage.AGREED]: 'EITHER',
  [DealStage.DEPOSIT_PAID]: DealRole.PAYER,
  [DealStage.PAID]: DealRole.PAYER,
  [DealStage.GOODS_RECEIVED]: DealRole.PAYER,
  [DealStage.ACCEPTED]: DealRole.PAYER,
  [DealStage.DEPOSIT_CONFIRMED]: DealRole.PROVIDER,
  [DealStage.PAYMENT_CONFIRMED]: DealRole.PROVIDER,
  [DealStage.STARTED]: DealRole.PROVIDER,
  [DealStage.DISPATCHED]: DealRole.PROVIDER,
  [DealStage.WORK_DELIVERED]: DealRole.PROVIDER,
  [DealStage.DONE]: 'EITHER',
};

export const mayMark = (stage: DealStage, role: DealRole): boolean =>
  MARKED_BY[stage] === 'EITHER' || MARKED_BY[stage] === role;

/** The stages that carry a figure, and the stage that freezes each one (3.4). */
export const CONFIRMS: Partial<Record<DealStage, DealStage>> = {
  [DealStage.DEPOSIT_PAID]: DealStage.DEPOSIT_CONFIRMED,
  [DealStage.PAID]: DealStage.PAYMENT_CONFIRMED,
};

export const CARRIES_AMOUNT: DealStage[] = [DealStage.DEPOSIT_PAID, DealStage.PAID];

/** Human wording for the system note and the notification, so both read the same (4). */
export const STAGE_LABELS: Record<DealStage, string> = {
  [DealStage.AGREED]: 'Terms agreed',
  [DealStage.DEPOSIT_PAID]: 'Deposit sent',
  [DealStage.DEPOSIT_CONFIRMED]: 'Deposit received',
  [DealStage.PAID]: 'Payment sent',
  [DealStage.PAYMENT_CONFIRMED]: 'Payment received',
  [DealStage.STARTED]: 'Work started',
  [DealStage.WORK_DELIVERED]: 'Work delivered',
  [DealStage.DISPATCHED]: 'Sent',
  [DealStage.GOODS_RECEIVED]: 'Received',
  [DealStage.ACCEPTED]: 'Work accepted',
  [DealStage.DONE]: 'Done',
};

/**
 * The wording for one step of one deal. Only `collects` moves it: a buyer picking an order up is
 * told it is ready, not that it was sent, and the note in the thread has to read the way the panel
 * beside it reads.
 */
export const labelFor = (stage: DealStage, terms: { collects: boolean }): string =>
  stage === DealStage.DISPATCHED && terms.collects ? 'Ready to collect' : STAGE_LABELS[stage];
