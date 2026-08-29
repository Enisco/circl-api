import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  ActivityVerb,
  CommunityRequest,
  Media,
  ModerationQueueType,
  PostVisibility,
  Prisma,
  ReportTargetType,
  RequestStatus,
  TaxonomyKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, buildPageMeta, Paginated, toJson } from '@/common';
import {
  ActivityService,
  BlockingService,
  CityService,
  MediaService,
  RiskScannerService,
  TaxonomyService,
  authorSelect,
} from '../../shared';
import {
  CreateRequestDto,
  ListRequestsDto,
  ResolveRequestDto,
  UpdateRequestDto,
} from '../dtos/request.dto';
import {
  RequestDetailView,
  RequestRow,
  RequestSummaryView,
  RequestViewContext,
  toRequestDetail,
  toRequestSummary,
} from '../serializers/request.serializer';

export const REQUEST_MEDIA_OWNER = 'COMMUNITY_REQUEST';

const requestInclude = {
  author: { select: authorSelect },
  city: { select: { id: true, name: true, region: true } },
} satisfies Prisma.CommunityRequestInclude;

@Injectable()
export class RequestService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly cities: CityService,
    private readonly media: MediaService,
    private readonly blocking: BlockingService,
    private readonly activity: ActivityService,
    private readonly risk: RiskScannerService,
  ) {}

  // ─── 1.2.1 List ────────────────────────────────────────────────────────────

  async list(viewerId: string, query: ListRequestsDto): Promise<Paginated<RequestSummaryView>> {
    const viewerCityId = await this.viewerCityId(viewerId);
    const blockedIds = await this.blocking.blockedUserIds(viewerId);

    const where = await this.buildListWhere(query, viewerCityId, blockedIds);

    const [total, rows] = await this.database.$transaction([
      this.database.communityRequest.count({ where }),
      this.database.communityRequest.findMany({
        where,
        include: requestInclude,
        orderBy: this.orderFor(query.sort),
        skip: query.skip,
        take: query.take,
      }),
    ]);

    const context = await this.buildContext(rows, viewerId, viewerCityId, blockedIds);

    return {
      data: rows.map(row => toRequestSummary(row, context)),
      meta: buildPageMeta(query, total),
    };
  }

  private async buildListWhere(
    query: ListRequestsDto,
    viewerCityId: string | null,
    blockedIds: string[],
  ): Promise<Prisma.CommunityRequestWhereInput> {
    const where: Prisma.CommunityRequestWhereInput = {
      deletedAt: null,
      // A private-to-Circl request is not a post. It never appears in any list.
      visibility: { not: PostVisibility.PRIVATE_TO_CIRCL },
    };

    // Status.
    if (query.status && query.status !== 'ALL') {
      where.status =
        query.status === RequestStatus.CLOSED
          ? { in: [RequestStatus.RESOLVED, RequestStatus.CLOSED, RequestStatus.EXPIRED] }
          : query.status;
    } else if (!query.status) {
      where.status = RequestStatus.OPEN;
    }

    // City.
    if (query.nearYou) {
      if (viewerCityId) where.cityId = viewerCityId;
    } else {
      const city = await this.cities.resolve(query.cityId, query.city);

      if (city) {
        where.cityId = city.id;
      } else if (query.cityId !== 'ANYWHERE' && !query.cityId && !query.city && viewerCityId) {
        where.cityId = viewerCityId;
      }
    }

    if (query.categories?.length) {
      const known = await this.taxonomy.knownCodes(
        TaxonomyKind.COMMUNITY_CATEGORY,
        query.categories,
      );

      // An unknown code must narrow to nothing rather than being ignored: quietly returning everything would look like the filter did not apply.
      where.categoryCode = { in: known.length ? known : ['__NONE__'] };
    }

    if (query.authorId) {
      where.authorId = query.authorId;
    }

    if (query.q) {
      where.OR = [
        { title: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    // Blocking is symmetric in effect (1.8.2), and it wins over an explicit authorId filter: asking for a blocked member's requests by id must not be a way around the block.
    if (blockedIds.length) {
      where.AND = [{ authorId: { notIn: blockedIds } }];
    }

    return where;
  }

  private orderFor(
    sort: ListRequestsDto['sort'],
  ): Prisma.CommunityRequestOrderByWithRelationInput[] {
    switch (sort) {
      case 'MOST_HELPERS':
        return [{ helperCount: 'desc' }, { createdAt: 'desc' }];
      case 'NEEDED_SOONEST':
        // Nulls last: a request with no date is not more urgent than one due tomorrow, which is what a naive ascending sort would claim.
        return [{ neededOn: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }];
      default:
        return [{ createdAt: 'desc' }];
    }
  }

  // ─── 1.2.2 Detail ──────────────────────────────────────────────────────────

  async findOne(viewerId: string, id: string): Promise<RequestDetailView> {
    const request = await this.database.communityRequest.findUnique({
      where: { id },
      include: requestInclude,
    });

    if (!request) throw ApiException.notFound('This request could not be found.');
    if (request.deletedAt) throw ApiException.deleted('This request');

    // A private-to-Circl thread is not a post and is not readable here even by its author — it lives in Guard.
    if (request.visibility === PostVisibility.PRIVATE_TO_CIRCL && request.authorId !== viewerId) {
      throw ApiException.notFound('This request could not be found.');
    }

    // Counted on GET, deduplicated per user per resource per 24 hours (0.13).
    if (await this.activity.countView('request', id, viewerId, request.authorId)) {
      await this.database.communityRequest.update({
        where: { id },
        data: { viewCount: { increment: 1 } },
      });
      request.viewCount += 1;
    }

    this.activity.record({
      userId: viewerId,
      verb: ActivityVerb.VIEW,
      subject: ActivitySubject.REQUEST,
      subjectId: id,
      cityId: request.cityId,
      code: request.categoryCode,
    });

    const viewerCityId = await this.viewerCityId(viewerId);
    const blockedIds = await this.blocking.blockedUserIds(viewerId);
    const context = await this.buildContext([request], viewerId, viewerCityId, blockedIds);

    const resolution =
      request.status === RequestStatus.RESOLVED && request.resolvedAt
        ? {
            resolvedAt: request.resolvedAt,
            helpers: (
              await this.database.requestHelper.findMany({
                where: { requestId: id },
                include: { user: { select: authorSelect } },
              })
            ).map(helper => helper.user),
          }
        : null;

    return toRequestDetail(request, context, resolution);
  }

  // ─── 1.2.3 Create ──────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateRequestDto): Promise<RequestDetailView> {
    // Routing, not validation: the member chose a private channel and must not find their question in the feed (1.9).
    if (dto.visibility === PostVisibility.PRIVATE_TO_CIRCL) {
      throw ApiException.unprocessable(
        ApiErrorCode.USE_PRIVATE_ENDPOINT,
        'Private requests go to the Circl team, not the community feed. Use the private composer.',
        { details: [{ field: 'visibility', message: 'Use POST /api/v1/guard/threads instead.' }] },
      );
    }

    await this.taxonomy.assertValid(
      TaxonomyKind.COMMUNITY_CATEGORY,
      dto.categoryCode,
      'categoryCode',
    );
    // The resolved id, not the value that arrived: 1.0.3 lets a picked name in, and writing "Manchester" into the foreign key would fail on insert.
    const city = await this.cities.assertValid(dto.cityId);

    const neededOn = this.parseNeededOn(dto.neededOn);
    const media = await this.media.validate(dto.mediaKeys, userId);

    const created = await this.database.$transaction(async tx => {
      const request = await tx.communityRequest.create({
        data: {
          authorId: userId,
          categoryCode: dto.categoryCode,
          title: dto.title,
          description: dto.description ?? null,
          cityId: city.id,
          neededOn,
          thankYouAmount: dto.thankYouAmount ?? null,
          visibility: dto.visibility ?? PostVisibility.PUBLIC,
        },
        include: requestInclude,
      });

      await this.media.attach(tx, media, REQUEST_MEDIA_OWNER, request.id);

      return request;
    });

    await this.afterWrite(created, media);

    return this.findOne(userId, created.id);
  }

  // ─── 1.2.4 Patch ───────────────────────────────────────────────────────────

  async update(userId: string, id: string, dto: UpdateRequestDto): Promise<RequestDetailView> {
    const request = await this.load(id);

    this.assertOwner(request, userId);

    // Only while OPEN.
    if (request.status !== RequestStatus.OPEN) {
      throw ApiException.forbidden(
        ApiErrorCode.REQUEST_NOT_EDITABLE,
        'This request has been closed and can no longer be edited.',
      );
    }

    if (dto.categoryCode) {
      await this.taxonomy.assertValid(
        TaxonomyKind.COMMUNITY_CATEGORY,
        dto.categoryCode,
        'categoryCode',
      );
    }

    const patchCity = dto.cityId ? await this.cities.assertValid(dto.cityId) : null;

    const media = dto.mediaKeys ? await this.media.validate(dto.mediaKeys, userId) : null;

    await this.database.$transaction(async tx => {
      await tx.communityRequest.update({
        where: { id },
        data: {
          categoryCode: dto.categoryCode,
          title: dto.title,
          description: dto.description,
          cityId: patchCity?.id,
          neededOn: dto.neededOn === undefined ? undefined : this.parseNeededOn(dto.neededOn),
          thankYouAmount: dto.thankYouAmount,
        },
      });

      if (media) {
        await this.media.releaseOwner(tx, REQUEST_MEDIA_OWNER, id);
        await this.media.attach(tx, media, REQUEST_MEDIA_OWNER, id);
      }
    });

    return this.findOne(userId, id);
  }

  // ─── 1.2.5 Resolve ─────────────────────────────────────────────────────────

  /** The owner marks a request resolved and credits the people who helped. */
  async resolve(userId: string, id: string, dto: ResolveRequestDto): Promise<RequestDetailView> {
    const request = await this.load(id);

    this.assertOwner(request, userId);

    if (request.status !== RequestStatus.OPEN) {
      throw ApiException.conflict(
        ApiErrorCode.REQUEST_ALREADY_RESOLVED,
        'This request has already been resolved.',
        { data: { status: request.status, resolvedAt: request.resolvedAt } },
      );
    }

    const helperIds = [...new Set(dto.helperUserIds ?? [])];

    if (helperIds.length) {
      const responders = await this.database.requestResponse.findMany({
        where: { requestId: id, authorId: { in: helperIds }, deletedAt: null },
        select: { authorId: true },
        distinct: ['authorId'],
      });
      const responderIds = new Set(responders.map(row => row.authorId));
      const strangers = helperIds.filter(helperId => !responderIds.has(helperId));

      if (strangers.length) {
        throw ApiException.unprocessable(
          ApiErrorCode.NOT_A_RESPONDER,
          'You can only credit people who replied to this request.',
          {
            details: strangers.map(strangerId => ({
              field: 'helperUserIds',
              message: `${strangerId} did not respond to this request.`,
            })),
          },
        );
      }
    }

    await this.database.$transaction(async tx => {
      await tx.communityRequest.update({
        where: { id },
        data: {
          status: RequestStatus.RESOLVED,
          outcome: dto.outcome ?? 'HELPED',
          resolvedAt: new Date(),
        },
      });

      if (helperIds.length) {
        await tx.requestHelper.createMany({
          data: helperIds.map(helperUserId => ({ requestId: id, userId: helperUserId })),
          skipDuplicates: true,
        });
      }
    });

    return this.findOne(userId, id);
  }

  // ─── 1.2.6 Delete ──────────────────────────────────────────────────────────

  /** Soft delete, so a subsequent GET can return a tombstone rather than a gap. */
  async remove(userId: string, id: string): Promise<void> {
    const request = await this.load(id);

    this.assertOwner(request, userId);

    await this.database.communityRequest.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Everything a page of rows needs that cannot come from the row itself, in a fixed number of queries regardless of page size. */
  private async buildContext(
    rows: RequestRow[],
    viewerId: string | null,
    viewerCityId: string | null,
    blockedIds: string[],
  ): Promise<RequestViewContext> {
    const ids = rows.map(row => row.id);
    const [categoryLabels, media] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.COMMUNITY_CATEGORY),
      this.media.forOwners(REQUEST_MEDIA_OWNER, ids),
    ]);

    const context: RequestViewContext = {
      viewerId,
      viewerCityId,
      categoryLabels,
      media,
      sign: this.media.sign,
      blockedAuthorIds: new Set(blockedIds),
    };

    if (viewerId && ids.length) {
      // viewer.hasOffered drives whether the sticky bar reads "I can help" or "Just replying".
      const responses = await this.database.requestResponse.findMany({
        where: { requestId: { in: ids }, authorId: viewerId, deletedAt: null },
        select: { requestId: true, isHelpOffer: true },
      });

      context.hasOffered = new Set(
        responses.filter(row => row.isHelpOffer).map(row => row.requestId),
      );
      context.hasReplied = new Set(responses.map(row => row.requestId));

      const ownIds = rows.filter(row => row.authorId === viewerId).map(row => row.id);

      if (ownIds.length) {
        const privateCounts = await this.database.requestResponse.groupBy({
          by: ['requestId'],
          where: { requestId: { in: ownIds }, isPrivate: true, deletedAt: null },
          _count: { _all: true },
        });

        context.privateReplyCounts = new Map(
          privateCounts.map(row => [row.requestId, row._count._all]),
        );
      }
    }

    return context;
  }

  private async viewerCityId(viewerId: string | null): Promise<string | null> {
    if (!viewerId) return null;

    const profile = await this.database.userProfile.findUnique({
      where: { userId: viewerId },
      select: { cityId: true },
    });

    return profile?.cityId ?? null;
  }

  private async load(id: string): Promise<CommunityRequest> {
    const request = await this.database.communityRequest.findUnique({ where: { id } });

    if (!request) throw ApiException.notFound('This request could not be found.');
    if (request.deletedAt) throw ApiException.deleted('This request');

    return request;
  }

  private assertOwner(request: CommunityRequest, userId: string): void {
    if (request.authorId !== userId) {
      // 403, never 401: a 401 on a permissions problem silently logs the user out (0.2).
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'Only the person who posted this request can change it.',
      );
    }
  }

  private parseNeededOn(value: string | undefined): Date | null {
    if (!value) return null;

    const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
    const today = new Date();

    today.setUTCHours(0, 0, 0, 0);

    if (Number.isNaN(date.getTime())) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'neededOn must be a valid date.',
        { details: [{ field: 'neededOn', message: 'Must be a valid date.' }] },
      );
    }

    if (date < today) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'The date you need help by cannot be in the past.',
        { details: [{ field: 'neededOn', message: 'Cannot be in the past.' }] },
      );
    }

    return date;
  }

  /** Runs Guard's scanner and records the Intelligence signal after a create. */
  private async afterWrite(request: RequestRow, media: Media[]): Promise<void> {
    void media;

    this.activity.record({
      userId: request.authorId,
      verb: ActivityVerb.CREATE,
      subject: ActivitySubject.REQUEST,
      subjectId: request.id,
      cityId: request.cityId,
      code: request.categoryCode,
      term: request.title,
      weight: 3,
    });

    const assessment = await this.risk.scan(request.title, request.description);
    const isAnonymous = request.visibility === PostVisibility.ANONYMOUS;

    if (!this.risk.isUrgent(assessment) && !isAnonymous) return;

    await this.database.moderationQueueItem
      .upsert({
        where: {
          type_targetType_targetId: {
            type: isAnonymous ? ModerationQueueType.ANONYMOUS_POST : ModerationQueueType.GUARD_RISK,
            targetType: ReportTargetType.REQUEST,
            targetId: request.id,
          },
        },
        update: {},
        create: {
          type: isAnonymous ? ModerationQueueType.ANONYMOUS_POST : ModerationQueueType.GUARD_RISK,
          targetType: ReportTargetType.REQUEST,
          targetId: request.id,
          subjectUserId: request.authorId,
          riskLevel: assessment.level,
          riskCategory: assessment.category,
          riskScore: assessment.score,
          riskSignals: toJson(assessment.signals),
          summary: request.title,
        },
      })
      .catch(() => undefined);
  }
}
