import { DealRole, DealStage, DealTiming, DealTrack } from '@prisma/client';
import { labelFor, mayMark, spineFor } from '../deal-spine';

describe('spineFor', () => {
  // The three worked examples from the spec, verbatim, because they are the contract.
  it('puts payment after receipt when paying on completion (commerce)', () => {
    expect(
      spineFor({
        track: DealTrack.COMMERCE,
        timing: DealTiming.ON_COMPLETION,
        depositAmount: null,
      }),
    ).toEqual(['AGREED', 'DISPATCHED', 'GOODS_RECEIVED', 'PAID', 'PAYMENT_CONFIRMED', 'DONE']);
  });

  it('puts payment first when paying upfront (commerce)', () => {
    expect(
      spineFor({ track: DealTrack.COMMERCE, timing: DealTiming.UPFRONT, depositAmount: null }),
    ).toEqual(['AGREED', 'PAID', 'PAYMENT_CONFIRMED', 'DISPATCHED', 'GOODS_RECEIVED', 'DONE']);
  });

  it('runs deposit, work, then the balance (professional)', () => {
    expect(
      spineFor({
        track: DealTrack.PROFESSIONAL,
        timing: DealTiming.ON_COMPLETION,
        depositAmount: 5000,
      }),
    ).toEqual([
      'AGREED',
      'DEPOSIT_PAID',
      'DEPOSIT_CONFIRMED',
      'STARTED',
      'WORK_DELIVERED',
      'ACCEPTED',
      'PAID',
      'PAYMENT_CONFIRMED',
      'DONE',
    ]);
  });

  // "Deposit first" and "all of it upfront" would otherwise describe two different orders for the
  // same deal, and the balance would be due before the deposit had been confirmed.
  it('forces the balance to the end even when the terms say upfront', () => {
    const spine = spineFor({
      track: DealTrack.PROFESSIONAL,
      timing: DealTiming.UPFRONT,
      depositAmount: 5000,
    });

    expect(spine.indexOf(DealStage.PAID)).toBeGreaterThan(spine.indexOf(DealStage.WORK_DELIVERED));
    expect(spine.indexOf(DealStage.DEPOSIT_PAID)).toBe(1);
  });

  it('never repeats a stage, and always starts agreed and ends done', () => {
    for (const track of [DealTrack.COMMERCE, DealTrack.PROFESSIONAL]) {
      for (const timing of [DealTiming.UPFRONT, DealTiming.ON_COMPLETION]) {
        for (const depositAmount of [null, 5000]) {
          const spine = spineFor({ track, timing, depositAmount });

          expect(new Set(spine).size).toBe(spine.length);
          expect(spine[0]).toBe(DealStage.AGREED);
          expect(spine[spine.length - 1]).toBe(DealStage.DONE);
        }
      }
    }
  });

  it('keeps the two tracks' + ' own fulfilment steps apart', () => {
    const commerce = spineFor({
      track: DealTrack.COMMERCE,
      timing: DealTiming.UPFRONT,
      depositAmount: null,
    });
    const professional = spineFor({
      track: DealTrack.PROFESSIONAL,
      timing: DealTiming.UPFRONT,
      depositAmount: null,
    });

    expect(commerce).not.toContain(DealStage.STARTED);
    expect(commerce).not.toContain(DealStage.ACCEPTED);
    expect(professional).not.toContain(DealStage.DISPATCHED);
    expect(professional).not.toContain(DealStage.GOODS_RECEIVED);
  });
});

describe('mayMark', () => {
  // A seller who could tick "payment received" for the buyer, or a buyer who could tick
  // "delivered", makes the timeline worthless as evidence (3.1).
  it('lets the payer claim payment and the provider confirm it, never the other way round', () => {
    expect(mayMark(DealStage.PAID, DealRole.PAYER)).toBe(true);
    expect(mayMark(DealStage.PAID, DealRole.PROVIDER)).toBe(false);
    expect(mayMark(DealStage.PAYMENT_CONFIRMED, DealRole.PROVIDER)).toBe(true);
    expect(mayMark(DealStage.PAYMENT_CONFIRMED, DealRole.PAYER)).toBe(false);
  });

  it('keeps fulfilment with the side that performs it', () => {
    expect(mayMark(DealStage.DISPATCHED, DealRole.PROVIDER)).toBe(true);
    expect(mayMark(DealStage.DISPATCHED, DealRole.PAYER)).toBe(false);
    expect(mayMark(DealStage.GOODS_RECEIVED, DealRole.PAYER)).toBe(true);
    expect(mayMark(DealStage.GOODS_RECEIVED, DealRole.PROVIDER)).toBe(false);
  });

  it('lets either finish it, and either agree — who may agree is the proposer check, not the role', () => {
    for (const role of [DealRole.PAYER, DealRole.PROVIDER]) {
      expect(mayMark(DealStage.DONE, role)).toBe(true);
      expect(mayMark(DealStage.AGREED, role)).toBe(true);
    }
  });
});

describe('labelFor', () => {
  it('tells a buyer who is collecting that the order is ready, not that it was sent', () => {
    expect(labelFor(DealStage.DISPATCHED, { collects: true })).toBe('Ready to collect');
    expect(labelFor(DealStage.DISPATCHED, { collects: false })).toBe('Sent');
  });

  it('and leaves every other step alone, whichever way the goods move', () => {
    for (const collects of [true, false]) {
      expect(labelFor(DealStage.GOODS_RECEIVED, { collects })).toBe('Received');
      expect(labelFor(DealStage.PAID, { collects })).toBe('Payment sent');
      expect(labelFor(DealStage.DONE, { collects })).toBe('Done');
    }
  });
});
