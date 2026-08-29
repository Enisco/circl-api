import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  ActivityVerb,
  NotificationKind,
  Prisma,
  RequestStatus,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  ApiErrorCode,
  ApiException,
  buildPageMeta,
  excerpt,
  money,
  Paginated,
  toDateOnly,
} from '@/common';
import {
  ActivityService,
  AuthorView,
  MediaService,
  authorSelect,
  toAuthorView,
} from '../../shared';
import { NotificationFeedService } from '../../notifications';
import { CreateResponseDto, ListResponsesDto } from '../dtos/response.dto';

export interface ResponseView {
  id: string;
  content: string;
  isHelpOffer: boolean;
  isPrivate: boolean;
  availableOn: string | null;
  thankYouExpected: { amount: number; currency: string } | null;
  author: AuthorView;
  viewer: { isOwner: boolean; canDelete: boolean };
  createdAt: string;
}

export interface RequestCountsView {
  views: number;
  helpers: number;
  replies: number;
}

@Injectable()
export class RequestResponseService {
  constructor(
    private readonly database: PrismaService,
    private readonly activity: ActivityService,
    private readonly media: MediaService,
    private readonly notifications: NotificationFeedService,
  ) {}

  // ─── 1.3.1 List ────────────────────────────────────────────────────────────

  async list(
    viewerId: string,
    requestId: string,
    query: ListResponsesDto,
  ): Promise<Paginated<ResponseView>> {
    const request = await this.loadRequest(requestId);
    const isRequestOwner = request.authorId === viewerId;

    // Private responses are returned only to the request's owner and their author.
    const where: Prisma.RequestResponseWhereInput = {
      requestId,
      deletedAt: null,
      ...(isRequestOwner ? {} : { OR: [{ isPrivate: false }, { authorId: viewerId }] }),
    };

    const orderBy: Prisma.RequestResponseOrderByWithRelationInput[] = isRequestOwner
      ? // The client renders the owner's private responses in a separate
        // "Private to you" block above the public ones, so sort them first.
        [{ isPrivate: 'desc' }, { createdAt: query.sort === 'NEWEST' ? 'desc' : 'asc' }]
      : [{ createdAt: query.sort === 'NEWEST' ? 'desc' : 'asc' }];

    const [total, rows] = await this.database.$transaction([
      this.database.requestResponse.count({ where }),
      this.database.requestResponse.findMany({
        where,
        include: { author: { select: authorSelect } },
        orderBy,
        skip: query.skip,
        take: query.take,
      }),
    ]);

    return {
      data: rows.map(row => this.toView(row, viewerId, isRequestOwner)),
      meta: buildPageMeta(query, total),
    };
  }

  // ─── 1.3.2 Create ──────────────────────────────────────────────────────────

  async create(
    userId: string,
    requestId: string,
    dto: CreateResponseDto,
  ): Promise<{ response: ResponseView; requestCounts: RequestCountsView }> {
    const request = await this.loadRequest(requestId);

    if (request.status !== RequestStatus.OPEN) {
      throw ApiException.forbidden(
        ApiErrorCode.REQUEST_CLOSED,
        'This request is closed, so it is no longer taking replies.',
      );
    }

    const isHelpOffer = dto.isHelpOffer ?? false;

    // The owner may reply to their own request, but cannot offer to help on it.
    if (isHelpOffer && request.authorId === userId) {
      throw ApiException.unprocessable(
        ApiErrorCode.CANNOT_OFFER_ON_OWN_REQUEST,
        'You cannot offer to help on your own request.',
        { details: [{ field: 'isHelpOffer', message: 'Not valid on your own request.' }] },
      );
    }

    if (isHelpOffer) {
      // A user may post multiple replies, but only one may be a help offer.
      const existing = await this.database.requestResponse.findFirst({
        where: { requestId, authorId: userId, isHelpOffer: true, deletedAt: null },
        select: { id: true },
      });

      if (existing) {
        throw ApiException.conflict(
          ApiErrorCode.ALREADY_OFFERED,
          'You have already offered to help with this request.',
          { data: { responseId: existing.id } },
        );
      }
    }

    const created = await this.database.$transaction(async tx => {
      const response = await tx.requestResponse.create({
        data: {
          requestId,
          authorId: userId,
          content: dto.content,
          isHelpOffer,
          isPrivate: dto.isPrivate ?? false,
          // Only meaningful on a help offer, so they are dropped otherwise rather than stored as noise a later reader has to interpret.
          availableOn: isHelpOffer && dto.availableOn ? new Date(dto.availableOn) : null,
          thankYouExpected: isHelpOffer ? (dto.thankYouExpected ?? null) : null,
        },
        include: { author: { select: authorSelect } },
      });

      await tx.communityRequest.update({
        where: { id: requestId },
        data: {
          replyCount: { increment: 1 },
          ...(isHelpOffer ? { helperCount: { increment: 1 } } : {}),
        },
      });

      return response;
    });

    this.activity.record({
      userId,
      verb: ActivityVerb.RESPOND,
      subject: ActivitySubject.REQUEST,
      subjectId: requestId,
      cityId: request.cityId,
      code: request.categoryCode,
      weight: isHelpOffer ? 3 : 1,
    });

    // An offer of help and a reply are different notifications with different preference rows, because a member who silences chatter on their posts may still want to know somebody offered to drive them to the airport.
    this.notifications.raise({
      userId: request.authorId,
      actorId: userId,
      kind: isHelpOffer ? NotificationKind.HELP_OFFER : NotificationKind.REPLY,
      categoryCode: isHelpOffer ? 'OFFERS' : 'REPLIES',
      title: isHelpOffer ? 'Someone offered to help' : 'New reply to your request',
      body: excerpt(request.title, 80),
      route: `/community/request/${requestId}`,
    });

    const counts = await this.counts(requestId);

    // Returned so the client does not need a refetch to update the parent card (1.3.2).
    return {
      response: this.toView(created, userId, request.authorId === userId),
      requestCounts: counts,
    };
  }

  // ─── 1.3.3 Delete ──────────────────────────────────────────────────────────

  async remove(userId: string, requestId: string, responseId: string): Promise<RequestCountsView> {
    const response = await this.database.requestResponse.findUnique({
      where: { id: responseId },
      include: { request: { select: { authorId: true } } },
    });

    if (!response || response.requestId !== requestId) {
      throw ApiException.notFound('This reply could not be found.');
    }

    if (response.deletedAt) throw ApiException.deleted('This reply');

    // Author, or the request owner, may remove it (1.3.3).
    if (response.authorId !== userId && response.request.authorId !== userId) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You cannot remove this reply.');
    }

    await this.database.$transaction(async tx => {
      await tx.requestResponse.update({
        where: { id: responseId },
        data: { deletedAt: new Date() },
      });

      await tx.communityRequest.update({
        where: { id: requestId },
        data: {
          replyCount: { decrement: 1 },
          ...(response.isHelpOffer ? { helperCount: { decrement: 1 } } : {}),
        },
      });
    });

    return this.counts(requestId);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async counts(requestId: string): Promise<RequestCountsView> {
    const request = await this.database.communityRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { viewCount: true, helperCount: true, replyCount: true },
    });

    return {
      views: request.viewCount,
      helpers: request.helperCount,
      replies: request.replyCount,
    };
  }

  private async loadRequest(requestId: string) {
    const request = await this.database.communityRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        authorId: true,
        title: true,
        status: true,
        cityId: true,
        categoryCode: true,
        deletedAt: true,
      },
    });

    if (!request) throw ApiException.notFound('This request could not be found.');
    if (request.deletedAt) throw ApiException.deleted('This request');

    return request;
  }

  private toView(
    row: Prisma.RequestResponseGetPayload<{ include: { author: { select: typeof authorSelect } } }>,
    viewerId: string,
    isRequestOwner: boolean,
  ): ResponseView {
    const isOwner = row.authorId === viewerId;

    return {
      id: row.id,
      content: row.content,
      isHelpOffer: row.isHelpOffer,
      isPrivate: row.isPrivate,
      availableOn: toDateOnly(row.availableOn),
      thankYouExpected: money(row.thankYouExpected, row.currency),
      author: toAuthorView(row.author, { sign: this.media.sign }),
      viewer: { isOwner, canDelete: isOwner || isRequestOwner },
      createdAt: row.createdAt.toISOString(),
    };
  }
}
