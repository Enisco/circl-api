export interface CityView {
  id: string;
  name: string;
  region: string | null;
}

export const toCityView = (
  city: { id: string; name: string; region?: string | null } | null | undefined,
): CityView | null => (city ? { id: city.id, name: city.name, region: city.region ?? null } : null);
