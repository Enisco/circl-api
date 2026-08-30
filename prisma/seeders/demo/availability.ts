import { JobStage, JobState, Weekday } from '@prisma/client';
import { DemoSeedContext, userId } from './seed-demo';
import { daysAhead, hoursAgo, seedId } from './ids';

/**
 * Two to three weeks of forward availability per professional (G5). Deliberately NOT an identical
 * grid: a professional who only works evenings is what makes the screen worth having, and it is
 * the difference between a real calendar and the hardcoded six days and eight times the app used
 * to offer for everyone.
 */
const WEEKS: Record<string, { days: Partial<Record<Weekday, [number, number, number]>>; blocks: number[] }> = {
  // Blessing: weekdays, office hours, hour-long consultations.
  blessing: {
    days: {
      [Weekday.MONDAY]: [540, 1020, 60],
      [Weekday.TUESDAY]: [540, 1020, 60],
      [Weekday.WEDNESDAY]: [540, 1020, 60],
      [Weekday.THURSDAY]: [540, 1020, 60],
      [Weekday.FRIDAY]: [540, 780, 60],
    },
    // A week away, so the blocked state renders without hiding the next free slot.
    blocks: [9, 10],
  },
  // Chidi: a trade, so early starts and Saturdays, in half-hour slots.
  chidi: {
    days: {
      [Weekday.MONDAY]: [480, 960, 30],
      [Weekday.TUESDAY]: [480, 960, 30],
      [Weekday.WEDNESDAY]: [480, 960, 30],
      [Weekday.THURSDAY]: [480, 960, 30],
      [Weekday.FRIDAY]: [480, 960, 30],
      [Weekday.SATURDAY]: [540, 780, 30],
    },
    blocks: [4],
  },
  // Farida: evenings and weekends only, because she interprets around another job.
  farida: {
    days: {
      [Weekday.TUESDAY]: [1080, 1260, 60],
      [Weekday.THURSDAY]: [1080, 1260, 60],
      [Weekday.SATURDAY]: [600, 900, 60],
      [Weekday.SUNDAY]: [600, 780, 60],
    },
    blocks: [],
  },
};

/**
 * Slots already taken, so the picker shows a disabled chip with a reason rather than a grid where
 * everything is free. Each names a weekday and a clock time the listing actually works, and is
 * pinned to the next occurrence of that day so it stays in the future however long after seeding
 * the app is opened.
 */
const OCCUPIED: Array<{
  label: string;
  listing: string;
  service: string;
  client: number;
  weekday: number;
  time: string;
}> = [
  { label: 'occ1', listing: 'blessing', service: 'consult', client: 2, weekday: 2, time: '10:00' },
  { label: 'occ2', listing: 'blessing', service: 'student', client: 6, weekday: 4, time: '14:00' },
  { label: 'occ3', listing: 'farida', service: 'letter', client: 8, weekday: 6, time: '11:00' },
];

/** The next date that falls on `weekday`, never today, so the slot is always still to come. */
const nextWeekday = (weekday: number): Date => {
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const ahead = ((weekday - new Date(start).getUTCDay() + 7) % 7) || 7;

  return new Date(start + ahead * 86_400_000);
};

export const seedAvailability = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;
  let days = 0;

  for (const [label, rule] of Object.entries(WEEKS)) {
    const listingId = seedId(`listing:${label}`);

    for (const [day, hours] of Object.entries(rule.days)) {
      const [startMinutes, endMinutes, slotMinutes] = hours as [number, number, number];

      await prisma.listingAvailability.upsert({
        where: { listingId_day: { listingId, day: day as Weekday } },
        update: { startMinutes, endMinutes, slotMinutes },
        create: { listingId, day: day as Weekday, startMinutes, endMinutes, slotMinutes },
      });

      days += 1;
    }

    for (const offset of rule.blocks) {
      const date = new Date(daysAhead(offset).toISOString().slice(0, 10));

      await prisma.listingAvailabilityBlock.upsert({
        where: { listingId_date: { listingId, date } },
        update: {},
        create: { listingId, date, reason: 'Away' },
      });
    }
  }

  for (const taken of OCCUPIED) {
    const id = seedId(`booking:${taken.label}`);
    const preferredDate = nextWeekday(taken.weekday);
    const data = {
      clientId: userId(taken.client),
      professionalId: userId(PROFESSIONAL_OF[taken.listing]),
      listingId: seedId(`listing:${taken.listing}`),
      serviceId: seedId(`service:${taken.listing}:${taken.service}`),
      serviceName: 'Booked slot',
      quotedAmount: 6500,
      agreedAmount: 6500,
      state: JobState.ACCEPTED,
      mode: 'ONLINE' as never,
      preferredDate,
      preferredTimeSlot: taken.time,
      isFlexible: false,
      createdAt: hoursAgo(48),
    };

    await prisma.booking.upsert({ where: { id }, update: data, create: { id, ...data } });

    await prisma.bookingEvent.upsert({
      where: { bookingId_stage: { bookingId: id, stage: JobStage.REQUESTED } },
      update: {},
      create: { bookingId: id, stage: JobStage.REQUESTED, reachedAt: hoursAgo(48) },
    });
    await prisma.bookingEvent.upsert({
      where: { bookingId_stage: { bookingId: id, stage: JobStage.ACCEPTED } },
      update: {},
      create: { bookingId: id, stage: JobStage.ACCEPTED, reachedAt: hoursAgo(40) },
    });
  }

  return { days, occupied: OCCUPIED.length };
};

/** Which of the ten owns each listing. */
const PROFESSIONAL_OF: Record<string, number> = { blessing: 3, chidi: 4, farida: 5 };
