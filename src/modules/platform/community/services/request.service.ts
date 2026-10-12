import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  ActivityVerb,
  CommunityRequest,
  ContentScanTrigger,
  Media,
  NotificationKind,
  PostVisibility,
  Prisma,
  ReportTargetType,
  RequestStatus,
  SearchScope,
  TaxonomyKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  ApiErrorCode,
  ApiException,
  buildPageMeta,
  escapeLike,
  excerpt,
  Paginated,
} from '@/common';
import {
  ActivityService,
  BlockingService,
  AuthorReviewView,
  CityService,
  ContentReviewService,
  ContentSafetyService,
  MediaService,
  PUBLIC_VISIBILITY,
  RiskScannerService,
  TaxonomyService,
  authorSelect,
  isReachable,
  withoutAllCategories,
  DIRECT_VISIBILITY,
} from '../../shared';
import { NotificationFeedService } from '../../notifications';
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
    private readonly notifications: NotificationFeedService,
    private readonly safety: ContentSafetyService,
    private readonly review: ContentReviewService,
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

    this.recordSearch(viewerId, query, total);

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
      ...PUBLIC_VISIBILITY,
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

    // Nobody has replied yet, which is what the Pulse action row counts. Read off the maintained
    // column rather than counting responses per row, and left alone when absent so every existing
    // caller sees exactly what it saw before.
    if (query.unanswered) {
      where.replyCount = 0;
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

    const categories = withoutAllCategories(query.categories ?? []);

    if (categories.length) {
      const known = await this.taxonomy.knownCodes(
        TaxonomyKind.COMMUNITY_CATEGORY,
        categories,
        'GET /community/requests',
      );

      // An unknown code must narrow to nothing rather than being ignored: quietly returning everything would look like the filter did not apply.
      where.categoryCode = { in: known.length ? known : ['__NONE__'] };
    }

    if (query.authorId) {
      where.authorId = query.authorId;
    }

    if (query.q) {
      // `%` and `_` are ILIKE wildcards; unescaped, `%` matches the whole table (0.5).
      const q = escapeLike(query.q);

      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
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

  async findOne(
    viewerId: string,
    id: string,
  ): Promise<RequestDetailView & Partial<AuthorReviewView>> {
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

    // Held, rejected and awaiting-approval content is nobody's to read but its author's (§6.5),
    // and the answer is a 404 rather than a 403: "this exists and you may not see it" tells a
    // reporter that their report landed, and tells anybody else that something was here.
    if (!isReachable(request.visibilityState) && request.authorId !== viewerId) {
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

    // §6.5: the author of held content is told that it is held, and at the critical tier is
    // offered the crisis lines rather than a policy notice. Everybody else got a 404 above.
    const review =
      request.authorId === viewerId
        ? await this.review.forAuthor(ReportTargetType.REQUEST, id, request.visibilityState)
        : null;

    return { ...toRequestDetail(request, context, resolution), ...(review ?? {}) };
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

      // Inside the transaction, so a post the lexicon holds is never briefly readable (§6.7).
      await this.safety.assess(tx, {
        targetType: ReportTargetType.REQUEST,
        targetId: request.id,
        authorId: request.authorId,
        fields: { title: request.title, description: request.description },
        mediaKeys: media.map(item => item.storageKey),
        isAnonymous: request.visibility === PostVisibility.ANONYMOUS,
        trigger: ContentScanTrigger.CREATE,
        summary: request.title,
      });

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
    // The keys that will be attached once this edit lands — the patched set, or the set already
    // there. The content hash covers media, so handing it an empty list for an edit that did not
    // touch the photos would make every edit look like new content and re-queue it (§6.2).
    const mediaKeys = (media ?? (await this.media.forOwner(REQUEST_MEDIA_OWNER, id))).map(
      item => item.storageKey,
    );

    await this.database.$transaction(async tx => {
      const patched = await tx.communityRequest.update({
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

      // Edits are scanned too (§6.1). The hash decides whether anything actually changed, so a
      // patch that only moves a date is not a second trip through the queue.
      await this.safety.assess(tx, {
        targetType: ReportTargetType.REQUEST,
        targetId: id,
        authorId: patched.authorId,
        fields: { title: patched.title, description: patched.description },
        mediaKeys,
        isAnonymous: patched.visibility === PostVisibility.ANONYMOUS,
        trigger: ContentScanTrigger.EDIT,
        summary: patched.title,
      });
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
      // visibility: an eligibility check — did these people actually reply? — not a read of their
      // words. Somebody whose reply was held still replied, and refusing to credit them for it
      // would be a second penalty decided by a scanner.
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

    if (helperIds.length) {
      // Being credited is the whole reward for answering a stranger's question, and it showed up
      // nowhere: the helper had to revisit the request to find out it had been resolved at all.
      // A request posted anonymously stays anonymous when its author thanks somebody. Naming them
      // here handed the helper the identity the whole post was written to withhold, and the actor
      // object carried their id with it.
      const isAnonymous = request.visibility === PostVisibility.ANONYMOUS;
      const actor = isAnonymous ? 'Someone' : await this.notifications.actorName(userId);

      for (const helperUserId of helperIds) {
        this.notifications.raise({
          userId: helperUserId,
          actorId: userId,
          isActorAnonymous: isAnonymous,
          kind: NotificationKind.HELP_OFFER,
          categoryCode: 'OFFERS',
          title: `${actor} credited you for helping`,
          body: excerpt(request.title, 80),
          route: `/community/request/${id}`,
          target: { type: 'REQUEST', id },
          metadata: { requestId: id },
        });
      }
    }

    await this.tellTheRestItIsOver(
      id,
      userId,
      request.title,
      helperIds,
      dto.outcome,
      request.visibility === PostVisibility.ANONYMOUS,
    );

    return this.findOne(userId, id);
  }

  /**
   * One notification, at resolution, to each person who offered and was not credited. Without it
   * their offer simply goes quiet, which is the one real problem an accept/decline flow solves.
   */
  private async tellTheRestItIsOver(
    requestId: string,
    ownerId: string,
    title: string,
    creditedIds: string[],
    outcome: string | undefined,
    isAnonymous: boolean,
  ): Promise<void> {
    // Nothing was needed and nobody was thanked: there is no news here worth a notification.
    if (outcome === 'NO_LONGER_NEEDED' && !creditedIds.length) return;

    const credited = new Set([...creditedIds, ownerId]);
    // visibility: who to tell that the request they offered to help with is resolved. The content
    // referenced by the notification is the request, not the reply, so a held reply does not take
    // away its author's interest in the outcome.
    const offers = await this.database.requestResponse.findMany({
      where: { requestId, isHelpOffer: true, deletedAt: null },
      select: { authorId: true },
      distinct: ['authorId'],
    });

    for (const offer of offers) {
      if (credited.has(offer.authorId)) continue;

      this.notifications.raise({
        userId: offer.authorId,
        actorId: ownerId,
        // The title names nobody, but the actor object would have.
        isActorAnonymous: isAnonymous,
        kind: NotificationKind.HELP_OFFER,
        categoryCode: 'OFFERS',
        title: 'A request you offered to help with has been resolved',
        body: excerpt(title, 80),
        route: `/community/request/${requestId}`,
        target: { type: 'REQUEST', id: requestId },
        metadata: { requestId },
      });
    }
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
      // visibility: the viewer's own replies. Hiding one from the person who wrote it would make
      // the bar offer to reply again.
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
        // The owner's count of private replies has to match the replies they can open, so it
        // follows the same rule the reply list does (§6.5).
        const privateCounts = await this.database.requestResponse.groupBy({
          by: ['requestId'],
          where: {
            requestId: { in: ownIds },
            isPrivate: true,
            deletedAt: null,
            ...DIRECT_VISIBILITY,
          },
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
    // visibility: loaded to check who owns it before a write. An author must be able to edit or
    // delete their own held post — that is the one thing they can still usefully do with it.
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

    // The scan, the verdict and the queue item are `ContentSafetyService`'s (§6.2). This hook used
    // to carry its own copy of them, which is what that service replaces: the version here scanned
    // a title and a description, the one in `update.service.ts` scanned a body, and neither wrote
    // down what it found.
  }

  /**
   * What somebody typed, for the published demand lists (6.3). Counted, never attributed, and
   * recorded with whether it found anything — which cannot be worked out later, because the
   * catalogue has moved on by the time the job runs.
   */
  private recordSearch(
    viewerId: string | null,
    query: { q?: string; cityId?: string; categories?: string[] },
    total: number,
  ): void {
    if (!query.q) return;

    this.activity.recordSearch({
      userId: viewerId,
      scope: SearchScope.REQUESTS,
      term: query.q,
      cityId: query.cityId ?? null,
      code: query.categories?.[0] ?? null,
      hadResults: total > 0,
    });
  }
}
