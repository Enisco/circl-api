import { Injectable } from '@nestjs/common';
import {
  Booking,
  JobStage,
  JobState,
  Prisma,
  SystemMessageType,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  addDays,
  ApiErrorCode,
  ApiException,
  buildPageMeta,
  money,
  Paginated,
  toDateOnly,
} from '@/common';
import { AuthorView, MediaService, authorSelect, toAuthorView } from '../../shared';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import {
  CancelDto,
  CreateBookingDto,
  DeliverDto,
  ListBookingsDto,
  RequestChangesDto,
  TransitionReasonDto,
} from '../dtos/booking.dto';

/** 7 days after DELIVERED (2.9.5). */
const AUTO_COMPLETE_DAYS = 7;

/**
 * The stages the client renders, in order.
 *
 * Sent in full with a `reachedAt` per stage, because the timeline is data and not
 * a client-side derivation. Sending only the current stage forces the client to
 * invent the order (2.9.1).
 */
const TIMELINE_STAGES: JobStage[] = [
  JobStage.REQUESTED,
  JobStage.ACCEPTED,
  JobStage.IN_PROGRESS,
  JobStage.DELIVERED,
  JobStage.DONE,
  JobStage.REVIEWED,
];

export type ViewerRole = 'CLIENT' | 'PROFESSIONAL';

/**
 * When "Report a problem" is offered. Not before the work is agreed — there is
 * nothing to dispute about a request nobody has accepted — and still available
 * after completion, because problems surface late.
 */
const DISPUTABLE_STATES: JobState[] = [
  JobState.ACCEPTED,
  JobState.IN_PROGRESS,
  JobState.DELIVERED,
  JobState.CHANGES_REQUESTED,
  JobState.COMPLETED,
];

export interface BookingViewerActions {
  role: ViewerRole;
  canAccept: boolean;
  canDecline: boolean;
  canStart: boolean;
  canMarkDelivered: boolean;
  canConfirmDone: boolean;
  canRequestChanges: boolean;
  canCancel: boolean;
  canRaiseIssue: boolean;
  canReview: boolean;
}

@Injectable()
export class BookingService {
  constructor(
    private readonly database: PrismaService,
    private readonly conversations: ConversationFactoryService,
    private readonly media: MediaService,
  ) {}

  // ─── 2.9.2 Create ──────────────────────────────────────────────────────────

  async create(clientId: string, dto: CreateBookingDto) {
    const listing = await this.database.professionalListing.findUnique({
      where: { id: dto.listingId },
      include: { user: { select: { id: true } } },
    });

    if (!listing || listing.deletedAt) {
      throw ApiException.notFound(
        'That listing could not be found.',
        ApiErrorCode.LISTING_NOT_FOUND,
      );
    }

    if (listing.userId === clientId) {
      throw ApiException.unprocessable(
        ApiErrorCode.CANNOT_BOOK_YOURSELF,
        'You cannot book your own listing.',
      );
    }

    if (!listing.isAcceptingWork) {
      throw ApiException.unprocessable(
        ApiErrorCode.NOT_ACCEPTING_WORK,
        'This professional is not taking new work right now.',
      );
    }

    if (!dto.serviceId && !dto.briefId) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Choose a service, or send the brief you already wrote.',
        { details: [{ field: 'serviceId', message: 'Either serviceId or briefId is required.' }] },
      );
    }

    // The server copies the values; the client sends the id. A later edit to the
    // listing must not rewrite what the two people agreed (2.1.5).
    let serviceName = '';
    let serviceDescription: string | null = null;
    let quotedAmount: number | null = null;

    if (dto.serviceId) {
      const service = await this.database.professionalService.findUnique({
        where: { id: dto.serviceId },
      });

      if (!service || service.listingId !== listing.id) {
        throw ApiException.notFound('That service could not be found.');
      }

      if (!service.isActive) {
        throw ApiException.unprocessable(
          ApiErrorCode.SERVICE_INACTIVE,
          'That service is no longer available.',
        );
      }

      serviceName = service.name;
      serviceDescription = service.description;
      quotedAmount = service.price;
    }

    let brief: Awaited<ReturnType<typeof this.loadBrief>> | null = null;

    if (dto.briefId) {
      brief = await this.loadBrief(clientId, dto.briefId);
      serviceName ||= listing.professionTitle;
      serviceDescription ??= brief.description;
      quotedAmount ??= brief.budget;
    }

    const booking = await this.database.$transaction(async tx => {
      const created = await tx.booking.create({
        data: {
          clientId,
          professionalId: listing.userId,
          listingId: listing.id,
          serviceId: dto.serviceId ?? null,
          briefId: dto.briefId ?? null,
          serviceName,
          serviceDescription,
          quotedAmount,
          agreedAmount: dto.agreedAmount ?? null,
          preferredDate: dto.preferredDate && !dto.isFlexible ? new Date(dto.preferredDate) : null,
          preferredTimeSlot: dto.isFlexible ? null : (dto.preferredTimeSlot ?? null),
          isFlexible: dto.isFlexible ?? false,
          mode: dto.mode ?? undefined,
          address: dto.mode === 'IN_PERSON' ? (dto.address ?? null) : null,
          // With a brief present, `details` is an ADDITION rather than a
          // replacement: the brief text is never re-posted by the client.
          details: dto.details ?? null,
          state: JobState.PENDING_ACCEPTANCE,
        },
      });

      await tx.bookingEvent.create({
        data: { bookingId: created.id, stage: JobStage.REQUESTED, actorId: clientId },
      });

      // Creates the conversation and returns its id on the booking, so Message
      // never has to guess a thread. The client currently pushes a hardcoded
      // thread, which is a bug this field removes (2.9.2).
      const { conversation } = await this.conversations.ensure(
        {
          kind: ThreadKind.PROFESSIONAL,
          participantIds: [clientId, listing.userId],
          contextType: ThreadContextType.BOOKING,
          contextId: created.id,
          snapshot: {
            title: serviceName,
            subtitle: listing.professionTitle,
            trailing: quotedAmount ? `£${(quotedAmount / 100).toFixed(2)}` : null,
            route: `/bookings/${created.id}`,
          },
        },
        tx,
      );

      await tx.booking.update({
        where: { id: created.id },
        data: { conversationId: conversation.id },
      });

      await this.conversations.postSystemMessage(
        conversation.id,
        SystemMessageType.BOOKING_CREATED,
        `Booking requested: ${serviceName}.`,
        { bookingId: created.id },
        tx,
      );

      if (brief) {
        await tx.managedBrief.update({
          where: { id: brief.id },
          data: { state: 'PLACED', bookingId: created.id, chosenListingId: listing.id },
        });
      }

      return created;
    });

    return this.findOne(clientId, booking.id);
  }

  // ─── 2.9.3 List ────────────────────────────────────────────────────────────

  async list(userId: string, query: ListBookingsDto): Promise<Paginated<unknown>> {
    const role = query.role ?? 'CLIENT';

    if (role === 'PROFESSIONAL') {
      // What gates the second tab (2.9.3).
      const listing = await this.database.professionalListing.findUnique({
        where: { userId },
        select: { id: true },
      });

      if (!listing) {
        throw ApiException.forbidden(
          ApiErrorCode.NOT_A_PROFESSIONAL,
          'You do not have a professional listing.',
        );
      }
    }

    const where: Prisma.BookingWhereInput = {
      ...(role === 'CLIENT' ? { clientId: userId } : { professionalId: userId }),
      ...(query.state?.length ? { state: { in: query.state } } : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.booking.count({ where }),
      this.database.booking.findMany({
        where,
        include: {
          client: { select: authorSelect },
          professional: { select: authorSelect },
          events: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
    ]);

    return {
      data: rows.map(row => this.toSummary(row, userId, role)),
      meta: buildPageMeta(query, total),
    };
  }

  // ─── 2.9.4 Detail ──────────────────────────────────────────────────────────

  async findOne(userId: string, id: string) {
    const booking = await this.database.booking.findUnique({
      where: { id },
      include: {
        client: { select: authorSelect },
        professional: { select: authorSelect },
        events: true,
        brief: true,
        listing: { select: { id: true, professionTitle: true } },
        disputes: { where: { state: { in: ['OPEN', 'IN_REVIEW'] } }, select: { id: true } },
        reviews: { where: { reviewerId: userId }, select: { id: true } },
      },
    });

    if (!booking) throw ApiException.notFound('That booking could not be found.');

    const role = this.roleOf(booking, userId);
    const counterpart = role === 'CLIENT' ? booking.professional : booking.client;

    return {
      id: booking.id,
      state: booking.state,
      serviceName: booking.serviceName,
      serviceDescription: booking.serviceDescription,
      listing: { id: booking.listingId, professionTitle: booking.listing.professionTitle },
      quotedAmount: money(booking.quotedAmount, booking.currency),
      // D12: self-declared, unverified, display only. Never aggregated into
      // revenue reporting and never a figure Circl stands behind.
      agreedAmount: money(booking.agreedAmount, booking.currency),
      preferredDate: toDateOnly(booking.preferredDate),
      preferredTimeSlot: booking.preferredTimeSlot,
      isFlexible: booking.isFlexible,
      mode: booking.mode,
      address: booking.address,
      details: booking.details,
      // The brief already filled in, which is what the booking screen renders
      // rather than asking the member to retype it (2.1.5).
      brief: booking.brief
        ? {
            id: booking.brief.id,
            description: booking.brief.description,
            urgency: booking.brief.urgency,
            budget: money(booking.brief.budget, booking.brief.currency),
          }
        : null,
      counterpart: toAuthorView(counterpart),
      conversationId: booking.conversationId,
      autoCompleteAt: booking.autoCompleteAt?.toISOString() ?? null,
      timeline: this.timeline(booking.events),
      viewer: this.viewerActions(booking, userId, role, {
        hasOpenDispute: booking.disputes.length > 0,
        hasReviewed: booking.reviews.length > 0,
      }),
      createdAt: booking.createdAt.toISOString(),
      updatedAt: booking.updatedAt.toISOString(),
    };
  }

  // ─── 2.9.5 Transitions ─────────────────────────────────────────────────────

  async accept(userId: string, id: string) {
    return this.transition(userId, id, {
      allowedRole: 'PROFESSIONAL',
      from: [JobState.PENDING_ACCEPTANCE],
      to: JobState.ACCEPTED,
      stage: JobStage.ACCEPTED,
    });
  }

  async decline(userId: string, id: string, dto: TransitionReasonDto) {
    return this.transition(userId, id, {
      allowedRole: 'PROFESSIONAL',
      from: [JobState.PENDING_ACCEPTANCE],
      to: JobState.CANCELLED,
      stage: JobStage.CANCELLED,
      reason: dto.reason,
    });
  }

  async start(userId: string, id: string) {
    return this.transition(userId, id, {
      allowedRole: 'PROFESSIONAL',
      from: [JobState.ACCEPTED],
      to: JobState.IN_PROGRESS,
      stage: JobStage.IN_PROGRESS,
    });
  }

  async deliver(userId: string, id: string, dto: DeliverDto) {
    const media = await this.media.validate(dto.mediaIds, userId);

    return this.transition(userId, id, {
      allowedRole: 'PROFESSIONAL',
      from: [JobState.IN_PROGRESS, JobState.CHANGES_REQUESTED],
      to: JobState.DELIVERED,
      stage: JobStage.DELIVERED,
      note: dto.note,
      mediaIds: media.map(item => item.id),
    });
  }

  async requestChanges(userId: string, id: string, dto: RequestChangesDto) {
    return this.transition(userId, id, {
      allowedRole: 'CLIENT',
      from: [JobState.DELIVERED],
      to: JobState.CHANGES_REQUESTED,
      stage: JobStage.CHANGES_REQUESTED,
      note: dto.message,
    });
  }

  /** Closes the job and opens reviews. No payment occurs (2.9.5). */
  async complete(userId: string, id: string) {
    return this.transition(userId, id, {
      allowedRole: 'CLIENT',
      from: [JobState.DELIVERED],
      to: JobState.COMPLETED,
      stage: JobStage.DONE,
    });
  }

  async cancel(userId: string, id: string, dto: CancelDto) {
    return this.transition(userId, id, {
      allowedRole: 'EITHER',
      from: [JobState.PENDING_ACCEPTANCE, JobState.ACCEPTED],
      to: JobState.CANCELLED,
      stage: JobStage.CANCELLED,
      reason: dto.reason,
    });
  }

  /**
   * Every transition returns the full updated booking including the new timeline
   * and viewer, so the screen never needs a follow-up fetch (2.9.5).
   */
  private async transition(
    userId: string,
    id: string,
    options: {
      allowedRole: ViewerRole | 'EITHER';
      from: JobState[];
      to: JobState;
      stage: JobStage;
      reason?: string;
      note?: string;
      mediaIds?: string[];
    },
  ) {
    const booking = await this.database.booking.findUnique({ where: { id } });

    if (!booking) throw ApiException.notFound('That booking could not be found.');

    const role = this.roleOf(booking, userId);

    if (options.allowedRole !== 'EITHER' && role !== options.allowedRole) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'You cannot take that action on this booking.',
      );
    }

    if (!options.from.includes(booking.state)) {
      // The current state goes in `data`, so a client working from a stale screen
      // can resync instead of guessing (2.9.5).
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'This booking has moved on since your screen loaded.',
        { data: { state: booking.state } },
      );
    }

    await this.database.$transaction(async tx => {
      const now = new Date();

      await tx.booking.update({
        where: { id },
        data: {
          state: options.to,
          ...(options.to === JobState.DELIVERED
            ? {
                deliveredAt: now,
                // On the record from the moment of delivery, so the screen can
                // state it plainly rather than burying it in terms. It closes a
                // job; it does not release money, because there is none.
                autoCompleteAt: addDays(now, AUTO_COMPLETE_DAYS),
              }
            : {}),
          ...(options.to === JobState.COMPLETED ? { completedAt: now, autoCompleteAt: null } : {}),
          ...(options.to === JobState.CANCELLED
            ? { cancelledAt: now, cancelReason: options.reason ?? null, autoCompleteAt: null }
            : {}),
        },
      });

      await tx.bookingEvent.upsert({
        where: { bookingId_stage: { bookingId: id, stage: options.stage } },
        update: { reachedAt: now, actorId: userId, note: options.note ?? options.reason ?? null },
        create: {
          bookingId: id,
          stage: options.stage,
          actorId: userId,
          note: options.note ?? options.reason ?? null,
        },
      });

      if (options.to === JobState.COMPLETED) {
        await tx.professionalListing.updateMany({
          where: { id: booking.listingId },
          data: { jobsCompleted: { increment: 1 } },
        });
      }

      if (booking.conversationId) {
        await this.conversations.postSystemMessage(
          booking.conversationId,
          SystemMessageType.BOOKING_STATE_CHANGED,
          this.stateMessage(options.to, options.reason ?? options.note),
          { bookingId: id, state: options.to },
          tx,
        );
      }
    });

    return this.findOne(userId, id);
  }

  /**
   * Auto-complete (2.9.5). Runs on a schedule; the booking moves to COMPLETED on
   * its own and both sides are prompted to review.
   */
  async runAutoComplete(): Promise<number> {
    const due = await this.database.booking.findMany({
      where: { state: JobState.DELIVERED, autoCompleteAt: { lte: new Date() } },
      select: { id: true, listingId: true, conversationId: true },
      take: 200,
    });

    for (const booking of due) {
      await this.database.$transaction(async tx => {
        const now = new Date();

        await tx.booking.update({
          where: { id: booking.id },
          data: { state: JobState.COMPLETED, completedAt: now, autoCompleteAt: null },
        });

        await tx.bookingEvent.upsert({
          where: { bookingId_stage: { bookingId: booking.id, stage: JobStage.DONE } },
          update: { reachedAt: now },
          create: { bookingId: booking.id, stage: JobStage.DONE, note: 'Closed automatically' },
        });

        await tx.professionalListing.updateMany({
          where: { id: booking.listingId },
          data: { jobsCompleted: { increment: 1 } },
        });

        if (booking.conversationId) {
          await this.conversations.postSystemMessage(
            booking.conversationId,
            SystemMessageType.BOOKING_STATE_CHANGED,
            'This job closed automatically after 7 days. You can both leave a review.',
            { bookingId: booking.id, state: JobState.COMPLETED, automatic: true },
            tx,
          );
        }
      });
    }

    return due.length;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private roleOf(booking: Booking, userId: string): ViewerRole {
    if (booking.clientId === userId) return 'CLIENT';
    if (booking.professionalId === userId) return 'PROFESSIONAL';

    throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'This booking is not yours.');
  }

  private timeline(events: Array<{ stage: JobStage; reachedAt: Date }>) {
    const reached = new Map(events.map(event => [event.stage, event.reachedAt] as const));

    const stages = TIMELINE_STAGES.map(stage => ({
      stage,
      reachedAt: reached.get(stage)?.toISOString() ?? null,
    }));

    // A cancelled or disputed job did not pass through DONE, so those stages are
    // appended rather than pretending the happy path completed.
    for (const stage of [JobStage.CANCELLED, JobStage.DISPUTED, JobStage.EXPIRED]) {
      if (reached.has(stage)) {
        stages.push({ stage, reachedAt: reached.get(stage)!.toISOString() });
      }
    }

    return stages;
  }

  /**
   * Every action button is server-authorised (2.9.4).
   *
   * The client renders exactly the actions that are true. Deriving them from role
   * plus state on the client means every policy change needs an app release, and
   * the two will disagree.
   */
  private viewerActions(
    booking: Booking,
    userId: string,
    role: ViewerRole,
    context: { hasOpenDispute: boolean; hasReviewed: boolean },
  ): BookingViewerActions {
    const isPro = role === 'PROFESSIONAL';
    const isClient = role === 'CLIENT';
    const { state } = booking;

    void userId;

    return {
      role,
      canAccept: isPro && state === JobState.PENDING_ACCEPTANCE,
      canDecline: isPro && state === JobState.PENDING_ACCEPTANCE,
      canStart: isPro && state === JobState.ACCEPTED,
      canMarkDelivered:
        isPro && (state === JobState.IN_PROGRESS || state === JobState.CHANGES_REQUESTED),
      canConfirmDone: isClient && state === JobState.DELIVERED,
      canRequestChanges: isClient && state === JobState.DELIVERED,
      canCancel: state === JobState.PENDING_ACCEPTANCE || state === JobState.ACCEPTED,
      canRaiseIssue: !context.hasOpenDispute && DISPUTABLE_STATES.includes(state),
      // COMPLETED unlocks reviews. No money moves (2.9.1).
      canReview: state === JobState.COMPLETED && !context.hasReviewed,
    };
  }

  private toSummary(
    booking: Booking & {
      client: Parameters<typeof toAuthorView>[0];
      professional: Parameters<typeof toAuthorView>[0];
      events: Array<{ stage: JobStage; reachedAt: Date }>;
    },
    userId: string,
    role: ViewerRole,
  ) {
    const counterpart: AuthorView = toAuthorView(
      role === 'CLIENT' ? booking.professional : booking.client,
    );

    return {
      id: booking.id,
      state: booking.state,
      serviceName: booking.serviceName,
      counterpart,
      agreedAmount: money(booking.agreedAmount, booking.currency),
      conversationId: booking.conversationId,
      timeline: this.timeline(booking.events),
      // The grouping rule lives here rather than in the client, so "Needs you"
      // and the notification badge cannot disagree (2.9.3).
      needsYourAction:
        role === 'CLIENT'
          ? booking.state === JobState.DELIVERED
          : booking.state === JobState.PENDING_ACCEPTANCE,
      autoCompleteAt: booking.autoCompleteAt?.toISOString() ?? null,
      createdAt: booking.createdAt.toISOString(),
      viewerRole: role,
      isMine: booking.clientId === userId || booking.professionalId === userId,
    };
  }

  private stateMessage(state: JobState, note?: string): string {
    const base: Record<string, string> = {
      [JobState.ACCEPTED]: 'The professional accepted this booking.',
      [JobState.IN_PROGRESS]: 'Work has started.',
      [JobState.DELIVERED]: 'The professional marked this as delivered.',
      [JobState.CHANGES_REQUESTED]: 'Changes were requested.',
      [JobState.COMPLETED]: 'This job is complete. You can both leave a review.',
      [JobState.CANCELLED]: 'This booking was cancelled.',
      [JobState.DISPUTED]: 'An issue was raised. Circl is reviewing it.',
    };

    return note
      ? `${base[state] ?? 'This booking was updated.'} ${note}`
      : (base[state] ?? 'This booking was updated.');
  }

  private async loadBrief(userId: string, briefId: string) {
    const brief = await this.database.managedBrief.findUnique({ where: { id: briefId } });

    if (!brief || brief.userId !== userId) {
      throw ApiException.notFound('That brief could not be found.');
    }

    return brief;
  }
}
