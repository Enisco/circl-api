import { Injectable, Logger } from '@nestjs/common';
import {
  MessageKind,
  MessageStatus,
  NotificationKind,
  Prisma,
  ServiceRequestOfferStatus,
  ServiceRequestState,
  TaxonomyKind,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import { TaxonomyService, displayNameOf } from '../../shared';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import { NotificationFeedService } from '../../notifications/services/notification-feed.service';
import {
  OFFER_SELECT,
  OfferView,
  SERVICE_REQUEST_SELECT,
  toOfferView,
} from '../serializers/service-request.serializer';

/**
 * Three is a cap, not a target.
 *
 * It exists so that one member is not contacted by eight strangers. It is enforced here, in the
 * database, under a lock — two professionals tapping Accept in the same second is the ordinary
 * case for an offer that went out to several people at once, not the edge case.
 */
export const ACCEPTANCE_CAP = 3;

/** How long an unanswered offer stands before it lapses. */
export const OFFER_TTL_HOURS = 72;

/** The longest a thread's title drawn from the member's own words can be. */
const TITLE_LIMIT = 60;

/** How many of their own offers one list returns. */
const LIST_LIMIT = 100;

/**
 * The professional's half: what Circl has offered them, and their answer.
 *
 * Accepting is the one call in this feature that does several things at once, and the order
 * matters: the cap is checked under a lock, the thread is created, the introduction is posted in
 * the professional's name, and only then is the member told. The server writes that first message
 * rather than the app, because two devices racing to open the same thread is how a member gets the
 * same introduction twice.
 */
@Injectable()
export class ServiceRequestOfferService {
  private readonly logger = new Logger(ServiceRequestOfferService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly conversations: ConversationFactoryService,
    private readonly notifications: NotificationFeedService,
  ) {}

  /** Their inbox. Answered offers stay: a row that vanishes on tap reads as a bug. */
  async list(userId: string): Promise<OfferView[]> {
    const [labels, offers] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.database.serviceRequestOffer.findMany({
        where: { professionalId: userId },
        select: { ...OFFER_SELECT, request: { select: SERVICE_REQUEST_SELECT } },
        orderBy: [{ status: 'asc' }, { offeredAt: 'desc' }],
        take: LIST_LIMIT,
      }),
    ]);

    return offers.map(offer => toOfferView(offer, labels));
  }

  /**
   * Take it on.
   *
   * The lock is on the request row, not on the offer: what is being protected is the count of
   * acceptances across every offer that request has out, and a lock on the row being written
   * protects nothing against a second professional writing a different row.
   */
  async accept(userId: string, offerId: string): Promise<OfferView> {
    const existing = await this.loadOffer(userId, offerId);

    // Already accepted: hand back the same answer rather than refusing. The app navigates into
    // the thread on this response, and a retry after a dropped connection is not an error.
    if (existing.status === ServiceRequestOfferStatus.ACCEPTED) {
      return this.view(existing.id);
    }

    await this.assertAcceptable(existing);

    const { conversationId, filled, raced } = await this.database.$transaction(async tx => {
      const request = await this.lockRequest(tx, existing.requestId);

      /**
       * The offer, re-read inside the lock.
       *
       * The check above this transaction is not enough on its own: two devices tapping Accept on
       * the same offer both pass it, and the second would find the thread already created, post a
       * second introduction into it and tell the member twice. The request row is locked, so by
       * the time the second one reads this the first has committed.
       */
      const current = await tx.serviceRequestOffer.findUnique({
        where: { id: existing.id },
        select: { status: true, conversationId: true },
      });

      if (current?.status === ServiceRequestOfferStatus.ACCEPTED && current.conversationId) {
        return { conversationId: current.conversationId, filled: false, raced: true };
      }

      if (current?.status !== ServiceRequestOfferStatus.PENDING) {
        this.assertPending(current?.status ?? ServiceRequestOfferStatus.REVOKED);
      }

      if (
        request.state === ServiceRequestState.CANCELLED ||
        request.state === ServiceRequestState.NO_MATCH
      ) {
        throw ApiException.conflict(
          ApiErrorCode.INVALID_TRANSITION,
          'That request is closed.',
          { data: { status: request.state } },
        );
      }

      const accepted = await tx.serviceRequestOffer.count({
        where: { requestId: existing.requestId, status: ServiceRequestOfferStatus.ACCEPTED },
      });

      if (accepted >= ACCEPTANCE_CAP) {
        // Revoked rather than left pending: the third acceptance should have withdrawn this one,
        // and a row that stays `PENDING` invites the professional to try again for ever.
        await tx.serviceRequestOffer.update({
          where: { id: existing.id },
          // No `respondedAt`: they did not answer this, it was taken off them. The field means
          // "when this professional replied", and the app prints it as such.
          data: { status: ServiceRequestOfferStatus.REVOKED },
        });

        throw ApiException.conflict(
          ApiErrorCode.SERVICE_REQUEST_FILLED,
          `Three professionals already took this one on.`,
          { data: { cap: ACCEPTANCE_CAP } },
        );
      }

      const { conversation, created } = await this.conversations.ensure(
        {
          kind: ThreadKind.PROFESSIONAL,
          participantIds: [request.userId, userId],
          contextType: ThreadContextType.SERVICE_REQUEST,
          contextId: request.id,
          snapshot: {
            title: titleFrom(request.description),
            subtitle: 'Let Circl handle it',
          },
        },
        tx,
      );

      // Only into a thread this call opened. A thread that already existed already carries an
      // introduction, and a second one is the thing the app was forbidden from doing.
      if (created) {
        await this.postIntroduction(tx, conversation.id, userId, request.userId);
      }

      await tx.serviceRequestOffer.update({
        where: { id: existing.id },
        data: {
          status: ServiceRequestOfferStatus.ACCEPTED,
          respondedAt: new Date(),
          conversationId: conversation.id,
        },
      });

      // Somebody has taken it on, so the member's screen stops saying offers are out. Written
      // whatever the previous state: a request can be accepted straight from `SUBMITTED` if staff
      // offered it before the queue was refreshed.
      await tx.serviceRequest.update({
        where: { id: request.id },
        data: { state: ServiceRequestState.MATCHED },
      });

      const nowAccepted = accepted + 1;

      if (nowAccepted >= ACCEPTANCE_CAP) {
        await tx.serviceRequestOffer.updateMany({
          where: { requestId: request.id, status: ServiceRequestOfferStatus.PENDING },
          data: { status: ServiceRequestOfferStatus.REVOKED },
        });
      }

      return { conversationId: conversation.id, filled: nowAccepted >= ACCEPTANCE_CAP, raced: false };
    });

    if (filled) {
      this.logger.log({ serviceRequestId: existing.requestId, event: 'service_request_filled' });
    }

    // Not for the losing half of a race: the member has already been told, and twice is worse
    // than late.
    if (!raced) {
      await this.tellMemberSomebodyAccepted(existing.requestId, userId, conversationId);
    }

    return this.view(existing.id);
  }

  /** Pass. */
  async decline(userId: string, offerId: string): Promise<OfferView> {
    const existing = await this.loadOffer(userId, offerId);

    if (existing.status === ServiceRequestOfferStatus.DECLINED) return this.view(existing.id);

    this.assertPending(existing.status);

    await this.database.serviceRequestOffer.update({
      where: { id: existing.id },
      data: { status: ServiceRequestOfferStatus.DECLINED, respondedAt: new Date() },
    });

    return this.view(existing.id);
  }

  /**
   * Offers nobody answered, lapsed (§3.7).
   *
   * Expiry is a status change and nothing else: no notification to the professional, who did not
   * do anything, and none to the member, who was never told the offer existed. What it is for is
   * the staff queue — a request held open by somebody who never answered looks exactly like one
   * being considered, and those need different work.
   */
  async runExpiry(): Promise<number> {
    const { count } = await this.database.serviceRequestOffer.updateMany({
      where: { status: ServiceRequestOfferStatus.PENDING, expiresAt: { lte: new Date() } },
      // Nobody answered, so nothing is recorded as an answer. `expiresAt` already says when it
      // lapsed, and `updatedAt` says when the sweep noticed.
      data: { status: ServiceRequestOfferStatus.EXPIRED },
    });

    return count;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Why this offer cannot be accepted — in the words that fit the reason.
   *
   * A revoked offer has two quite different causes and the professional deserves to be told
   * which. Three others accepting first is `SERVICE_REQUEST_FILLED`, which the app shows in grey
   * as "Three professionals already took this one on"; staff taking the offer back is not, and
   * saying so in the same words would tell somebody a request filled up when it did not.
   *
   * The distinction cannot be read off the row — both are `REVOKED` — so it is read off the
   * request, which is where the fact lives.
   */
  private async assertAcceptable(offer: {
    status: ServiceRequestOfferStatus;
    requestId: string;
  }): Promise<void> {
    if (offer.status === ServiceRequestOfferStatus.PENDING) return;

    if (offer.status === ServiceRequestOfferStatus.REVOKED) {
      const accepted = await this.database.serviceRequestOffer.count({
        where: { requestId: offer.requestId, status: ServiceRequestOfferStatus.ACCEPTED },
      });

      if (accepted >= ACCEPTANCE_CAP) {
        throw ApiException.conflict(
          ApiErrorCode.SERVICE_REQUEST_FILLED,
          'Three professionals already took this one on.',
          { data: { cap: ACCEPTANCE_CAP } },
        );
      }
    }

    this.assertPending(offer.status);
  }

  private assertPending(status: ServiceRequestOfferStatus): void {
    if (status === ServiceRequestOfferStatus.PENDING) return;

    // `REVOKED` is answered in its own words rather than as "already declined". A professional who
    // did nothing wrong should not be told they turned work down.
    const message =
      status === ServiceRequestOfferStatus.REVOKED
        ? 'No longer available — Circl withdrew this offer.'
        : status === ServiceRequestOfferStatus.EXPIRED
          ? 'This offer has expired.'
          : 'You have already answered this one.';

    throw ApiException.conflict(ApiErrorCode.ALREADY_DECIDED, message, { data: { status } });
  }

  /**
   * The request row, locked for the length of the transaction.
   *
   * `SELECT ... FOR UPDATE` rather than a counted check, because the dangerous case is two
   * professionals each counting two acceptances and each believing they are the third.
   */
  private async lockRequest(
    tx: Prisma.TransactionClient,
    requestId: string,
  ): Promise<{ id: string; userId: string; description: string; state: ServiceRequestState }> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; user_id: string; description: string; state: ServiceRequestState }>
    >`
      SELECT id, user_id, description, state
      FROM managed_briefs
      WHERE id = ${requestId}
      FOR UPDATE
    `;

    const row = rows[0];

    if (!row) throw ApiException.notFound('That request could not be found.');

    return { id: row.id, userId: row.user_id, description: row.description, state: row.state };
  }

  /**
   * The introduction, in the professional's name.
   *
   * Two sentences, and deliberately short: a longer one would have to invent something about work
   * nobody has discussed yet, and §4's three rules — do not claim Circl vetted them for this job,
   * do not promise a price, do not read as automated — are all easier to keep in two lines than in
   * five. The professional's own next message is the one that does the work.
   */
  private async postIntroduction(
    tx: Prisma.TransactionClient,
    conversationId: string,
    professionalId: string,
    memberId: string,
  ): Promise<void> {
    const professional = await tx.user.findUnique({
      where: { id: professionalId },
      select: {
        firstName: true,
        lastName: true,
        professionalListing: { select: { professionTitle: true } },
      },
    });

    const name = displayNameOf(professional?.firstName ?? '', professional?.lastName);
    const title = professional?.professionalListing?.professionTitle;
    const introduction =
      `Hi, I'm ${name}${title ? `, ${title}` : ''}. ` +
      `Circl passed me your request, and I'd like to help if I'm the right fit.`;

    const message = await tx.message.create({
      data: {
        conversationId,
        senderId: professionalId,
        kind: MessageKind.TEXT,
        body: introduction,
        clientId: randomUUID(),
        status: MessageStatus.SENT,
        receipts: {
          create: [
            { userId: professionalId, readAt: new Date() },
            { userId: memberId },
          ],
        },
      },
      select: { id: true, sentAt: true },
    });

    await tx.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: message.sentAt, messageCount: { increment: 1 } },
    });

    await tx.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId: memberId } },
      data: { unreadCount: { increment: 1 }, isArchived: false },
    });

    await tx.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId: professionalId } },
      data: { hasSentMessage: true, lastReadAt: message.sentAt, isArchived: false },
    });
  }

  /**
   * The member, told that somebody has written.
   *
   * Not in §5, which has staff sending the outcome — and this does not replace that. It covers the
   * gap between a professional accepting and staff getting to it: a message has genuinely arrived,
   * and the alternative is a member who is not told until somebody at Circl remembers. Routed at
   * the **request**, like every notification in this feature, because the other outcome of this
   * flow is that there is no conversation at all.
   */
  private async tellMemberSomebodyAccepted(
    requestId: string,
    professionalId: string,
    conversationId: string,
  ): Promise<void> {
    const [request, professional] = await Promise.all([
      this.database.serviceRequest.findUnique({
        where: { id: requestId },
        select: { userId: true },
      }),
      this.database.user.findUnique({
        where: { id: professionalId },
        select: { firstName: true, lastName: true },
      }),
    ]);

    if (!request) return;

    const name = displayNameOf(professional?.firstName ?? 'Someone', professional?.lastName);

    this.notifications.raise({
      userId: request.userId,
      kind: NotificationKind.SERVICE_REQUEST,
      categoryCode: 'BOOKINGS',
      actorId: professionalId,
      title: `${name} is taking on your request`,
      body: 'They have sent you a message.',
      target: { type: 'SERVICE_REQUEST', id: requestId },
      route: `/messages/${conversationId}`,
      metadata: { serviceRequestId: requestId, conversationId },
    });
  }

  private async loadOffer(userId: string, offerId: string) {
    const offer = await this.database.serviceRequestOffer.findUnique({
      where: { id: offerId },
      select: { id: true, requestId: true, professionalId: true, status: true },
    });

    // Somebody else's offer is not found: a professional has no business learning that an id they
    // guessed belongs to a real offer somewhere.
    if (!offer || offer.professionalId !== userId) {
      throw ApiException.notFound('That offer could not be found.');
    }

    return offer;
  }

  private async view(offerId: string): Promise<OfferView> {
    const [labels, offer] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.database.serviceRequestOffer.findUniqueOrThrow({
        where: { id: offerId },
        select: { ...OFFER_SELECT, request: { select: SERVICE_REQUEST_SELECT } },
      }),
    ]);

    return toOfferView(offer, labels);
  }
}

/**
 * A thread title from the member's own words.
 *
 * There is no title field — the form asks for the problem, not a subject line — so the first
 * clause of what they wrote stands in. Cut on a word boundary, because a title that stops
 * mid-word reads as a bug rather than as a summary.
 */
export const titleFrom = (description: string): string => {
  const firstClause = description.split(/[.\n]/)[0].trim() || description.trim();

  if (firstClause.length <= TITLE_LIMIT) return firstClause;

  const cut = firstClause.slice(0, TITLE_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');

  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};
