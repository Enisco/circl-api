const EARTH_RADIUS_MILES = 3958.8;

/** Great-circle distance in miles. */
export const distanceMiles = (
  from: { latitude: number; longitude: number },
  to: { latitude: number | null; longitude: number | null },
): number | null => {
  if (to.latitude === null || to.longitude === null) return null;

  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLon = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLon / 2) ** 2;

  return Number((EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(a))).toFixed(1));
};
