import { Injectable } from '@nestjs/common';
import { City } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';

/** The literal that means "every city" on any endpoint taking a `cityId` (1.1). */
export const ANYWHERE = 'ANYWHERE';

@Injectable()
export class CityService {
  private cache: Map<string, City> | null = null;
  private byName: Map<string, City> | null = null;
  private loadedAt = 0;

  private static readonly TTL_MS = 300_000;

  constructor(private readonly database: PrismaService) {}

  private async ensureLoaded(): Promise<void> {
    if (this.cache && Date.now() - this.loadedAt < CityService.TTL_MS) return;

    const cities = await this.database.city.findMany();

    this.cache = new Map(cities.map(city => [city.id, city]));
    this.byName = new Map(cities.map(city => [city.name.toLowerCase(), city]));
    this.loadedAt = Date.now();
  }

  async list(): Promise<City[]> {
    await this.ensureLoaded();

    return [...this.cache!.values()]
      .filter(city => city.isActive)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async find(cityId: string): Promise<City | null> {
    await this.ensureLoaded();

    return this.cache!.get(cityId) ?? null;
  }

  async assertValid(cityId: string, field = 'cityId'): Promise<City> {
    const city = await this.find(cityId);

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

  /**
   * The interim compatibility rule from 1.0.3.
   *
   * The contract is `cityId`, but the shipped community screens filter by city
   * NAME (`?city=Manchester`) because the sample data is a list of strings. To let
   * the client migrate screen by screen without a flag day, every endpoint that
   * takes `cityId` also accepts `city` for one release, resolves it, and returns
   * the resolved city object so the client learns the id.
   *
   * `city` is deprecated on arrival. Its use is logged, and it goes once the
   * client stops sending it. If both are sent, `cityId` wins.
   */
  async resolve(cityId?: string | null, cityName?: string | null): Promise<City | null> {
    if (cityId && cityId !== ANYWHERE) {
      return this.find(cityId);
    }

    if (cityName) {
      await this.ensureLoaded();

      return this.byName!.get(cityName.trim().toLowerCase()) ?? null;
    }

    return null;
  }
}
