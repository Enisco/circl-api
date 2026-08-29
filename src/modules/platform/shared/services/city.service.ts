import { Injectable, Logger } from '@nestjs/common';
import { City } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';

/** The literal that means "every city" on any endpoint taking a `cityId` (1.1). */
export const ANYWHERE = 'ANYWHERE';

/** Folds the several spellings of one city onto a single key: "Milton Keynes", "milton-keynes" and "MILTON_KEYNES" all become MILTON_KEYNES. */
const normalise = (value: string): string =>
  value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

@Injectable()
export class CityService {
  private readonly logger = new Logger(CityService.name);

  private cache: Map<string, City> | null = null;
  private byName: Map<string, City> | null = null;
  /** Keyed on the normalised form of both the id and the name (1.0.3). */
  private byLoose: Map<string, City> | null = null;
  private loadedAt = 0;

  private static readonly TTL_MS = 300_000;

  constructor(private readonly database: PrismaService) {}

  private async ensureLoaded(): Promise<void> {
    if (this.cache && Date.now() - this.loadedAt < CityService.TTL_MS) return;

    const cities = await this.database.city.findMany();

    this.cache = new Map(cities.map(city => [city.id, city]));
    this.byName = new Map(cities.map(city => [city.name.toLowerCase(), city]));

    // Both spellings go into the same map, id last so a genuine id always wins a collision.
    this.byLoose = new Map();
    for (const city of cities) this.byLoose.set(normalise(city.name), city);
    for (const city of cities) this.byLoose.set(normalise(city.id), city);

    this.loadedAt = Date.now();
  }

  async list(): Promise<City[]> {
    await this.ensureLoaded();

    return [...this.cache!.values()]
      .filter(city => city.isActive)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Exact id only. Callers that must tolerate a name want `resolve`. */
  async find(cityId: string): Promise<City | null> {
    await this.ensureLoaded();

    return this.cache!.get(cityId) ?? null;
  }

  async assertValid(cityId: string, field = 'cityId'): Promise<City> {
    const city = await this.resolve(cityId);

    if (!city) {
      throw ApiException.unprocessable(
        ApiErrorCode.UNKNOWN_CITY,
        `"${cityId}" is not a known city.`,
        {
          details: [{ field, message: `"${cityId}" is not a known city.` }],
        },
      );
    }

    return city;
  }

  /** The interim compatibility rule from 1.0.3. */
  async resolve(cityId?: string | null, cityName?: string | null): Promise<City | null> {
    await this.ensureLoaded();

    const value = cityId?.trim() || null;

    if (value && value !== ANYWHERE) {
      const byId = this.cache!.get(value);

      if (byId) return byId;

      // Not an id, so it is a picked name or a device-manufactured code.
      const loose = this.byName!.get(value.toLowerCase()) ?? this.byLoose!.get(normalise(value));

      if (loose) {
        this.logger.log(`Deprecated city name in \`cityId\`: "${value}" resolved to ${loose.id}`);

        return loose;
      }

      return null;
    }

    if (cityName) {
      // Logged so there is evidence for when the deprecated parameter can be removed.
      this.logger.log(`Deprecated \`city\` name parameter used: "${cityName}"`);

      return (
        this.byName!.get(cityName.trim().toLowerCase()) ??
        this.byLoose!.get(normalise(cityName)) ??
        null
      );
    }

    return null;
  }
}
