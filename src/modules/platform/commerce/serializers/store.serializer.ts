import { Store, StoreStatus, Weekday } from '@prisma/client';
import { distanceMiles } from '@/common';
import { isWithinWeeklyHours } from '../../shared';

const WEEK: Weekday[] = [
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
  Weekday.SATURDAY,
  Weekday.SUNDAY,
];

export interface OpeningHoursView {
  day: Weekday;
  openMinutes: number | null;
  closeMinutes: number | null;
}

/**
 * Seven entries Monday first when the shop keeps hours, null when it keeps none (4.5.1). Every
 * entry names its `day`, so a client never has to trust the order it arrived in.
 *
 * Three states, and the middle one is the one that was being lost. No rows at all means
 * appointment-only and comes back as null, not as seven closed days: seven closed days is a claim
 * that the shop never opens, which nobody means on purpose, and the page would print it.
 */
export const toOpeningHours = (
  rows: Array<{ day: Weekday; openMinutes: number | null; closeMinutes: number | null }>,
): OpeningHoursView[] | null => {
  if (!rows.length) return null;

  const byDay = new Map(rows.map(row => [row.day, row] as const));

  return WEEK.map(day => ({
    day,
    openMinutes: byDay.get(day)?.openMinutes ?? null,
    closeMinutes: byDay.get(day)?.closeMinutes ?? null,
  }));
};

/**
 * Computed server-side, so the "Open now" filter and the badge always agree (4.4.2).
 *
 * The manual switch is answered first: HOLIDAY or CLOSED is the seller saying so, whatever the
 * clock reads. A shop that keeps no hours is taken at its word and counted open, because the
 * alternative reads every one of them as shut every day — which is what was happening, and which
 * is a claim they never made.
 */
export const isOpenNow = (
  status: StoreStatus,
  timezone: string,
  hours: OpeningHoursView[] | null,
  at: Date = new Date(),
): boolean => {
  if (status !== StoreStatus.OPEN) return false;

  // The manual switch above is the shop's own; the clock below is shared with the professional's
  // "contactable now", because they are the same question about the same shape (v2 §4.2) and two
  // implementations drift into a badge disagreeing with the filter beside it.
  return isWithinWeeklyHours(timezone, hours, at);
};

/**
 * The address, redacted in the serialiser rather than in the client (4.5.1).
 *
 * The owner is the exception: they get their own back whatever the flag says, or the edit form
 * reopens empty and they have to retype an address they already gave us. Hiding is about who else
 * can see it, not about withholding it from the person who wrote it.
 */
export const toAddressView = (store: Store, isOwner = false) => {
  if (store.hidesExactAddress && !isOwner) {
    return {
      area: store.area,
      line1: null,
      postcode: null,
      latitude: roundToKilometre(store.latitude),
      longitude: roundToKilometre(store.longitude),
      isApproximate: true,
    };
  }

  return {
    area: store.area,
    line1: store.addressLine1,
    postcode: store.postcode,
    latitude: store.latitude,
    longitude: store.longitude,
    isApproximate: false,
  };
};

/** Two decimal places of a degree is a bit over a kilometre at UK latitudes. */
const roundToKilometre = (value: number | null): number | null =>
  value === null ? null : Number(value.toFixed(2));

/** Contact values are stored normalised; the display form is derived on read. */
export const toContactView = (contact: { channel: string; value: string }) => {
  switch (contact.channel) {
    case 'INSTAGRAM':
    case 'TIKTOK':
      return { ...contact, display: `@${contact.value}` };
    case 'WEBSITE':
      return {
        ...contact,
        display: contact.value.replace(/^https?:\/\//, '').replace(/^www\./, ''),
      };
    case 'PHONE':
    case 'WHATSAPP':
      return { ...contact, display: formatPhone(contact.value) };
    default:
      return { ...contact, display: contact.value };
  }
};

const formatPhone = (value: string): string => {
  const digits = value.replace(/[^\d+]/g, '');

  return digits.startsWith('+44') && digits.length === 13
    ? `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`
    : digits;
};

export const storeDistance = (
  origin: { latitude: number; longitude: number } | null,
  store: { latitude: number | null; longitude: number | null },
): number | null => (origin ? distanceMiles(origin, store) : null);
