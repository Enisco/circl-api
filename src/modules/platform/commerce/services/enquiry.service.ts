import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  ActivityVerb,
  Fulfilment,
  JobStage,
  JobState,
  Prisma,
  StoreStatus,
  SystemMessageType,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { addDays, ApiErrorCode, ApiException, buildPageMeta, money } from '@/common';
import { ActivityService, authorSelect, toAuthorView } from '../../shared';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import { CreateEnquiryDto, ListEnquiriesDto, ValidateCartDto } from '../dtos/store.dto';

/**
 * D24: 30 days without a transition sets EXPIRED and drops it off the active
 * list. There is deliberately no auto-complete: auto-confirming that someone
 * received groceries they may never have received is a claim Circl cannot make.
 */
const EXPIRY_DAYS = 30;

/**
 * The stages the buyer sees, mapped onto the shared JobState machine (4.1.3), so
 * bookings and orders use one set of transition rules and one dispute resource.
 */
const TIMELINE_STAGES: JobStage[] = [
  JobStage.REQUESTED,
  JobStage.ACCEPTED,
  JobStage.IN_PROGRESS,
  JobStage.DELIVERED,
  JobStage.DONE,
];

export type EnquiryRole = 'BUYER' | 'SELLER';

/** When "Report a problem" is offered on an order. */
const DISPUTABLE_STATES: JobState[] = [
  JobState.IN_PROGRESS,
  JobState.DELIVERED,
  JobState.COMPLETED,
];

@Injectable()
export class EnquiryService {
  constructor(
    private readonly database: PrismaService,
    private readonly conversations: ConversationFactoryService,
    private readonly activity: ActivityService,
  ) {}

  // ─── 4.6.1 Cart validation ─────────────────────────────────────────────────

  /**
   * The cart is client-side and in memory (D20), so an item that changes price or
   * sells out while it sits there is caught here rather than at enquiry time.
   * That has to be handled wherever the cart lives, so it is built now.
   */
  async validateCart(dto: ValidateCartDto) {
    const items = await this.database.storeItem.findMany({
      where: { id: { in: dto.lines.map(line => line.itemId) } },
      select: {
        id: true,
        name: true,
        price: true,
        currency: true,
        isAvailable: true,
        deletedAt: true,
        storeId: true,
      },
    });
    const byId = new Map(items.map(item => [item.id, item] as const));

    const lines = dto.lines.map(line => {
      const item = byId.get(line.itemId);

      if (!item || item.deletedAt) {
        return {
          itemId: line.itemId,
          quantity: line.quantity,
          status: 'REMOVED' as const,
          name: null,
          unitPrice: null,
          lineTotal: null,
        };
      }

      return {
        itemId: item.id,
        quantity: line.quantity,
        status: item.isAvailable ? ('OK' as const) : ('UNAVAILABLE' as const),
        name: item.name,
        unitPrice: money(item.price, item.currency),
        lineTotal: money(item.price * line.quantity, item.currency),
        storeId: item.storeId,
      };
    });

    const total = lines
      .filter(line => line.status === 'OK')
      .reduce((sum, line) => sum + (line.lineTotal?.amount ?? 0), 0);

    return {
      lines,
      estimatedTotal: money(total),
      hasIssues: lines.some(line => line.status !== 'OK'),
    };
  }

  // ─── 4.7.1 Create ──────────────────────────────────────────────────────────

  async create(buyerId: string, dto: CreateEnquiryDto) {
    const store = await this.database.store.findUnique({
      where: { id: dto.storeId },
      include: { owner: { select: { id: true } } },
    });

    if (!store || store.deletedAt) {
      throw ApiException.notFound('That store could not be found.', ApiErrorCode.STORE_NOT_FOUND);
    }

    if (store.ownerId === buyerId) {
      throw ApiException.unprocessable(
        ApiErrorCode.CANNOT_ENQUIRE_OWN_STORE,
        'You cannot send an enquiry to your own store.',
      );
    }

    // A store that is merely shut for the evening still takes enquiries: that is
    // the point of an enquiry. Only HOLIDAY refuses (4.7.1).
    if (store.status === StoreStatus.HOLIDAY) {
      throw ApiException.unprocessable(
        ApiErrorCode.STORE_CLOSED,
        'This store is on holiday and is not taking enquiries right now.',
      );
    }

    if (dto.fulfilment === Fulfilment.DELIVERY && !store.delivers) {
      throw ApiException.unprocessable(
        ApiErrorCode.DELIVERY_NOT_OFFERED,
        'This store does not deliver. Choose collection instead.',
        { details: [{ field: 'fulfilment', message: 'This store does not deliver.' }] },
      );
    }

    if (dto.fulfilment === Fulfilment.DELIVERY && !dto.deliveryAddress) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'We need a delivery address.',
        { details: [{ field: 'deliveryAddress', message: 'This is required for delivery.' }] },
      );
    }

    // The server re-prices every line from the catalogue and never trusts a price
    // sent by the client (4.6.1).
    const items = await this.database.storeItem.findMany({
      where: { id: { in: dto.lines.map(line => line.itemId) }, storeId: store.id },
    });
    const byId = new Map(items.map(item => [item.id, item] as const));

    const unavailable = dto.lines
      .filter(line => {
        const item = byId.get(line.itemId);

        return !item || item.deletedAt || !item.isAvailable;
      })
      .map(line => line.itemId);

    if (unavailable.length) {
      // The offending ids go in details so the cart can mark them rather than
      // failing opaquely (4.7.1).
      throw ApiException.unprocessable(
        ApiErrorCode.ITEMS_UNAVAILABLE,
        'Some items are no longer available.',
        {
          details: unavailable.map(itemId => ({
            field: 'lines',
            message: `${itemId} is no longer available.`,
          })),
          data: { itemIds: unavailable },
        },
      );
    }

    const lines = dto.lines.map(line => {
      const item = byId.get(line.itemId)!;

      return {
        itemId: item.id,
        name: item.name,
        quantity: line.quantity,
        unitPrice: item.price,
        unitCode: item.unitCode,
        currency: item.currency,
      };
    });

    const estimatedTotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);

    const enquiry = await this.database.$transaction(async tx => {
      const reference = await this.nextReference(tx);

      const created = await tx.enquiry.create({
        data: {
          reference,
          buyerId,
          storeId: store.id,
          sellerId: store.ownerId,
          // "Placed" in buyer-facing copy, ACCEPTED in the shared machine (4.1.3).
          state: JobState.ACCEPTED,
          fulfilment: dto.fulfilment,
          deliveryAddress: dto.deliveryAddress ?? null,
          note: dto.note ?? null,
          estimatedTotal,
          expiresAt: addDays(new Date(), EXPIRY_DAYS),
          lines: { create: lines },
        },
      });

      await tx.enquiryEvent.create({
        data: { enquiryId: created.id, stage: JobStage.REQUESTED, actorId: buyerId },
      });

      // The enquiry IS a message in practice, and the thread is where the two
      // agree the details and the money (4.7.1).
      const { conversation } = await this.conversations.ensure(
        {
          kind: ThreadKind.COMMERCE,
          participantIds: [buyerId, store.ownerId],
          contextType: ThreadContextType.ORDER,
          contextId: created.id,
          snapshot: {
            title: `Enquiry ${reference}`,
            subtitle: store.name,
            trailing: `£${(estimatedTotal / 100).toFixed(2)}`,
            route: `/commerce/orders/${created.id}`,
          },
        },
        tx,
      );

      await tx.enquiry.update({
        where: { id: created.id },
        data: { conversationId: conversation.id },
      });

      await this.conversations.postSystemMessage(
        conversation.id,
        SystemMessageType.ENQUIRY_CREATED,
        `Enquiry ${reference} sent. The estimated total is £${(estimatedTotal / 100).toFixed(2)} — agree the final amount between yourselves.`,
        { enquiryId: created.id },
        tx,
      );

      await tx.store.update({
        where: { id: store.id },
        data: { enquiryCount: { increment: 1 } },
      });

      return created;
    });

    this.activity.record({
      userId: buyerId,
      verb: ActivityVerb.ENQUIRE,
      subject: ActivitySubject.STORE,
      subjectId: store.id,
      cityId: store.cityId,
      weight: 5,
    });

    return this.findOne(buyerId, enquiry.id);
  }

  // ─── 4.7.2 List ────────────────────────────────────────────────────────────

  async list(userId: string, query: ListEnquiriesDto) {
    const role = query.role ?? 'BUYER';

    if (role === 'SELLER') {
      const store = await this.database.store.findUnique({
        where: { ownerId: userId },
        select: { id: true },
      });

      if (!store) {
        throw ApiException.forbidden(ApiErrorCode.NOT_A_SELLER, 'You do not have a store.');
      }
    }

    const where: Prisma.EnquiryWhereInput = {
      ...(role === 'BUYER' ? { buyerId: userId } : { sellerId: userId }),
      ...(query.state?.length ? { state: { in: query.state as JobState[] } } : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.enquiry.count({ where }),
      this.database.enquiry.findMany({
        where,
        include: {
          store: { select: { id: true, name: true, area: true, logoUrl: true } },
          buyer: { select: authorSelect },
          seller: { select: authorSelect },
          lines: true,
          events: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
    ]);

    return {
      data: rows.map(row => ({
        id: row.id,
        reference: row.reference,
        state: row.state,
        stage: this.stageFor(row.state),
        store: row.store,
        counterpart: toAuthorView(role === 'BUYER' ? row.seller : row.buyer),
        estimatedTotal: money(row.estimatedTotal, row.currency),
        fulfilment: row.fulfilment,
        itemCount: row.lines.length,
        conversationId: row.conversationId,
        // Same principle as bookings: the rule lives in one place so the count on
        // My Store matches the list (4.7.2).
        needsYourAction:
          role === 'SELLER'
            ? row.state === JobState.ACCEPTED
            : row.state === JobState.DELIVERED,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: buildPageMeta(query, total),
    };
  }

  // ─── 4.7.3 Detail and transitions ──────────────────────────────────────────

  async findOne(userId: string, id: string) {
    const enquiry = await this.database.enquiry.findUnique({
      where: { id },
      include: {
        store: { select: { id: true, name: true, area: true, logoUrl: true, cityId: true } },
        buyer: { select: authorSelect },
        seller: { select: authorSelect },
        lines: true,
        events: true,
        disputes: { where: { state: { in: ['OPEN', 'IN_REVIEW'] } }, select: { id: true } },
        reviews: { where: { reviewerId: userId }, select: { id: true } },
      },
    });

    if (!enquiry) throw ApiException.notFound('That order could not be found.');

    const role = this.roleOf(enquiry, userId);

    return {
      id: enquiry.id,
      // The human-readable code the buyer quotes to the seller. `id` stays the
      // opaque key, because a reference this short is guessable (4.7.1).
      reference: enquiry.reference,
      store: enquiry.store,
      counterpart: toAuthorView(role === 'BUYER' ? enquiry.seller : enquiry.buyer),
      state: enquiry.state,
      stage: this.stageFor(enquiry.state),
      lines: enquiry.lines.map(line => ({
        itemId: line.itemId,
        name: line.name,
        quantity: line.quantity,
        unitPrice: money(line.unitPrice, line.currency),
        lineTotal: money(line.unitPrice * line.quantity, line.currency),
      })),
      // The sum of catalogue prices at the moment of sending. Not a bill, not a
      // commitment, and Circl does not reconcile it against anything (4.7.1).
      estimatedTotal: money(enquiry.estimatedTotal, enquiry.currency),
      fulfilment: enquiry.fulfilment,
      deliveryAddress: enquiry.deliveryAddress,
      note: enquiry.note,
      conversationId: enquiry.conversationId,
      expiresAt: enquiry.expiresAt?.toISOString() ?? null,
      timeline: this.timeline(enquiry.events),
      viewer: this.viewerActions(enquiry, role, {
        hasOpenDispute: enquiry.disputes.length > 0,
        hasReviewed: enquiry.reviews.length > 0,
      }),
      createdAt: enquiry.createdAt.toISOString(),
    };
  }

  async accept(userId: string, id: string) {
    return this.transition(userId, id, {
      allowedRole: 'SELLER',
      from: [JobState.ACCEPTED],
      to: JobState.IN_PROGRESS,
      stage: JobStage.ACCEPTED,
      message: 'The seller confirmed they can fulfil this.',
    });
  }

  async decline(userId: string, id: string, reason: string) {
    return this.transition(userId, id, {
      allowedRole: 'SELLER',
      from: [JobState.ACCEPTED, JobState.IN_PROGRESS],
      to: JobState.CANCELLED,
      stage: JobStage.CANCELLED,
      reason,
      message: 'The seller could not fulfil this enquiry.',
    });
  }

  async ready(userId: string, id: string) {
    return this.transition(userId, id, {
      allowedRole: 'SELLER',
      from: [JobState.IN_PROGRESS],
      to: JobState.DELIVERED,
      stage: JobStage.DELIVERED,
      message: 'Your order is on the way, or ready to collect.',
    });
  }

  /** Confirms receipt. Closes the enquiry and opens the review (4.7.3). */
  async received(userId: string, id: string) {
    return this.transition(userId, id, {
      allowedRole: 'BUYER',
      from: [JobState.DELIVERED],
      to: JobState.COMPLETED,
      stage: JobStage.DONE,
      message: 'The buyer confirmed they received this. You can both leave a review.',
    });
  }

  async cancel(userId: string, id: string, reason?: string) {
    return this.transition(userId, id, {
      allowedRole: 'EITHER',
      from: [JobState.ACCEPTED, JobState.IN_PROGRESS],
      to: JobState.CANCELLED,
      stage: JobStage.CANCELLED,
      reason,
      message: 'This enquiry was cancelled.',
    });
  }

  private async transition(
    userId: string,
    id: string,
    options: {
      allowedRole: EnquiryRole | 'EITHER';
      from: JobState[];
      to: JobState;
      stage: JobStage;
      reason?: string;
      message: string;
    },
  ) {
    const enquiry = await this.database.enquiry.findUnique({ where: { id } });

    if (!enquiry) throw ApiException.notFound('That order could not be found.');

    const role = this.roleOf(enquiry, userId);

    if (options.allowedRole !== 'EITHER' && role !== options.allowedRole) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'You cannot take that action on this order.',
      );
    }

    if (!options.from.includes(enquiry.state)) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'This order has moved on since your screen loaded.',
        { data: { state: enquiry.state } },
      );
    }

    await this.database.$transaction(async tx => {
      const now = new Date();

      await tx.enquiry.update({
        where: { id },
        data: {
          state: options.to,
          // Every transition pushes the expiry out: 30 days of silence is what
          // expires an enquiry, not 30 days since it was sent (D24).
          expiresAt:
            options.to === JobState.COMPLETED || options.to === JobState.CANCELLED
              ? null
              : addDays(now, EXPIRY_DAYS),
          ...(options.to === JobState.DELIVERED ? { readyAt: now } : {}),
          ...(options.to === JobState.COMPLETED ? { receivedAt: now, completedAt: now } : {}),
          ...(options.to === JobState.CANCELLED
            ? { cancelledAt: now, cancelReason: options.reason ?? null }
            : {}),
        },
      });

      await tx.enquiryEvent.upsert({
        where: { enquiryId_stage: { enquiryId: id, stage: options.stage } },
        update: { reachedAt: now, actorId: userId },
        create: { enquiryId: id, stage: options.stage, actorId: userId, note: options.reason ?? null },
      });

      if (enquiry.conversationId) {
        await this.conversations.postSystemMessage(
          enquiry.conversationId,
          SystemMessageType.ENQUIRY_STATE_CHANGED,
          options.reason ? `${options.message} ${options.reason}` : options.message,
          { enquiryId: id, state: options.to },
          tx,
        );
      }
    });

    return this.findOne(userId, id);
  }

  /**
   * D24: thirty days without a transition drops it off the active list as
   * EXPIRED, and it cannot then be reviewed — nothing was ever confirmed as
   * received, and a review of an unconfirmed order is a review of nothing.
   */
  async runExpiry(): Promise<number> {
    const result = await this.database.enquiry.updateMany({
      where: {
        state: { in: [JobState.ACCEPTED, JobState.IN_PROGRESS, JobState.DELIVERED] },
        expiresAt: { lte: new Date() },
      },
      data: { state: JobState.EXPIRED, expiresAt: null },
    });

    return result.count;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private roleOf(enquiry: { buyerId: string; sellerId: string }, userId: string): EnquiryRole {
    if (enquiry.buyerId === userId) return 'BUYER';
    if (enquiry.sellerId === userId) return 'SELLER';

    throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'This order is not yours.');
  }

  /** The buyer-facing stage name for a shared JobState (4.1.3). */
  private stageFor(state: JobState): string {
    switch (state) {
      case JobState.ACCEPTED:
        return 'PLACED';
      case JobState.IN_PROGRESS:
        return 'ACCEPTED';
      case JobState.DELIVERED:
        return 'ON_THE_WAY';
      case JobState.COMPLETED:
        // Deliberately not "Paid out": no money moves here, and the honest final
        // stage is that the order was received and closed (4.0.1).
        return 'CLOSED';
      case JobState.CANCELLED:
        return 'CANCELLED';
      case JobState.EXPIRED:
        return 'EXPIRED';
      default:
        return 'PLACED';
    }
  }

  private timeline(events: Array<{ stage: JobStage; reachedAt: Date }>) {
    const reached = new Map(events.map(event => [event.stage, event.reachedAt] as const));

    const stages = TIMELINE_STAGES.map(stage => ({
      stage,
      reachedAt: reached.get(stage)?.toISOString() ?? null,
    }));

    for (const stage of [JobStage.CANCELLED, JobStage.DISPUTED, JobStage.EXPIRED]) {
      if (reached.has(stage)) {
        stages.push({ stage, reachedAt: reached.get(stage)!.toISOString() });
      }
    }

    return stages;
  }

  private viewerActions(
    enquiry: { state: JobState },
    role: EnquiryRole,
    context: { hasOpenDispute: boolean; hasReviewed: boolean },
  ) {
    const isSeller = role === 'SELLER';
    const isBuyer = role === 'BUYER';
    const { state } = enquiry;

    return {
      role,
      canAccept: isSeller && state === JobState.ACCEPTED,
      canDecline: isSeller && (state === JobState.ACCEPTED || state === JobState.IN_PROGRESS),
      canMarkReady: isSeller && state === JobState.IN_PROGRESS,
      canConfirmReceived: isBuyer && state === JobState.DELIVERED,
      canCancel: state === JobState.ACCEPTED || state === JobState.IN_PROGRESS,
      canRaiseIssue: !context.hasOpenDispute && DISPUTABLE_STATES.includes(state),
      // An expired enquiry can never be reviewed (D24).
      canReview: isBuyer && state === JobState.COMPLETED && !context.hasReviewed,
    };
  }

  /**
   * `C-2841`. Sequential enough to be quotable over the phone, and paired with an
   * opaque id so it is never the thing an URL is built from.
   */
  private async nextReference(tx: Prisma.TransactionClient): Promise<string> {
    const count = await tx.enquiry.count();

    return `C-${(2000 + count + 1).toString().padStart(4, '0')}`;
  }
}
