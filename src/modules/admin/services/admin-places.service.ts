import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiErrorCode, ApiException } from '@/common';
import { PrismaService } from '@/infrastructure';
import { CityService } from '@/modules/platform/shared';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import {
  CreateCityDto,
  ListCitiesDto,
  ListSupportResourcesDto,
  PatchSupportResourceDto,
  UpdateCityDto,
  UpsertSupportResourceDto,
} from '../dtos/admin-places.dto';

/** What a support resource read needs off the row. */
interface SupportResourceRow {
  id: string;
  countryCode: string;
  name: string;
  phone: string | null;
  description: string | null;
  url: string | null;
  hours: string | null;
  isCrisis: boolean;
  sort: number;
  isActive: boolean;
  lastCheckedAt: Date;
  updatedAt: Date;
}

/**
 * §5.20: the places the platform knows about, and the numbers it hands somebody in trouble.
 *
 * Two small CRUD surfaces with one rule each that is worth more than the CRUD.
 *
 * **A city id is never renamed.** Every piece of content on the platform references it, and a
 * rename is a silent rewrite of history — a request filed in `MILTON_KEYNES` would start reading
 * as filed somewhere else. So `id` is immutable and the only way out of a mistake is to deactivate
 * and add the right one. The name is editable, because that is a label.
 *
 * **A support resource's `lastCheckedAt` moves only when somebody says so.** The app renders it as
 * "last checked", and that line is the only thing telling a member in crisis whether these numbers
 * are current. If an ordinary edit moved it, the date would say "verified today" because somebody
 * fixed a typo in the opening hours.
 */
@Injectable()
export class AdminPlacesService {
  constructor(
    private readonly database: PrismaService,
    private readonly cities: CityService,
    private readonly audit: AuditService,
  ) {}

  // ─── Cities ────────────────────────────────────────────────────────────────

  async listCities(query: ListCitiesDto) {
    const where: Prisma.CityWhereInput = {
      ...(query.region ? { region: { equals: query.region, mode: 'insensitive' } } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.q
        ? {
            OR: [
              { id: { contains: query.q.toUpperCase().replace(/[^A-Z0-9]+/g, '_') } },
              { name: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.database.city.findMany({ where, orderBy: { name: 'asc' } });

    return this.withCounts(rows);
  }

  async createCity(actor: AdminPrincipal, dto: CreateCityDto) {
    const existing = await this.database.city.findUnique({ where: { id: dto.id } });

    if (existing) {
      // Handed back rather than refused blankly: the likeliest cause is a city somebody
      // deactivated, and "it already exists, here it is" is what lets them reactivate it instead
      // of inventing `MILTON_KEYNES_2`.
      throw ApiException.conflict(
        ApiErrorCode.CONFLICT,
        `${dto.id} already exists${existing.isActive ? '' : ', deactivated'}.`,
        { data: { city: existing } },
      );
    }

    const { result } = await this.audit.mutate(
      {
        action: 'city.created' as const,
        targetType: 'CITY' as const,
        targetId: dto.id,
        targetLabel: dto.name,
        after: { ...dto },
      },
      tx =>
        tx.city.create({
          data: {
            id: dto.id,
            name: dto.name,
            region: dto.region ?? null,
            latitude: dto.latitude ?? null,
            longitude: dto.longitude ?? null,
            ...(dto.timezone ? { timezone: dto.timezone } : {}),
          },
        }),
    );

    this.cities.invalidate();

    return (await this.withCounts([result]))[0];
  }

  async updateCity(actor: AdminPrincipal, id: string, dto: UpdateCityDto) {
    const row = await this.database.city.findUnique({ where: { id } });

    if (!row) throw ApiException.notFound('No such city.');

    const { result } = await this.audit.mutate(
      {
        action: 'city.updated' as const,
        targetType: 'CITY' as const,
        targetId: id,
        targetLabel: dto.name ?? row.name,
        before: { name: row.name, region: row.region, isActive: row.isActive },
        after: {
          name: dto.name ?? row.name,
          region: dto.region === undefined ? row.region : dto.region,
          isActive: dto.isActive ?? row.isActive,
        },
      },
      tx =>
        tx.city.update({
          where: { id },
          data: {
            ...(dto.name ? { name: dto.name } : {}),
            ...(dto.region === undefined ? {} : { region: dto.region }),
            ...(dto.latitude === undefined ? {} : { latitude: dto.latitude }),
            ...(dto.longitude === undefined ? {} : { longitude: dto.longitude }),
            ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
          },
        }),
    );

    // The list is cached for five minutes, and a staff member who renames a city and cannot find
    // the new name reasonably concludes the save failed.
    this.cities.invalidate();

    return (await this.withCounts([result]))[0];
  }

  /**
   * The two numbers that decide whether a city can be deactivated safely.
   *
   * One grouped query each rather than per row: the city list is eleven rows today and will be a
   * hundred, and "how many members are here" per city per request is the kind of loop that reads
   * fine until the list grows.
   */
  private async withCounts(rows: Array<{ id: string; name: string; region: string | null }>) {
    if (!rows.length) return [];

    const ids = rows.map(row => row.id);
    const [members, requests, offers, listings, stores] = await Promise.all([
      this.database.userProfile.groupBy({
        by: ['cityId'],
        where: { cityId: { in: ids } },
        _count: { _all: true },
      }),
      this.database.communityRequest.groupBy({
        by: ['cityId'],
        where: { cityId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      this.database.communityOffer.groupBy({
        by: ['cityId'],
        where: { cityId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      this.database.professionalListing.groupBy({
        by: ['cityId'],
        where: { cityId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      this.database.store.groupBy({
        by: ['cityId'],
        where: { cityId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);

    const tally = (groups: Array<{ cityId: string | null; _count: { _all: number } }>) =>
      new Map(groups.map(group => [group.cityId ?? '', group._count._all]));

    const memberCounts = tally(members);
    const content = [requests, offers, listings, stores].map(tally);

    return (rows as Array<Record<string, unknown>>).map(row => ({
      ...row,
      memberCount: memberCounts.get(row.id as string) ?? 0,
      // One number, summed across the four kinds a city is stamped on: a staff member asking
      // "is anything here" does not want four numbers to add up themselves.
      contentCount: content.reduce((total, map) => total + (map.get(row.id as string) ?? 0), 0),
    }));
  }

  // ─── Support resources ─────────────────────────────────────────────────────

  async listResources(query: ListSupportResourcesDto) {
    const rows = await this.database.supportResource.findMany({
      where: {
        countryCode: query.countryCode ?? 'GB',
        ...(query.isCrisis === undefined ? {} : { isCrisis: query.isCrisis }),
        ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      },
      // The member's own order, so the staff list reads as the app renders it: crisis lines first.
      orderBy: [{ isCrisis: 'desc' }, { sort: 'asc' }, { name: 'asc' }],
    });

    return rows.map(row => this.toResource(row));
  }

  async createResource(actor: AdminPrincipal, dto: UpsertSupportResourceDto) {
    const countryCode = dto.countryCode ?? 'GB';

    if (!dto.phone && !dto.url) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'A support line needs a number or a link — otherwise there is nothing for a member to do with it.',
        { details: [{ field: 'phone', message: 'Give a phone number or a URL.' }] },
      );
    }

    const { result } = await this.audit.mutate(
      {
        action: 'support_resource.upserted' as const,
        targetType: 'SUPPORT_RESOURCE' as const,
        targetId: `${countryCode}:${dto.name}`,
        targetLabel: dto.name,
        after: { ...dto, countryCode },
      },
      tx =>
        tx.supportResource.upsert({
          where: { countryCode_name: { countryCode, name: dto.name } },
          // A name that already exists is an edit rather than a conflict: the unique key is
          // `(country, name)` and staff re-adding a line they deactivated is the common case.
          update: {
            phone: dto.phone ?? null,
            description: dto.description ?? null,
            url: dto.url ?? null,
            hours: dto.hours ?? null,
            isCrisis: dto.isCrisis,
            isActive: true,
            ...(dto.sort === undefined ? {} : { sort: dto.sort }),
          },
          create: {
            countryCode,
            name: dto.name,
            phone: dto.phone ?? null,
            description: dto.description ?? null,
            url: dto.url ?? null,
            hours: dto.hours ?? null,
            isCrisis: dto.isCrisis,
            sort: dto.sort ?? 0,
          },
        }),
    );

    return this.toResource(result);
  }

  async updateResource(actor: AdminPrincipal, id: string, dto: PatchSupportResourceDto) {
    const row = await this.database.supportResource.findUnique({ where: { id } });

    if (!row) throw ApiException.notFound('No such support resource.');

    const phone = dto.phone === undefined ? row.phone : dto.phone;
    const url = dto.url === undefined ? row.url : dto.url;

    if (!phone && !url && (dto.isActive ?? row.isActive)) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'An active support line needs a number or a link.',
        { details: [{ field: 'phone', message: 'Give a phone number or a URL.' }] },
      );
    }

    const { result } = await this.audit.mutate(
      {
        action: 'support_resource.upserted' as const,
        targetType: 'SUPPORT_RESOURCE' as const,
        targetId: id,
        targetLabel: dto.name ?? row.name,
        before: {
          name: row.name,
          phone: row.phone,
          url: row.url,
          hours: row.hours,
          isCrisis: row.isCrisis,
          isActive: row.isActive,
          lastCheckedAt: row.lastCheckedAt.toISOString(),
        },
        after: {
          name: dto.name ?? row.name,
          phone,
          url,
          hours: dto.hours === undefined ? row.hours : dto.hours,
          isCrisis: dto.isCrisis ?? row.isCrisis,
          isActive: dto.isActive ?? row.isActive,
          checked: dto.lastCheckedAt === 'now',
        },
      },
      tx =>
        tx.supportResource.update({
          where: { id },
          data: {
            ...(dto.name ? { name: dto.name } : {}),
            ...(dto.phone === undefined ? {} : { phone: dto.phone || null }),
            ...(dto.description === undefined ? {} : { description: dto.description || null }),
            ...(dto.url === undefined ? {} : { url: dto.url || null }),
            ...(dto.hours === undefined ? {} : { hours: dto.hours || null }),
            ...(dto.isCrisis === undefined ? {} : { isCrisis: dto.isCrisis }),
            ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
            ...(dto.sort === undefined ? {} : { sort: dto.sort }),
            // Only on request. An edit that moved it would have the app telling a member in
            // crisis "checked today" because somebody corrected the opening hours.
            ...(dto.lastCheckedAt === 'now' ? { lastCheckedAt: new Date() } : {}),
          },
        }),
    );

    return this.toResource(result);
  }

  /** Deactivates. Nothing is deleted from a list that has shipped. */
  async deactivateResource(actor: AdminPrincipal, id: string) {
    const row = await this.database.supportResource.findUnique({ where: { id } });

    if (!row) throw ApiException.notFound('No such support resource.');

    const { result } = await this.audit.mutate(
      {
        action: 'support_resource.deactivated' as const,
        targetType: 'SUPPORT_RESOURCE' as const,
        targetId: id,
        targetLabel: row.name,
        before: { isActive: row.isActive },
        after: { isActive: false },
      },
      (tx): Promise<SupportResourceRow> =>
        tx.supportResource.update({ where: { id }, data: { isActive: false } }),
    );

    return this.toResource(result);
  }

  private toResource(row: SupportResourceRow) {
    return {
      id: row.id,
      countryCode: row.countryCode,
      name: row.name,
      phone: row.phone,
      description: row.description,
      url: row.url,
      hours: row.hours,
      isCrisis: row.isCrisis,
      sort: row.sort,
      isActive: row.isActive,
      lastCheckedAt: row.lastCheckedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
