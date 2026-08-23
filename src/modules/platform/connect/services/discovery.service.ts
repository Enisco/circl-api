import { Injectable } from '@nestjs/common';
import { Prisma, TaxonomyKind, ThreadContextType, TrustCheckType } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ageFromDateOfBirth, ApiException, buildPageMeta } from '@/common';
import { BlockingService, TaxonomyService } from '../../shared';
import { CONNECT_MINIMUM_AGE } from '../../taxonomy/services/taxonomy-catalogue.service';
import { DiscoveryDto } from '../dtos/connect.dto';
import { ConnectProfileService } from './connect-profile.service';

export interface SharedContext {
  sameCountry?: string;
  sameJourneyStage?: string;
  mutualGroupCount?: number;
}

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly database: PrismaService,
    private readonly profiles: ConnectProfileService,
    private readonly taxonomy: TaxonomyService,
    private readonly blocking: BlockingService,
  ) {}

  // ─── 3.4 Discovery ─────────────────────────────────────────────────────────

  async discover(viewerId: string, query: DiscoveryDto) {
    // Reciprocity gate first: a member with no visible profile gets 403 and the
    // client renders the set-up-first card.
    const own = await this.profiles.requireOwn(viewerId);
    const blockedIds = await this.blocking.blockedUserIds(viewerId);
    const viewerProfile = await this.database.userProfile.findUnique({
      where: { userId: viewerId },
      select: { cityId: true, countryOfOrigin: true, journeyStage: true },
    });

    const where = await this.buildWhere(viewerId, query, blockedIds, viewerProfile?.cityId ?? null);

    const [total, rows] = await this.database.$transaction([
      this.database.connectProfile.count({ where }),
      this.database.connectProfile.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              username: true,
              profileImageUrl: true,
              isAnonymised: true,
              profile: {
                select: {
                  city: { select: { id: true, name: true, region: true } },
                  dateOfBirth: true,
                  interests: true,
                  languages: true,
                  heritageTag: true,
                  journeyStage: true,
                  countryOfOrigin: true,
                },
              },
              trustChecks: { where: { status: 'VERIFIED' }, select: { check: true } },
              professionalListing: { select: { id: true } },
            },
          },
          city: { select: { id: true, name: true, region: true } },
        },
        orderBy: this.orderFor(query.sort),
        skip: query.skip,
        take: query.take,
      }),
    ]);

    // Age is derived, so it cannot be filtered in SQL without duplicating the
    // date of birth as a number — which is exactly what 3.1.2 forbids. It is
    // applied here instead, and the page is padded from a wider window.
    const minAge = Math.max(query.minAge ?? CONNECT_MINIMUM_AGE, CONNECT_MINIMUM_AGE);
    const withinAge = rows.filter(row => {
      const age = ageFromDateOfBirth(row.user.profile?.dateOfBirth ?? null);

      if (age === null || age < minAge) return false;

      return query.maxAge === undefined || age <= query.maxAge;
    });

    const [views, sharedContexts, conversationIds, connections] = await Promise.all([
      Promise.all(withinAge.map(row => this.profiles.toView(row))),
      this.sharedContexts(viewerId, withinAge.map(row => row.userId), viewerProfile),
      this.conversationIds(viewerId, withinAge.map(row => row.userId)),
      this.connectedUserIds(own.id),
    ]);

    const facets = await this.facets(where);

    return {
      data: views.map((view, index) => {
        const row = withinAge[index];
        const isConnected = connections.has(row.userId);

        return {
          ...view,
          // The card's single action depends on this: Message, or Send request.
          viewer: {
            canMessageDirectly: row.dmPolicy === 'OPEN' || isConnected,
            conversationId: conversationIds.get(row.userId) ?? null,
          },
          sharedContext: sharedContexts.get(row.userId) ?? {},
        };
      }),
      meta: buildPageMeta(query, total, { facets }),
    };
  }

  private async buildWhere(
    viewerId: string,
    query: DiscoveryDto,
    blockedIds: string[],
    viewerCityId: string | null,
  ): Promise<Prisma.ConnectProfileWhereInput> {
    const where: Prisma.ConnectProfileWhereInput = {
      deletedAt: null,
      // Never returned in discovery: anyone hidden, anyone blocked in either
      // direction, and the caller themselves (3.4).
      isVisible: true,
      userId: { not: viewerId, ...(blockedIds.length ? { notIn: blockedIds } : {}) },
      user: { isAnonymised: false },
    };

    if (query.type) where.typeCode = query.type;

    const cityId = query.cityId ?? viewerCityId;

    if (cityId && cityId !== 'ANYWHERE') {
      // The override is where they want to be found, so it wins when set.
      where.OR = [{ cityIdOverride: cityId }, { cityIdOverride: null, user: { profile: { cityId } } }];
    }

    const userFilters: Prisma.UserWhereInput = { isAnonymised: false };
    const profileFilters: Prisma.UserProfileWhereInput = {};

    if (query.languages?.length) {
      const known = await this.taxonomy.knownCodes(TaxonomyKind.LANGUAGE, query.languages);

      // Matches if the profile speaks ANY of them. `languages` is a JSON array, so
      // this is an array-contains rather than an IN.
      if (known.length) {
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : []),
          {
            OR: known.map(code => ({
              user: { profile: { languages: { array_contains: [code] } } },
            })),
          },
        ];
      }
    }

    if (query.heritage?.length) {
      const known = await this.taxonomy.knownCodes(TaxonomyKind.HERITAGE_TAG, query.heritage);

      profileFilters.heritageTag = { in: known.length ? known : ['__NONE__'] };
    }

    if (query.newToUk) {
      // Defined once here from the taxonomy's own flag, so the chip and the query
      // cannot drift (3.4).
      const stages = await this.taxonomy.list(TaxonomyKind.JOURNEY_STAGE, false);
      const newStages = stages
        .filter(stage => stage.metadata?.isNewToUk === true)
        .map(stage => stage.code);

      profileFilters.journeyStage = { in: newStages.length ? newStages : ['__NONE__'] };
    }

    if (Object.keys(profileFilters).length) {
      userFilters.profile = profileFilters;
    }

    if (query.verifiedOnly) {
      userFilters.trustChecks = {
        some: { check: TrustCheckType.IDENTITY, status: 'VERIFIED' },
      };
    }

    where.user = { ...(where.user as Prisma.UserWhereInput), ...userFilters };

    return where;
  }

  private orderFor(sort: DiscoveryDto['sort']): Prisma.ConnectProfileOrderByWithRelationInput[] {
    switch (sort) {
      case 'RECENT':
        return [{ createdAt: 'desc' }];
      case 'NEAREST':
        // Without coordinates on a Connect profile, "nearest" is the city match
        // the where clause already applied, then recency. Better than pretending
        // to a precision we do not have (D25).
        return [{ lastActiveAt: 'desc' }];
      default:
        return [{ lastActiveAt: 'desc' }, { createdAt: 'desc' }];
    }
  }

  /**
   * The language filter must come from the data, not the catalogue: the client
   * builds it from the languages people in the grid actually speak, so a filter
   * can never guarantee an empty result (3.4).
   */
  private async facets(where: Prisma.ConnectProfileWhereInput) {
    const rows = await this.database.connectProfile.findMany({
      where,
      select: {
        user: { select: { profile: { select: { languages: true, heritageTag: true } } } },
      },
      take: 500,
    });

    const languages = new Set<string>();
    const heritage = new Set<string>();

    for (const row of rows) {
      for (const code of (row.user.profile?.languages as string[] | null) ?? []) {
        languages.add(code);
      }

      if (row.user.profile?.heritageTag) heritage.add(row.user.profile.heritageTag);
    }

    return { languages: [...languages].sort(), heritage: [...heritage].sort() };
  }

  // ─── 3.2.3 Another member's profile ────────────────────────────────────────

  async findOne(viewerId: string, idOrUserId: string) {
    await this.profiles.requireOwn(viewerId);

    const profile = await this.profiles.findByIdOrUserId(idOrUserId);

    // 404 when the profile is hidden, deleted, or the viewer is blocked by them —
    // and the three cases are deliberately indistinguishable. Telling someone
    // they have been blocked is itself a safety problem (3.2.3).
    if (!profile || !profile.isVisible) {
      throw ApiException.notFound('That profile could not be found.');
    }

    const isBlocked = await this.blocking.isBlockedEitherWay(viewerId, profile.userId);

    if (isBlocked) throw ApiException.notFound('That profile could not be found.');

    const viewerProfile = await this.database.userProfile.findUnique({
      where: { userId: viewerId },
      select: { cityId: true, countryOfOrigin: true, journeyStage: true },
    });

    const [view, shared, conversationId, requestState] = await Promise.all([
      this.profiles.toView(profile),
      this.sharedContexts(viewerId, [profile.userId], viewerProfile),
      this.conversationIds(viewerId, [profile.userId]),
      this.requestStateBetween(viewerId, profile.userId),
    ]);

    return {
      ...view,
      sharedContext: shared.get(profile.userId) ?? {},
      viewer: {
        // True when the subject's policy is OPEN or a connection already exists.
        canMessageDirectly: profile.dmPolicy === 'OPEN' || requestState === 'CONNECTED',
        // Stops the client offering a request that already exists.
        requestState,
        conversationId: conversationId.get(profile.userId) ?? null,
        isBlocked: false,
      },
      reportToken: profile.reportToken,
    };
  }

  /**
   * The strip that reads "Both from Nigeria · Both settling in · 2 mutual
   * groups". Computed per viewer at read time and never stored, because every
   * part of it already exists elsewhere (3.1.6).
   *
   * A key with no match is omitted rather than sent as null, so the client joins
   * whatever is present with a separator.
   */
  private async sharedContexts(
    viewerId: string,
    userIds: string[],
    viewer: { countryOfOrigin: string | null; journeyStage: string | null } | null,
  ): Promise<Map<string, SharedContext>> {
    const result = new Map<string, SharedContext>();

    if (!userIds.length || !viewer) return result;

    const [profiles, viewerGroups, countryLabels, stageLabels] = await Promise.all([
      this.database.userProfile.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, countryOfOrigin: true, journeyStage: true },
      }),
      this.database.groupMembership.findMany({
        where: { userId: viewerId, state: { in: ['MEMBER', 'ADMIN'] } },
        select: { groupId: true },
      }),
      this.taxonomy.labels(TaxonomyKind.COUNTRY_OF_ORIGIN),
      this.taxonomy.labels(TaxonomyKind.JOURNEY_STAGE),
    ]);

    const viewerGroupIds = viewerGroups.map(row => row.groupId);
    const mutualCounts = new Map<string, number>();

    if (viewerGroupIds.length) {
      const shared = await this.database.groupMembership.groupBy({
        by: ['userId'],
        where: {
          userId: { in: userIds },
          groupId: { in: viewerGroupIds },
          state: { in: ['MEMBER', 'ADMIN'] },
        },
        _count: { _all: true },
      });

      for (const row of shared) mutualCounts.set(row.userId, row._count._all);
    }

    for (const profile of profiles) {
      const context: SharedContext = {};

      if (viewer.countryOfOrigin && profile.countryOfOrigin === viewer.countryOfOrigin) {
        context.sameCountry = countryLabels.get(profile.countryOfOrigin) ?? profile.countryOfOrigin;
      }

      if (viewer.journeyStage && profile.journeyStage === viewer.journeyStage) {
        context.sameJourneyStage = stageLabels.get(profile.journeyStage) ?? profile.journeyStage;
      }

      const mutual = mutualCounts.get(profile.userId) ?? 0;

      if (mutual > 0) context.mutualGroupCount = mutual;

      result.set(profile.userId, context);
    }

    return result;
  }

  private async conversationIds(viewerId: string, userIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    if (!userIds.length) return result;

    const conversations = await this.database.conversation.findMany({
      where: {
        contextType: ThreadContextType.CONNECT_PROFILE,
        participants: { some: { userId: viewerId } },
      },
      select: { id: true, participants: { select: { userId: true } } },
    });

    for (const conversation of conversations) {
      const other = conversation.participants.find(p => p.userId !== viewerId);

      if (other && userIds.includes(other.userId)) result.set(other.userId, conversation.id);
    }

    return result;
  }

  private async connectedUserIds(profileId: string): Promise<Set<string>> {
    const accepted = await this.database.connectionRequest.findMany({
      where: {
        state: 'ACCEPTED',
        OR: [{ fromProfileId: profileId }, { toProfileId: profileId }],
      },
      select: { fromUserId: true, toUserId: true, fromProfileId: true },
    });

    return new Set(
      accepted.map(row => (row.fromProfileId === profileId ? row.toUserId : row.fromUserId)),
    );
  }

  private async requestStateBetween(
    viewerId: string,
    otherUserId: string,
  ): Promise<'NONE' | 'SENT_PENDING' | 'RECEIVED_PENDING' | 'CONNECTED' | 'DECLINED'> {
    const request = await this.database.connectionRequest.findFirst({
      where: {
        OR: [
          { fromUserId: viewerId, toUserId: otherUserId },
          { fromUserId: otherUserId, toUserId: viewerId },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!request) return 'NONE';
    if (request.state === 'ACCEPTED') return 'CONNECTED';
    if (request.state === 'DECLINED') return 'DECLINED';
    if (request.state === 'PENDING') {
      return request.fromUserId === viewerId ? 'SENT_PENDING' : 'RECEIVED_PENDING';
    }

    return 'NONE';
  }
}
