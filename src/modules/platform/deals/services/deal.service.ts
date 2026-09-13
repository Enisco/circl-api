import { Injectable } from '@nestjs/common';
import {
  Deal,
  DealRole,
  DealStage,
  DealStep,
  DealTiming,
  DealTrack,
  NotificationKind,
  ParticipantRole,
  Prisma,
  SystemMessageType,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { PrismaError, PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, money } from '@/common';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import { ThreadWorkService } from '../../messaging/services/thread-work.service';
import { displayNameOf } from '../../shared';
import { NotificationFeedService } from '../../notifications';
import { CARRIES_AMOUNT, CONFIRMS, STAGE_LABELS, mayMark, spineFor } from '../deal-spine';
import { CorrectAmountDto, FlagProblemDto, MarkStepsDto, ProposeDealDto } from '../dtos/deal.dto';

/** Which contexts can carry a deal. A favour and an introduction are not sales. */
const TRACK_FOR_CONTEXT: Partial<Record<ThreadContextType, DealTrack>> = {
  [ThreadContextType.ITEM]: DealTrack.COMMERCE,
  [ThreadContextType.STORE]: DealTrack.COMMERCE,
  [ThreadContextType.ORDER]: DealTrack.COMMERCE,
  [ThreadContextType.PROFESSIONAL]: DealTrack.PROFESSIONAL,
  [ThreadContextType.SERVICE]: DealTrack.PROFESSIONAL,
  [ThreadContextType.BOOKING]: DealTrack.PROFESSIONAL,
};

type DealWithSteps = Deal & { steps: DealStep[] };

/** Pence, read by a person rather than a client: the support note is prose, not a payload. */
const priced = (amount: number, currency: string): string =>
  currency === 'GBP'
    ? `\u00A3${(amount / 100).toFixed(2)}`
    : `${currency} ${(amount / 100).toFixed(2)}`;

@Injectable()
export class DealService {
  constructor(
    private readonly database: PrismaService,
    private readonly conversations: ConversationFactoryService,
    private readonly notifications: NotificationFeedService,
    private readonly threadWork: ThreadWorkService,
  ) {}

  async forConversation(userId: string, conversationId: string) {
    await this.requireParticipant(userId, conversationId);

    const deal = await this.database.deal.findUnique({
      where: { conversationId },
      include: { steps: { orderBy: { reachedAt: 'asc' } } },
    });

    if (!deal) throw ApiException.notFound('No deal has been started in this conversation.');

    this.roleOf(deal, userId);

    return this.toView(deal, userId);
  }

  /**
   * Proposing does NOT mark AGREED. It records who proposed and leaves the step for the other
   * party: if the proposal marked it, the acceptor would have nothing to tap and the deal would be
   * stuck before it began (3.3).
   */
  async propose(userId: string, conversationId: string, dto: ProposeDealDto) {
    const conversation = await this.requireParticipant(userId, conversationId);
    const track = conversation.contextType
      ? TRACK_FOR_CONTEXT[conversation.contextType]
      : undefined;

    if (!track) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'A deal belongs to a thread about something being sold or done, not to a general conversation.',
        { details: [{ field: 'conversationId', message: 'This thread cannot carry a deal.' }] },
      );
    }

    const deposit = dto.deposit ?? null;

    // 3.6: otherwise there is no balance and the spine carries a payment step for nothing.
    if (deposit !== null && deposit >= dto.amount) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'A deposit has to be less than the total, or there is nothing left to pay.',
        { details: [{ field: 'deposit', message: 'Must be less than the amount.' }] },
      );
    }

    const providerId = await this.providerOf(conversation);
    // Circl's team can be sitting in a thread — a dispute puts them there — and they are not a
    // side of the deal. Taking the first participant who is not the provider would have made a
    // staff account the payer.
    const memberIds = conversation.participants
      .filter(row => row.role === ParticipantRole.MEMBER)
      .map(row => row.userId);
    const payers = memberIds.filter(id => id !== providerId);

    if (!memberIds.includes(providerId) || payers.length !== 1) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'This thread does not have both sides of a deal in it.',
      );
    }

    const payerId = payers[0];

    if (userId !== payerId && userId !== providerId) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'A deal is between the two people in the thread.',
      );
    }

    const existing = await this.database.deal.findUnique({
      where: { conversationId },
      include: { steps: true },
    });

    // Terms set the spine, so they cannot move once both sides have agreed to them.
    if (existing?.isAgreedByBoth) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'These terms have been agreed. Flag a problem instead of changing them.',
      );
    }

    const terms = {
      track,
      payerId,
      providerId,
      proposedByRole: userId === payerId ? DealRole.PAYER : DealRole.PROVIDER,
      amount: dto.amount,
      currency: dto.currency ?? 'GBP',
      timing: dto.timing,
      depositAmount: deposit,
      collects: dto.collects ?? false,
      summary: dto.summary ?? null,
      isAgreedByBoth: false,
    };

    const deal = await this.database.deal.upsert({
      where: { conversationId },
      // Re-proposing on an un-agreed deal replaces the terms and keeps it un-agreed. The proposer
      // moves with it, so the other side is always the one who can accept.
      update: terms,
      create: { conversationId, ...terms },
      include: { steps: { orderBy: { reachedAt: 'asc' } } },
    });

    const said = existing ? 'updated the terms' : 'proposed terms';

    await this.conversations.postSystemMessage(
      conversationId,
      SystemMessageType.DEAL_PROPOSED,
      `${await this.nameOf(userId)} ${said}`,
      { dealId: deal.id, amount: deal.amount, currency: deal.currency },
    );

    await this.notify(deal, userId, said);

    return this.toView(deal, userId);
  }

  /**
   * Marks one or more stages, in spine order, atomically. Every rule in §3 is checked here rather
   * than trusted from the client: a client rule is a courtesy, and anybody can call the API.
   */
  async markSteps(userId: string, dealId: string, dto: MarkStepsDto) {
    const deal = await this.load(dealId);

    await this.requireParticipant(userId, deal.conversationId);

    const role = this.roleOf(deal, userId);
    const spine = spineFor(deal);
    const already = new Set(deal.steps.map(step => step.stage));
    const asked = [...new Set(dto.stages)].sort((a, b) => spine.indexOf(a) - spine.indexOf(b));

    const paying = asked.filter(stage => CARRIES_AMOUNT.includes(stage));

    if (paying.length > 1) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'One payment at a time: a deposit and a balance are two figures and one call carries one.',
        { details: [{ field: 'stages', message: 'Mark the deposit and the payment separately.' }] },
      );
    }

    const reached = new Set(already);

    for (const stage of asked) {
      this.assertMarkable(deal, stage, role, spine, reached);
      reached.add(stage);
    }

    const amount = paying.length ? (dto.amount ?? this.expectedAmount(deal, paying[0])) : null;

    try {
      await this.database.$transaction(async tx => {
        for (const stage of asked) {
          await tx.dealStep.create({
            data: {
              dealId: deal.id,
              stage,
              byRole: role,
              ...(CARRIES_AMOUNT.includes(stage)
                ? { amount, currency: dto.currency ?? deal.currency }
                : {}),
            },
          });
        }

        if (asked.includes(DealStage.AGREED)) {
          await tx.deal.update({ where: { id: deal.id }, data: { isAgreedByBoth: true } });
        }
      });
    } catch (error) {
      // A double tap on a slow connection sends the same stage twice and both pass the checks
      // above. The unique index is what actually decides; this turns losing that race into the
      // same refusal a second mark gets, rather than a 500.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PrismaError.UniqueConstraintViolation
      ) {
        throw ApiException.unprocessable(
          ApiErrorCode.INVALID_TRANSITION,
          `${STAGE_LABELS[asked[0]]} has already been marked.`,
        );
      }

      throw error;
    }

    // Per step, so the transcript alone tells the story without the panel. The notification is per
    // call, below: two taps at a counter are one event, not two pushes.
    for (const stage of asked) {
      await this.conversations.postSystemMessage(
        deal.conversationId,
        SystemMessageType.DEAL_STEP_MARKED,
        `${await this.nameOf(userId)} marked: ${STAGE_LABELS[stage]}`,
        { dealId: deal.id, stage },
      );
    }

    const fresh = await this.load(dealId);

    await this.notify(
      fresh,
      userId,
      `marked: ${asked.map(stage => STAGE_LABELS[stage]).join(' and ')}`,
    );

    return this.toView(fresh, userId);
  }

  /**
   * The single most important rule here (3.4). The point of a confirmation is that neither party
   * can afterwards revise the shared record alone, so a confirmed figure is frozen and the way out
   * of a wrong one is to flag a problem rather than to edit it quietly.
   */
  async correctAmount(userId: string, dealId: string, dto: CorrectAmountDto) {
    const deal = await this.load(dealId);

    await this.requireParticipant(userId, deal.conversationId);

    if (this.roleOf(deal, userId) !== DealRole.PAYER) {
      throw ApiException.forbidden(
        ApiErrorCode.FORBIDDEN,
        'Only the paying side can correct what they said they paid.',
      );
    }

    const marked = new Set(deal.steps.map(step => step.stage));
    const stage =
      dto.stage ?? (marked.has(DealStage.PAID) ? DealStage.PAID : DealStage.DEPOSIT_PAID);
    const step = deal.steps.find(row => row.stage === stage);

    if (!step) {
      throw ApiException.unprocessable(
        ApiErrorCode.INVALID_TRANSITION,
        'There is no such payment on this deal to correct.',
        { details: [{ field: 'stage', message: `${stage} has not been marked.` }] },
      );
    }

    const lock = CONFIRMS[stage];

    if (lock && marked.has(lock)) {
      throw ApiException.unprocessable(
        ApiErrorCode.INVALID_TRANSITION,
        'The other side has confirmed this figure, so it cannot be edited. Flag a problem instead.',
        { details: [{ field: 'amount', message: `Confirmed by ${lock}.` }] },
      );
    }

    await this.database.dealStep.update({
      where: { id: step.id },
      data: { amount: dto.amount, currency: dto.currency ?? deal.currency },
    });

    const fresh = await this.load(dealId);

    await this.notify(fresh, userId, `corrected ${STAGE_LABELS[stage].toLowerCase()}`);

    return this.toView(fresh, userId);
  }

  /** Flags and notifies. It reverses nothing, holds nothing and decides nothing (7). */
  async flagProblem(userId: string, dealId: string, dto: FlagProblemDto) {
    const deal = await this.load(dealId);

    await this.requireParticipant(userId, deal.conversationId);
    this.roleOf(deal, userId);

    await this.database.deal.update({
      where: { id: deal.id },
      data: { hasProblem: true, problemNote: dto.note ?? null, problemAt: new Date() },
    });

    await this.conversations.postSystemMessage(
      deal.conversationId,
      SystemMessageType.DEAL_PROBLEM_FLAGGED,
      `${await this.nameOf(userId)} flagged a problem with this deal`,
      { dealId: deal.id, note: dto.note ?? null },
    );

    const fresh = await this.load(dealId);

    await Promise.all([
      this.notify(fresh, userId, 'flagged a problem with this deal'),
      this.tellSupport(fresh, userId, dto.note ?? null),
    ]);

    return this.toView(fresh, userId);
  }

  // ─── 5 Analytics ───────────────────────────────────────────────────────────

  /**
   * Confirmed money only (3.5). A buyer saying they paid moves nothing: if unconfirmed claims
   * counted, the total would be a wish-list, and a number nobody can stand behind is worse than no
   * number at all.
   */
  async earnings(userId: string, track: DealTrack) {
    await this.assertOwns(userId, track);

    const deals = await this.database.deal.findMany({
      where: { providerId: userId, track },
      include: { steps: true },
    });

    let received = 0;
    let completed = 0;
    const currencies = new Set<string>();

    for (const deal of deals) {
      const marked = new Set(deal.steps.map(step => step.stage));

      if (marked.has(DealStage.DONE)) completed += 1;

      for (const step of deal.steps) {
        const lock = CONFIRMS[step.stage];

        if (!lock || !marked.has(lock)) continue;

        received += step.amount ?? 0;
        currencies.add(step.currency ?? deal.currency);
      }
    }

    return {
      // One currency, because adding two would give a figure in neither. Mixed deals fall back to
      // the platform default rather than picking a side.
      received: money(received, currencies.size === 1 ? [...currencies][0] : 'GBP'),
      completed,
    };
  }

  /** The same three numbers `professionals/home.myWork` returns, off the same implementation (5). */
  async work(userId: string, track: DealTrack) {
    const owned = await this.assertOwns(userId, track);

    return this.threadWork.of(userId, owned);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * The threads this member owns a side of on this track: their shop and everything in it, or
   * their listing and every service off it. No shop and no listing means nothing to report, and a
   * row of zeroes would read as a real record of nothing happening.
   */
  private async assertOwns(
    userId: string,
    track: DealTrack,
  ): Promise<Array<{ type: ThreadContextType; ids: string[] }>> {
    if (track === DealTrack.COMMERCE) {
      const store = await this.database.store.findFirst({
        where: { ownerId: userId, deletedAt: null },
        select: { id: true },
      });

      if (!store) {
        throw ApiException.notFound('You do not have a store yet.', ApiErrorCode.STORE_NOT_FOUND);
      }

      const [items, enquiries] = await Promise.all([
        this.database.storeItem.findMany({ where: { storeId: store.id }, select: { id: true } }),
        this.database.enquiry.findMany({ where: { sellerId: userId }, select: { id: true } }),
      ]);

      return [
        { type: ThreadContextType.STORE, ids: [store.id] },
        { type: ThreadContextType.ITEM, ids: items.map(item => item.id) },
        { type: ThreadContextType.ORDER, ids: enquiries.map(enquiry => enquiry.id) },
      ];
    }

    const listing = await this.database.professionalListing.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });

    if (!listing) throw ApiException.notFound('You do not have a listing yet.');

    const [services, bookings] = await Promise.all([
      this.database.professionalService.findMany({
        where: { listingId: listing.id },
        select: { id: true },
      }),
      this.database.booking.findMany({ where: { professionalId: userId }, select: { id: true } }),
    ]);

    return [
      { type: ThreadContextType.PROFESSIONAL, ids: [listing.id] },
      { type: ThreadContextType.SERVICE, ids: services.map(service => service.id) },
      { type: ThreadContextType.BOOKING, ids: bookings.map(booking => booking.id) },
    ];
  }

  /**
   * Opens or reuses the flagger's thread with Circl's team and puts both sides' record in it, so a
   * human reading it does not have to ask what happened. It decides nothing: `problem` flags and
   * notifies, and that is all it does (7).
   */
  private async tellSupport(
    deal: DealWithSteps,
    flaggerId: string,
    note: string | null,
  ): Promise<void> {
    const staffIds = await this.conversations.staffUserIds();
    const { conversation } = await this.conversations.ensure({
      kind: ThreadKind.SUPPORT,
      participantIds: [flaggerId],
      staffIds,
      contextType: ThreadContextType.SUPPORT,
      contextId: null,
      snapshot: { title: 'Circl team', subtitle: 'A problem with a deal' },
      // Pinned so it is first for everyone.
      isPinned: true,
    });

    await this.conversations.addStaff(conversation.id, staffIds);

    const [payer, provider] = await Promise.all([
      this.fullNameOf(deal.payerId),
      this.fullNameOf(deal.providerId),
    ]);
    const nameFor = (role: DealRole) => (role === DealRole.PAYER ? payer : provider);
    const marked = deal.steps.map(step => `${STAGE_LABELS[step.stage]} (${nameFor(step.byRole)})`);

    await this.conversations.postSystemMessage(
      conversation.id,
      SystemMessageType.DEAL_PROBLEM_FLAGGED,
      [
        `${flaggerId === deal.payerId ? payer : provider} flagged a problem with a deal.`,
        [
          `${payer} is paying ${provider} ${priced(deal.amount, deal.currency)}`,
          deal.depositAmount
            ? `, ${priced(deal.depositAmount, deal.currency)} of it as a deposit`
            : '',
          ` (${deal.timing === DealTiming.UPFRONT ? 'up front' : 'on completion'}).`,
        ].join(''),
        deal.summary ? `For: ${deal.summary}` : null,
        marked.length ? `Marked so far: ${marked.join(', ')}.` : 'Nothing has been marked yet.',
        note ? `They said: ${note}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      {
        dealId: deal.id,
        conversationId: deal.conversationId,
        payerId: deal.payerId,
        providerId: deal.providerId,
        flaggedBy: flaggerId,
      },
    );
  }

  private assertMarkable(
    deal: DealWithSteps,
    stage: DealStage,
    role: DealRole,
    spine: DealStage[],
    reached: Set<DealStage>,
  ): void {
    const index = spine.indexOf(stage);

    if (index === -1) {
      throw ApiException.unprocessable(
        ApiErrorCode.INVALID_TRANSITION,
        `${STAGE_LABELS[stage]} is not part of these terms.`,
        { details: [{ field: 'stages', message: `${stage} is not in this deal's order.` }] },
      );
    }

    // 3.2: a second PAID is a refusal, not a silent overwrite.
    if (reached.has(stage)) {
      throw ApiException.unprocessable(
        ApiErrorCode.INVALID_TRANSITION,
        `${STAGE_LABELS[stage]} has already been marked.`,
      );
    }

    if (stage === DealStage.AGREED) {
      // 3.3: a member cannot agree with themselves.
      if (role === deal.proposedByRole) {
        throw ApiException.unprocessable(
          ApiErrorCode.INVALID_TRANSITION,
          'The other side has to agree to these terms. You proposed them.',
        );
      }

      return;
    }

    // Until the terms are agreed there is no defined order to validate anything against.
    if (!deal.isAgreedByBoth && !reached.has(DealStage.AGREED)) {
      throw ApiException.unprocessable(
        ApiErrorCode.INVALID_TRANSITION,
        'Nothing moves on a deal until both sides have agreed the terms.',
      );
    }

    // 3.1: nobody ticks the other side's box.
    if (!mayMark(stage, role)) {
      throw ApiException.unprocessable(
        ApiErrorCode.INVALID_TRANSITION,
        `Only the other side can mark ${STAGE_LABELS[stage].toLowerCase()}.`,
      );
    }

    const missing = spine.slice(0, index).filter(earlier => !reached.has(earlier));

    if (missing.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.INVALID_TRANSITION,
        `${STAGE_LABELS[missing[0]]} comes first.`,
        { details: [{ field: 'stages', message: `${missing[0]} is not marked yet.` }] },
      );
    }
  }

  /** What the terms say is due at this step, for a client that marks it without restating it. */
  private expectedAmount(deal: Deal, stage: DealStage): number {
    if (stage === DealStage.DEPOSIT_PAID) return deal.depositAmount ?? deal.amount;

    return deal.amount - (deal.depositAmount ?? 0);
  }

  /**
   * Which side of the deal this member is, and a refusal if they are neither. A thread can hold a
   * third person — a dispute puts Circl's team in one — and being in the room is not being a party
   * to the deal: without this, a staff account would read as the PROVIDER and could tick the
   * professional's boxes.
   */
  private roleOf(deal: Deal, userId: string): DealRole {
    if (userId === deal.payerId) return DealRole.PAYER;
    if (userId === deal.providerId) return DealRole.PROVIDER;

    throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'This is not your deal.');
  }

  private async load(dealId: string): Promise<DealWithSteps> {
    const deal = await this.database.deal.findUnique({
      where: { id: dealId },
      include: { steps: { orderBy: { reachedAt: 'asc' } } },
    });

    if (!deal) throw ApiException.notFound('That deal could not be found.');

    return deal;
  }

  private async requireParticipant(userId: string, conversationId: string) {
    const conversation = await this.database.conversation.findUnique({
      where: { id: conversationId },
      include: { participants: { select: { userId: true, role: true } } },
    });

    if (!conversation) throw ApiException.notFound('That conversation could not be found.');

    if (!conversation.participants.some(row => row.userId === userId)) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You are not in this conversation.');
    }

    return conversation;
  }

  /** The side that supplies the thing: the shop's owner, or the professional. */
  private async providerOf(conversation: {
    contextType: ThreadContextType | null;
    contextId: string | null;
  }): Promise<string> {
    const id = conversation.contextId ?? '';

    switch (conversation.contextType) {
      case ThreadContextType.STORE: {
        const store = await this.database.store.findUnique({ where: { id } });

        return store?.ownerId ?? '';
      }
      case ThreadContextType.ITEM: {
        const item = await this.database.storeItem.findUnique({
          where: { id },
          select: { store: { select: { ownerId: true } } },
        });

        return item?.store.ownerId ?? '';
      }
      case ThreadContextType.ORDER: {
        const enquiry = await this.database.enquiry.findUnique({ where: { id } });

        return enquiry?.sellerId ?? '';
      }
      case ThreadContextType.PROFESSIONAL: {
        const listing = await this.database.professionalListing.findUnique({ where: { id } });

        return listing?.userId ?? '';
      }
      case ThreadContextType.SERVICE: {
        const service = await this.database.professionalService.findUnique({
          where: { id },
          select: { listing: { select: { userId: true } } },
        });

        return service?.listing.userId ?? '';
      }
      case ThreadContextType.BOOKING: {
        const booking = await this.database.booking.findUnique({ where: { id } });

        return booking?.professionalId ?? '';
      }
      default:
        return '';
    }
  }

  /** First name only: "Ade marked: Payment received" is what the other party needs to read. */
  private async nameOf(userId: string): Promise<string> {
    const user = await this.database.user.findUnique({
      where: { id: userId },
      select: { firstName: true },
    });

    return user?.firstName ?? 'Somebody';
  }

  /** Both names, for the support brief: a human reading it needs to tell two people apart. */
  private async fullNameOf(userId: string): Promise<string> {
    const user = await this.database.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    });

    return user ? displayNameOf(user.firstName, user.lastName) : 'Somebody';
  }

  /**
   * One per call, to the other party only. A seller who does not know the buyer has paid will not
   * dispatch, which is what makes the feature work at all.
   */
  private async notify(deal: Deal, actorId: string, phrase: string): Promise<void> {
    const otherId = actorId === deal.payerId ? deal.providerId : deal.payerId;

    this.notifications.raise({
      userId: otherId,
      actorId,
      kind: NotificationKind.DEAL,
      categoryCode: 'BOOKINGS',
      title: `${await this.nameOf(actorId)} ${phrase}`,
      route: `/messages/${deal.conversationId}`,
      // A deal has no screen of its own: it lives in its thread, so the target is the thread.
      target: { type: 'DEAL', id: deal.conversationId },
      metadata: { dealId: deal.id },
    });
  }

  private toView(deal: DealWithSteps, userId: string) {
    const role = this.roleOf(deal, userId);

    return {
      id: deal.id,
      conversationId: deal.conversationId,
      track: deal.track,
      viewerRole: role,
      proposedByRole: deal.proposedByRole,
      isAgreedByBoth: deal.isAgreedByBoth,
      hasProblem: deal.hasProblem,
      problemNote: deal.problemNote,
      terms: {
        amount: money(deal.amount, deal.currency),
        timing: deal.timing,
        deposit: money(deal.depositAmount, deal.currency),
        collects: deal.collects,
        summary: deal.summary,
      },
      // Only what has happened. The client derives the rest of the spine from the terms.
      steps: deal.steps.map(step => ({
        stage: step.stage,
        label: STAGE_LABELS[step.stage],
        reachedAt: step.reachedAt.toISOString(),
        byRole: step.byRole,
        amount: money(step.amount, step.currency ?? deal.currency),
      })),
      createdAt: deal.createdAt.toISOString(),
    };
  }
}

export type DealView = Awaited<ReturnType<DealService['forConversation']>>;
export { TRACK_FOR_CONTEXT };
