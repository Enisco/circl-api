import { Injectable } from '@nestjs/common';
import {
  DealStage,
  DealTrack,
  JobState,
  NotificationKind,
  Prisma,
  RequestStatus,
  Review,
  ReviewContext,
  TaxonomyKind,
  ThreadContextType,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, buildPageMeta, excerpt, toJsonOrUndefined } from '@/common';
import {
  AuthorView,
  MediaService,
  TaxonomyService,
  authorSelect,
  toAuthorView,
} from '../../shared';
import {
  CreateReviewDto,
  ListReviewsDto,
  ReviewReplyDto,
  UpdateReviewDto,
} from '../dtos/review.dto';
import { ReputationService } from './reputation.service';
import { NotificationFeedService } from '../../notifications';

/** Editable for 48 hours, then frozen (2.5.2). */
const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface ReviewView {
  id: string;
  rating: number;
  comment: string;
  context: ReviewContext;
  contextLabel: string;
  /** Sent per review rather than inferred from `context`, so the rule can change server-side without an app release (2.5.1). */
  countsToAverage: boolean;
  tags: string[];
  reviewer: AuthorView;
  subjectReply: { comment: string; createdAt: string } | null;
  viewer: { isOwner: boolean; canEdit: boolean; canReply: boolean };
  createdAt: string;
}

const CONTEXT_LABELS: Record<ReviewContext, string> = {
  COMMUNITY: 'Helped in the community',
  BOOKING: 'Booked through Circl',
  ORDER: 'Bought through Circl',
  PROFESSIONAL: 'Worked together on Circl',
  PRIOR_WORK: 'Worked together before Circl',
};

const REVIEW_CONVERSATION = { select: { contextType: true, contextSnapshot: true } } as const;

/** "5 stars, Appeal support" is worth reading. "5 stars, Immigration Adviser" is barely worth it. */
const contextLabelFor = (row: {
  context: ReviewContext;
  enquiryId?: string | null;
  conversation?: { contextType: ThreadContextType | null; contextSnapshot: unknown } | null;
}): string => {
  // A done deal reviews both ways, and "Bought through Circl" is the wrong way round on the
  // seller's copy of it. No enquiry behind an ORDER review means it hangs off a deal.
  const label =
    row.context === ReviewContext.ORDER && !row.enquiryId
      ? 'Agreed through Circl'
      : CONTEXT_LABELS[row.context];

  if (row.conversation?.contextType !== ThreadContextType.SERVICE) return label;

  const service = (row.conversation.contextSnapshot as { title?: string } | null)?.title;

  return service ? `${label} · ${service}` : label;
};

@Injectable()
export class ReviewService {
  constructor(
    private readonly database: PrismaService,
    private readonly reputation: ReputationService,
    private readonly taxonomy: TaxonomyService,
    private readonly media: MediaService,
    private readonly notifications: NotificationFeedService,
  ) {}

  // ─── 2.5.1 List ────────────────────────────────────────────────────────────

  /** The reputation block on a professional profile, the standalone Reviews screen, and the community profile all read this one endpoint — which is the "reviews travel with the user" promise made literal. */
  async listForUser(viewerId: string | null, subjectUserId: string, query: ListReviewsDto) {
    const where: Prisma.ReviewWhereInput = {
      subjectUserId,
      deletedAt: null,
      ...(query.context && query.context !== 'ALL' ? { context: query.context } : {}),
    };

    const orderBy: Prisma.ReviewOrderByWithRelationInput[] = [
      // Prior-work entries sort last within any page, matching how the block reads: self-attested reputation is real but it is not the same thing.
      { countsToAverage: 'desc' },
      ...(query.sort === 'HIGHEST'
        ? [{ rating: 'desc' as const }]
        : query.sort === 'LOWEST'
          ? [{ rating: 'asc' as const }]
          : []),
      { createdAt: 'desc' },
    ];

    const [total, rows, summary, tagLabels] = await Promise.all([
      this.database.review.count({ where }),
      this.database.review.findMany({
        where,
        include: { reviewer: { select: authorSelect }, conversation: REVIEW_CONVERSATION },
        orderBy,
        skip: query.skip,
        take: query.take,
      }),
      // The summary is over ALL reviews regardless of the context filter, so the chips can show counts while a filter is applied (2.5.1).
      this.reputation.summaryFor(subjectUserId),
      this.taxonomy.labels(TaxonomyKind.HELP_TAG),
    ]);

    return {
      data: {
        summary: {
          average: summary.average,
          countedTotal: summary.countedTotal,
          excludedTotal: summary.excludedTotal,
          distribution: {
            5: summary.star5,
            4: summary.star4,
            3: summary.star3,
            2: summary.star2,
            1: summary.star1,
          },
          byContext: {
            COMMUNITY: summary.communityCount,
            BOOKING: summary.bookingCount,
            ORDER: summary.orderCount,
            PROFESSIONAL: summary.professionalCount,
            PRIOR_WORK: summary.priorWorkCount,
          },
        },
        reviews: rows.map(row => this.toView(row, viewerId, subjectUserId, tagLabels)),
      },
      meta: buildPageMeta(query, total),
    };
  }

  // ─── 2.5.2 Create ──────────────────────────────────────────────────────────

  /** One endpoint for all four contexts, because a review is a review. */
  async create(reviewerId: string, dto: CreateReviewDto): Promise<ReviewView> {
    if (dto.subjectUserId === reviewerId) {
      throw ApiException.unprocessable(
        ApiErrorCode.CANNOT_REVIEW_YOURSELF,
        'You cannot review yourself.',
        { details: [{ field: 'subjectUserId', message: 'You cannot review yourself.' }] },
      );
    }

    const subject = await this.database.user.findUnique({
      where: { id: dto.subjectUserId },
      select: { id: true, isAnonymised: true },
    });

    if (!subject || subject.isAnonymised) {
      throw ApiException.notFound('That member could not be found.');
    }

    if (dto.tags?.length) {
      await this.taxonomy.assertAllValid(TaxonomyKind.HELP_TAG, dto.tags, 'tags');
    }

    const source = await this.assertEligible(reviewerId, dto);
    const existing = await this.findExisting(reviewerId, dto);

    if (existing) {
      // Returns the existing review so the client can offer an edit rather than a duplicate (2.5.2).
      throw ApiException.conflict(
        ApiErrorCode.REVIEW_ALREADY_LEFT,
        'You have already reviewed this.',
        {
          data: {
            review: this.toView(
              await this.withReviewer(existing.id),
              reviewerId,
              dto.subjectUserId,
              await this.taxonomy.labels(TaxonomyKind.HELP_TAG),
            ),
          },
        },
      );
    }

    const reviewerProfile = await this.database.userProfile.findUnique({
      where: { userId: reviewerId },
      select: { countryOfOrigin: true },
    });

    const created = await this.database.$transaction(async tx => {
      const review = await tx.review.create({
        data: {
          subjectUserId: dto.subjectUserId,
          reviewerId,
          rating: dto.rating,
          comment: dto.comment,
          context: dto.context,
          sourceId: dto.sourceId ?? null,
          // PRIOR_WORK is self-attested reputation portability: it lets an established professional bring years of built reputation onto Circl, but it is not evidence Circl has, so it never moves the average.
          countsToAverage: dto.context !== ReviewContext.PRIOR_WORK,
          tags: toJsonOrUndefined(dto.tags),
          // Denormalised at write time so the immigrant-friendly filter is an index scan rather than a join back through the reviewer's profile.
          reviewerCountryOfOrigin: reviewerProfile?.countryOfOrigin ?? null,
          requestId: source.requestId,
          bookingId: source.bookingId,
          enquiryId: source.enquiryId,
          conversationId: source.conversationId,
          editableUntil: new Date(Date.now() + EDIT_WINDOW_MS),
        },
      });

      await this.reputation.recompute(dto.subjectUserId, tx);

      return review;
    });

    this.notifications.raise({
      userId: dto.subjectUserId,
      actorId: reviewerId,
      kind: NotificationKind.REVIEW,
      categoryCode: 'BOOKINGS',
      title: `${await this.notifications.actorName(reviewerId)} left you a review`,
      body: dto.comment ? excerpt(dto.comment, 80) : `${dto.rating} stars`,
      route: `/reviews/${dto.subjectUserId}`,
      target: { type: 'PROFILE', id: dto.subjectUserId },
    });

    return this.toView(
      await this.withReviewer(created.id),
      reviewerId,
      dto.subjectUserId,
      await this.taxonomy.labels(TaxonomyKind.HELP_TAG),
    );
  }

  async update(reviewerId: string, id: string, dto: UpdateReviewDto): Promise<ReviewView> {
    const review = await this.database.review.findUnique({ where: { id } });

    if (!review || review.deletedAt) throw ApiException.notFound('That review could not be found.');

    if (review.reviewerId !== reviewerId) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You can only edit your own review.');
    }

    // Frozen after 48 hours.
    if (!review.editableUntil || review.editableUntil < new Date()) {
      throw ApiException.forbidden(
        ApiErrorCode.REVIEW_FROZEN,
        'Reviews can only be edited within 48 hours of being left.',
      );
    }

    if (dto.tags?.length) {
      await this.taxonomy.assertAllValid(TaxonomyKind.HELP_TAG, dto.tags, 'tags');
    }

    await this.database.$transaction(async tx => {
      await tx.review.update({
        where: { id },
        data: {
          rating: dto.rating,
          comment: dto.comment,
          ...(dto.tags ? { tags: toJsonOrUndefined(dto.tags) } : {}),
        },
      });

      await this.reputation.recompute(review.subjectUserId, tx);
    });

    return this.toView(
      await this.withReviewer(id),
      reviewerId,
      review.subjectUserId,
      await this.taxonomy.labels(TaxonomyKind.HELP_TAG),
    );
  }

  // ─── 2.5.3 Reply ───────────────────────────────────────────────────────────

  /** The subject may reply once, publicly, to a review about them. */
  async reply(subjectUserId: string, id: string, dto: ReviewReplyDto): Promise<ReviewView> {
    const review = await this.database.review.findUnique({ where: { id } });

    if (!review || review.deletedAt) throw ApiException.notFound('That review could not be found.');

    if (review.subjectUserId !== subjectUserId) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'Only the person reviewed can reply to it.',
      );
    }

    if (review.reply) {
      throw ApiException.conflict(
        ApiErrorCode.CONFLICT,
        'You have already replied to this review.',
        { data: { reply: review.reply } },
      );
    }

    await this.database.review.update({
      where: { id },
      data: {
        reply: toJsonOrUndefined({ comment: dto.comment, createdAt: new Date().toISOString() }),
      },
    });

    return this.toView(
      await this.withReviewer(id),
      subjectUserId,
      review.subjectUserId,
      await this.taxonomy.labels(TaxonomyKind.HELP_TAG),
    );
  }

  // ─── Eligibility (2.5.2) ───────────────────────────────────────────────────

  /** Enforced server-side, because a review is a claim about a real interaction and the client cannot be the thing that decides one happened. */
  private async assertEligible(
    reviewerId: string,
    dto: CreateReviewDto,
  ): Promise<{
    requestId: string | null;
    bookingId: string | null;
    enquiryId: string | null;
    conversationId: string | null;
  }> {
    const empty = { requestId: null, bookingId: null, enquiryId: null, conversationId: null };

    switch (dto.context) {
      case ReviewContext.BOOKING: {
        this.assertSourceId(dto);

        const booking = await this.database.booking.findUnique({ where: { id: dto.sourceId } });

        // A party to that booking, and only once it is COMPLETED.
        const isParty =
          booking &&
          (booking.clientId === reviewerId || booking.professionalId === reviewerId) &&
          (booking.clientId === dto.subjectUserId || booking.professionalId === dto.subjectUserId);

        if (!booking || !isParty || booking.state !== JobState.COMPLETED) {
          throw ApiException.unprocessable(
            ApiErrorCode.REVIEW_NOT_ELIGIBLE,
            'You can review a booking once it is complete, and only if you were part of it.',
            {
              details: [
                { field: 'sourceId', message: 'Not a completed booking you were part of.' },
              ],
            },
          );
        }

        return { ...empty, bookingId: booking.id };
      }

      case ReviewContext.COMMUNITY: {
        this.assertSourceId(dto);

        const request = await this.database.communityRequest.findUnique({
          where: { id: dto.sourceId },
          include: { helpers: { select: { userId: true } } },
        });

        // The caller owned the request, it is RESOLVED, and the subject was credited as a helper.
        const credited = request?.helpers.some(helper => helper.userId === dto.subjectUserId);

        if (
          !request ||
          request.authorId !== reviewerId ||
          request.status !== RequestStatus.RESOLVED ||
          !credited
        ) {
          throw ApiException.unprocessable(
            ApiErrorCode.REVIEW_NOT_ELIGIBLE,
            'You can review someone who helped with a request you posted, once you have resolved it and credited them.',
            {
              details: [
                { field: 'sourceId', message: 'Not a request you resolved and credited them on.' },
              ],
            },
          );
        }

        return { ...empty, requestId: request.id };
      }

      case ReviewContext.ORDER: {
        this.assertSourceId(dto);

        const enquiry = await this.database.enquiry.findUnique({ where: { id: dto.sourceId } });

        if (enquiry) {
          const isBuyer = enquiry.buyerId === reviewerId && enquiry.sellerId === dto.subjectUserId;

          // D24: an expired enquiry cannot be reviewed, because nothing was ever confirmed as received and a review of an unconfirmed order is a review of nothing.
          if (!isBuyer || enquiry.state !== JobState.COMPLETED) {
            throw ApiException.unprocessable(
              ApiErrorCode.REVIEW_NOT_ELIGIBLE,
              'You can review a seller once you have confirmed you received your order.',
              { details: [{ field: 'sourceId', message: 'Not a completed order of yours.' }] },
            );
          }

          return { ...empty, enquiryId: enquiry.id };
        }

        // Otherwise the source is the thread, and a deal in it that reached DONE is the completed
        // record — the same condition in the language the two of them actually used (6).
        const done = await this.doneDealBetween(
          dto.sourceId,
          reviewerId,
          dto.subjectUserId,
          DealTrack.COMMERCE,
        );

        if (!done) {
          throw ApiException.unprocessable(
            ApiErrorCode.REVIEW_NOT_ELIGIBLE,
            'You can review once you have confirmed you received your order, or once a deal in that thread is done.',
            { details: [{ field: 'sourceId', message: 'Not a completed order or a done deal.' }] },
          );
        }

        return { ...empty, conversationId: dto.sourceId };
      }

      case ReviewContext.PROFESSIONAL: {
        this.assertSourceId(dto);

        // A done deal is the stronger record and it reads both ways: a professional's experience
        // of a client is worth the same as the other way round (6). It stands in for the listing
        // ownership and both-spoken checks below, which are the weaker evidence.
        if (
          await this.doneDealBetween(
            dto.sourceId,
            reviewerId,
            dto.subjectUserId,
            DealTrack.PROFESSIONAL,
          )
        ) {
          await this.assertNoBookingInstead(reviewerId, dto.subjectUserId);

          return { ...empty, conversationId: dto.sourceId };
        }

        const conversation = await this.database.conversation.findUnique({
          where: { id: dto.sourceId },
          select: {
            id: true,
            contextType: true,
            contextId: true,
            participants: { select: { userId: true } },
          },
        });

        const listing = await this.listingBehind(conversation);

        const partyIds = new Set(conversation?.participants.map(row => row.userId) ?? []);

        // Both of them have spoken. One person writing into the void is not working together, and
        // without it anybody could review anybody by messaging them once.
        const spokenBoth = conversation
          ? (
              await this.database.message.groupBy({
                by: ['senderId'],
                where: { conversationId: conversation.id, deletedAt: null },
              })
            ).length >= 2
          : false;

        if (
          !conversation ||
          !listing ||
          listing.userId !== dto.subjectUserId ||
          !partyIds.has(reviewerId) ||
          !partyIds.has(dto.subjectUserId) ||
          !spokenBoth
        ) {
          throw ApiException.unprocessable(
            ApiErrorCode.REVIEW_NOT_ELIGIBLE,
            'You can review a professional once you have both spoken in a thread about their listing or one of their services.',
            {
              details: [
                {
                  field: 'sourceId',
                  message: 'Not a thread about their work that you have both replied in.',
                },
              ],
            },
          );
        }

        await this.assertNoBookingInstead(reviewerId, dto.subjectUserId);

        return { ...empty, conversationId: conversation.id };
      }

      case ReviewContext.PRIOR_WORK: {
        // Reputation portability: past clients from outside Circl can vouch for a professional, so an established one does not arrive at zero.
        const booking = await this.database.booking.findFirst({
          where: {
            OR: [
              { clientId: reviewerId, professionalId: dto.subjectUserId },
              { clientId: dto.subjectUserId, professionalId: reviewerId },
            ],
          },
          select: { id: true },
        });

        if (booking) {
          throw ApiException.unprocessable(
            ApiErrorCode.REVIEW_NOT_ELIGIBLE,
            'You have worked with them through Circl, so review that booking instead.',
            { details: [{ field: 'context', message: 'Use the booking review instead.' }] },
          );
        }

        return empty;
      }

      default:
        return empty;
    }
  }

  /**
   * A deal in this thread, between these two, on this track, that reached DONE.
   *
   * The track is half the check. Without it an order review could be filed as `PROFESSIONAL` by
   * passing a shop thread, and a shop's custom would land on the seller's professional reputation.
   */
  private async doneDealBetween(
    conversationId: string,
    reviewerId: string,
    subjectUserId: string,
    track: DealTrack,
  ): Promise<boolean> {
    const deal = await this.database.deal.findFirst({
      where: {
        conversationId,
        track,
        steps: { some: { stage: DealStage.DONE } },
        OR: [
          { payerId: reviewerId, providerId: subjectUserId },
          { payerId: subjectUserId, providerId: reviewerId },
        ],
      },
      select: { id: true },
    });

    return deal !== null;
  }

  /** 4.3: once booking returns it is the better evidence, so it takes precedence for a pair who have one. */
  private async assertNoBookingInstead(reviewerId: string, subjectUserId: string): Promise<void> {
    const booking = await this.database.booking.findFirst({
      where: {
        state: JobState.COMPLETED,
        OR: [
          { clientId: reviewerId, professionalId: subjectUserId },
          { clientId: subjectUserId, professionalId: reviewerId },
        ],
      },
      select: { id: true },
    });

    if (booking) {
      throw ApiException.unprocessable(
        ApiErrorCode.REVIEW_NOT_ELIGIBLE,
        'You booked them through Circl, so review that booking instead.',
        { details: [{ field: 'context', message: 'Use the booking review instead.' }] },
      );
    }
  }

  /**
   * The listing a thread is about, whether it names the listing or one service off it. A service
   * belongs to exactly one listing, so both arrive at the same owner.
   */
  private async listingBehind(
    conversation: { contextType: ThreadContextType | null; contextId: string | null } | null,
  ): Promise<{ userId: string } | null> {
    if (!conversation?.contextId) return null;

    if (conversation.contextType === ThreadContextType.PROFESSIONAL) {
      return this.database.professionalListing.findUnique({
        where: { id: conversation.contextId },
        select: { userId: true },
      });
    }

    if (conversation.contextType === ThreadContextType.SERVICE) {
      const service = await this.database.professionalService.findUnique({
        where: { id: conversation.contextId },
        select: { listing: { select: { userId: true } } },
      });

      return service?.listing ?? null;
    }

    return null;
  }

  private assertSourceId(
    dto: CreateReviewDto,
  ): asserts dto is CreateReviewDto & { sourceId: string } {
    if (!dto.sourceId) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        `A ${dto.context.toLowerCase()} review needs the record it is about.`,
        { details: [{ field: 'sourceId', message: 'This is required for this review type.' }] },
      );
    }
  }

  private async findExisting(reviewerId: string, dto: CreateReviewDto) {
    return this.database.review.findFirst({
      where: {
        reviewerId,
        context: dto.context,
        deletedAt: null,
        ...(dto.context === ReviewContext.PRIOR_WORK
          ? // One per pair, ever.
            { subjectUserId: dto.subjectUserId }
          : { sourceId: dto.sourceId }),
      },
      select: { id: true },
    });
  }

  private async withReviewer(id: string) {
    return this.database.review.findUniqueOrThrow({
      where: { id },
      include: { reviewer: { select: authorSelect }, conversation: REVIEW_CONVERSATION },
    });
  }

  private toView(
    row: Review & {
      reviewer: Parameters<typeof toAuthorView>[0];
      conversation?: { contextType: ThreadContextType | null; contextSnapshot: unknown } | null;
    },
    viewerId: string | null,
    subjectUserId: string,
    tagLabels: Map<string, string>,
  ): ReviewView {
    const reply = row.reply as { comment: string; createdAt: string } | null;
    const isOwner = viewerId !== null && row.reviewerId === viewerId;

    return {
      id: row.id,
      rating: row.rating,
      comment: row.comment,
      context: row.context,
      contextLabel: contextLabelFor(row),
      countsToAverage: row.countsToAverage,
      tags: Array.isArray(row.tags)
        ? (row.tags as string[]).map(tag => tagLabels.get(tag) ?? tag)
        : [],
      reviewer: toAuthorView(row.reviewer, { sign: this.media.sign }),
      subjectReply: reply ?? null,
      viewer: {
        isOwner,
        canEdit: isOwner && !!row.editableUntil && row.editableUntil > new Date(),
        canReply: viewerId === subjectUserId && !reply,
      },
      createdAt: row.createdAt.toISOString(),
    };
  }
}
