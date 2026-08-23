import { Store, StoreStatus, Weekday } from '@prisma/client';
import { distanceMiles, minutesOfDayIn } from '@/common';

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
 * Exactly 7 entries, Monday first, whatever is stored (4.5.1). The client already
 * renders "Open until 8pm" and "Opens Monday 9am" from this shape, so a short
 * array would break it.
 */
export const toOpeningHours = (
  rows: Array<{ day: Weekday; openMinutes: number | null; closeMinutes: number | null }>,
): OpeningHoursView[] => {
  const byDay = new Map(rows.map(row => [row.day, row] as const));

  return WEEK.map(day => ({
    day,
    openMinutes: byDay.get(day)?.openMinutes ?? null,
    closeMinutes: byDay.get(day)?.closeMinutes ?? null,
  }));
};

/**
 * Computed server-side, so the "Open now" filter and the badge always agree
 * (4.4.2).
 *
 * The seller's manual status overrides the hours: a store on holiday is not open
 * even at 10am on a Tuesday.
 */
export const isOpenNow = (
  status: StoreStatus,
  timezone: string,
  hours: OpeningHoursView[],
  at: Date = new Date(),
): boolean => {
  if (status !== StoreStatus.OPEN) return false;

  const { weekday, minutes } = minutesOfDayIn(timezone, at);
  const todayIndex = WEEK.findIndex(day => day === weekday);

  if (todayIndex === -1) return false;

  const today = hours[todayIndex];
  // Yesterday matters because a store open 6pm to 2am is still open at 1am.
  const yesterday = hours[(todayIndex + 6) % 7];

  const withinToday =
    today.openMinutes !== null &&
    today.closeMinutes !== null &&
    (today.closeMinutes > today.openMinutes
      ? minutes >= today.openMinutes && minutes < today.closeMinutes
      : minutes >= today.openMinutes);

  const spilledFromYesterday =
    yesterday.openMinutes !== null &&
    yesterday.closeMinutes !== null &&
    yesterday.closeMinutes <= yesterday.openMinutes &&
    minutes < yesterday.closeMinutes;

  return withinToday || spilledFromYesterday;
};

/**
 * The address, redacted in the serialiser rather than in the client (4.5.1).
 *
 * When `hidesExactAddress` is set, the precise point never leaves the server:
 * the coordinate is rounded to roughly a kilometre and line1 and postcode are
 * dropped entirely. Many of these shops are run by women from their kitchen, and
 * enforcing this client-side would mean the real address travelled over the wire
 * anyway.
 */
export const toAddressView = (store: Store) => {
  if (store.hidesExactAddress) {
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
