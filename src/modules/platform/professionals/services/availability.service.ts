import { Injectable } from '@nestjs/common';
import { JobState, Weekday } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiException } from '@/common';

/** Why a slot is not offered. Shown as a disabled chip rather than hidden (G5). */
export type SlotBlockedReason = 'BOOKED' | 'OUTSIDE_HOURS' | 'BLOCKED';

export interface SlotView {
  start: string;
  isAvailable: boolean;
  reason?: SlotBlockedReason;
}

export interface DayView {
  date: string;
  label: string;
  slots: SlotView[];
}

const WEEKDAYS: Weekday[] = [
  Weekday.SUNDAY,
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
  Weekday.SATURDAY,
];

/** Two weeks, which is as far ahead as the picker scrolls. */
const DEFAULT_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS = 60;

/** States that still hold their slot. A cancelled booking gives its time back. */
const HOLDS_A_SLOT: JobState[] = [
  JobState.PENDING_ACCEPTANCE,
  JobState.ACCEPTED,
  JobState.IN_PROGRESS,
  JobState.DELIVERED,
  JobState.CHANGES_REQUESTED,
];

/**
 * The booking slot picker used to offer the same six days and eight times for every professional,
 * forever, regardless of what they actually work or have already been booked for (G5).
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly database: PrismaService) {}

  async slots(listingId: string, query: { from?: string; to?: string }) {
    const listing = await this.database.professionalListing.findFirst({
      where: { id: listingId, deletedAt: null },
      select: {
        id: true,
        isAcceptingWork: true,
        availability: true,
        city: { select: { timezone: true } },
      },
    });

    if (!listing) throw ApiException.notFound('That listing could not be found.');

    const from = startOfDay(query.from ? new Date(query.from) : new Date());
    const requestedTo = query.to ? startOfDay(new Date(query.to)) : addDays(from, DEFAULT_WINDOW_DAYS - 1);
    const to = min(requestedTo, addDays(from, MAX_WINDOW_DAYS - 1));

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) {
      throw ApiException.notFound('That date range could not be read.');
    }

    const byDay = new Map(listing.availability.map(row => [row.day, row] as const));
    const [blocks, booked] = await Promise.all([
      this.database.listingAvailabilityBlock.findMany({
        where: { listingId, date: { gte: from, lte: to } },
        select: { date: true },
      }),
      this.database.booking.findMany({
        where: {
          listingId,
          state: { in: HOLDS_A_SLOT },
          preferredDate: { gte: from, lte: addDays(to, 1) },
        },
        select: { preferredDate: true, preferredTimeSlot: true },
      }),
    ]);

    const blockedDates = new Set(blocks.map(row => isoDate(row.date)));
    const takenSlots = new Set(
      booked
        .filter(row => row.preferredDate && row.preferredTimeSlot)
        .map(row => `${isoDate(row.preferredDate!)}T${row.preferredTimeSlot}`),
    );

    const days: DayView[] = [];

    for (let cursor = new Date(from); cursor <= to; cursor = addDays(cursor, 1)) {
      const date = isoDate(cursor);
      const rule = byDay.get(WEEKDAYS[cursor.getUTCDay()]);
      const isBlocked = blockedDates.has(date);

      // A day the professional does not work is left out rather than sent as a row of dead chips.
      if (!rule) continue;

      const slots: SlotView[] = [];

      for (
        let minutes = rule.startMinutes;
        minutes + rule.slotMinutes <= rule.endMinutes;
        minutes += rule.slotMinutes
      ) {
        const start = toClock(minutes);
        const isTaken = takenSlots.has(`${date}T${start}`);
        const isPast = cursor.getTime() === startOfDay(new Date()).getTime() && isBefore(minutes);

        slots.push(
          isBlocked
            ? { start, isAvailable: false, reason: 'BLOCKED' }
            : isTaken
              ? { start, isAvailable: false, reason: 'BOOKED' }
              : isPast
                ? { start, isAvailable: false, reason: 'OUTSIDE_HOURS' }
                : { start, isAvailable: true },
        );
      }

      if (slots.length) days.push({ date, label: dayLabel(cursor), slots });
    }

    return {
      data: {
        // From the listing's city, so a professional in Edinburgh and one in London agree on "09:00".
        timezone: listing.city?.timezone ?? 'Europe/London',
        isAcceptingWork: listing.isAcceptingWork,
        // An empty `days` is a valid answer and the screen falls back to "I'm flexible" only.
        acceptsFlexible: true,
        days,
      },
    };
  }
}

const startOfDay = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);
const min = (a: Date, b: Date) => (a < b ? a : b);
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const toClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const isBefore = (minutes: number) => {
  const now = new Date();

  return now.getUTCHours() * 60 + now.getUTCMinutes() >= minutes;
};

/** Server-formatted, so the app holds no date vocabulary of its own. */
const dayLabel = (date: Date) =>
  `${date.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${date.getUTCDate()}`;
