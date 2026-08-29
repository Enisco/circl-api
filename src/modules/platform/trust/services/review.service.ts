import { Injectable } from '@nestjs/common';
import {
  JobState,
  NotificationKind,
  Prisma,
  RequestStatus,
  Review,
  ReviewContext,
  TaxonomyKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  ApiErrorCode,
  ApiException,
  buildPageMeta,
  excerpt,
  toJsonOrUndefined,
} from '@/common';
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
  PRIOR_WORK: 'Worked together before Circl',
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
        include: { reviewer: { select: authorSelect } },
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
      title: 'You have a new review',
      body: dto.comment ? excerpt(dto.comment, 80) : `${dto.rating} stars`,
      route: `/reviews/${dto.subjectUserId}`,
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
  ): Promise<{ requestId: string | null; bookingId: string | null; enquiryId: string | null }> {
    const empty = { requestId: null, bookingId: null, enquiryId: null };

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

        const isBuyer = enquiry?.buyerId === reviewerId && enquiry?.sellerId === dto.subjectUserId;

        // D24: an expired enquiry cannot be reviewed, because nothing was ever confirmed as received and a review of an unconfirmed order is a review of nothing.
        if (!enquiry || !isBuyer || enquiry.state !== JobState.COMPLETED) {
          throw ApiException.unprocessable(
            ApiErrorCode.REVIEW_NOT_ELIGIBLE,
            'You can review a seller once you have confirmed you received your order.',
            { details: [{ field: 'sourceId', message: 'Not a completed order of yours.' }] },
          );
        }

        return { ...empty, enquiryId: enquiry.id };
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
      include: { reviewer: { select: authorSelect } },
    });
  }

  private toView(
    row: Review & { reviewer: Parameters<typeof toAuthorView>[0] },
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
      contextLabel: CONTEXT_LABELS[row.context],
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
