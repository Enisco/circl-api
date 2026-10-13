import { Injectable } from '@nestjs/common';
import {
  DealProblemState,
  DisputeOutcome,
  DisputeState,
  JobStage,
  NotificationKind,
  Prisma,
  SystemMessageType,
} from '@prisma/client';
import { ApiErrorCode, ApiException, buildPageMeta } from '@/common';
import { PrismaService } from '@/infrastructure';
import { MediaService } from '@/modules/platform/shared';
import { ConversationFactoryService } from '@/modules/platform/messaging';
import { NotificationFeedService } from '@/modules/platform/notifications';
import { DISPUTE_MEDIA_OWNER } from '@/modules/platform/professionals';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import { AdminAssigneeService } from './admin-assignee.service';
import {
  ListDealProblemsDto,
  ListDisputesDto,
  OPEN_DISPUTE_STATES,
  ResolveDealProblemDto,
  ResolveDisputeDto,
  UpdateDisputeDto,
} from '../dtos/admin-dispute.dto';
import { MemberRefView, toMemberRef } from '../serializers/admin-member.serializer';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';
import { StaffRefView, staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';

/** One piece of evidence, as §5.17 serves it: `IMAGE`/`DOCUMENT` from the media, or `TEXT`. */
export interface EvidenceView {
  id: string;
  uploadedBy: MemberRefView;
  type: string;
  caption: string | null;
  url: string | null;
  createdAt: string;
}

/** The outcomes that end a dispute as withdrawn rather than resolved. */
const WITHDRAWN_OUTCOMES: DisputeOutcome[] = [DisputeOutcome.WITHDRAWN];

/** A job stage, in the words a staff member reads. */
const STAGE_WORDS: Record<JobStage, string> = {
  REQUESTED: 'Requested',
  ACCEPTED: 'Accepted',
  IN_PROGRESS: 'In progress',
  DELIVERED: 'Delivered',
  CHANGES_REQUESTED: 'Changes asked for',
  DONE: 'Done',
  REVIEWED: 'Reviewed',
  CANCELLED: 'Cancelled',
  DISPUTED: 'Issue raised',
  EXPIRED: 'Expired',
};

/**
 * §5.17: disputes, and the deals somebody flagged.
 *
 * The one thing worth stating before anything else: **Circl never moves money.** There is no
 * payment rail here, no escrow and no refund button, which means a resolution is a *finding* and
 * not a settlement. Every shape in this file is built around that — `resolutionNote` is prose
 * shown to both parties, `outcome` is what the platform concluded, and nothing anywhere reverses a
 * transaction, because the platform was never holding one.
 *
 * It follows that the valuable part of a dispute screen is the evidence and the timeline, not the
 * verb. So the detail serves the booking or enquiry with its events, the deal if the two of them
 * recorded one, both parties' evidence with signed media, and the conversation id — and the
 * conversation itself is read through §5.6's grant, because it is still two members' private
 * thread and a dispute is not a reason to make it public to staff.
 *
 * Deal problems are the lighter half: a member taps "something's wrong" on a deal and that raises
 * a flag with a note. `hasProblem` stays true forever afterwards — what happened to the deal is
 * part of its record — so the staff side needed a second field to say whether anybody is still
 * working on it, which is what `problemState` is for.
 */
@Injectable()
export class AdminDisputeService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly conversations: ConversationFactoryService,
    private readonly notifications: NotificationFeedService,
    private readonly assignees: AdminAssigneeService,
    private readonly audit: AuditService,
  ) {}

  // ─── Disputes ──────────────────────────────────────────────────────────────

  async list(query: ListDisputesDto) {
    query.assertDepth();

    const now = new Date();
    // `overdue` narrows the states as well as the date, like the report-case list: a decided
    // dispute cannot be late any more, and `?overdue=true&state=RESOLVED` asking for open work
    // would be a filter that quietly contradicts itself.
    const asked = query.state?.length ? query.state : OPEN_DISPUTE_STATES;
    const states = query.overdue
      ? asked.filter(state => OPEN_DISPUTE_STATES.includes(state))
      : asked;

    const where: Prisma.DisputeWhereInput = {
      state: { in: states },
      ...(query.reasonCode?.length ? { reasonCode: { in: query.reasonCode } } : {}),
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.assignedToId ? { assignedToId: query.assignedToId } : {}),
      ...(query.unassigned ? { assignedToId: null } : {}),
      ...(query.overdue ? { expectedResolutionAt: { lt: now } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.dispute.count({ where }),
      this.database.dispute.findMany({
        where,
        select: DISPUTE_SELECT,
        orderBy: { createdAt: 'desc' },
        take: query.size,
        skip: (query.currentPage - 1) * query.size,
      }),
    ]);

    const staff = await this.staffFor(rows.flatMap(row => [row.assignedToId, row.resolvedById]));

    return {
      data: rows.map(row => this.toRow(row, staff, now)),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        unassigned: await this.database.dispute.count({
          where: { state: { in: OPEN_DISPUTE_STATES }, assignedToId: null },
        }),
        overdueCount: await this.database.dispute.count({
          where: { state: { in: OPEN_DISPUTE_STATES }, expectedResolutionAt: { lt: now } },
        }),
      }),
    };
  }

  async detail(id: string) {
    const row = await this.database.dispute.findUnique({
      where: { id },
      select: {
        ...DISPUTE_SELECT,
        description: true,
        resolutionNote: true,
        resolvedAt: true,
        outcome: true,
        evidence: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            note: true,
            createdAt: true,
            submittedBy: { select: caseMemberSelect },
          },
        },
      },
    });

    if (!row) throw ApiException.notFound('No such dispute.');

    const now = new Date();
    const [staff, subject, deal, attachments] = await Promise.all([
      this.staffFor([row.assignedToId, row.resolvedById]),
      this.subjectOf(row),
      this.dealFor(row.conversationId),
      /**
       * The **dispute's** own id is in this lookup as well as each evidence row's, and that is a
       * fix rather than belt-and-braces.
       *
       * `DisputeService` attaches whatever the member sent when they *opened* the dispute under
       * the dispute id (`media.attach(tx, media, DISPUTE_MEDIA_OWNER, dispute.id)`), and only the
       * later "add evidence" calls own their files by the evidence row. Reading evidence rows
       * alone therefore hid the first thing the complainant sent — the photograph of the thing
       * that was wrong — on the screen that exists to look at it.
       */
      this.media.forOwners(DISPUTE_MEDIA_OWNER, [row.id, ...row.evidence.map(item => item.id)]),
    ]);

    return {
      ...this.toRow(row, staff, now),
      description: row.description,
      /**
       * Both parties' evidence, with signed URLs.
       *
       * `type` is read from the media rather than stored on the row: the member's own endpoint
       * attaches files through `MediaService`, and a `TEXT` entry is one with a note and no
       * attachment — which is a real case, because "both of you can add evidence" includes saying
       * something rather than showing it.
       */
      evidence: [
        // What they sent when they raised it, first, because it is the oldest and because it is
        // the thing the complaint is about. Its `id` is the dispute's, which is what owns it; the
        // caption is the description they wrote, since that is the words those files came with.
        ...(attachments.get(row.id) ?? []).map(
          (file): EvidenceView => ({
            id: row.id,
            uploadedBy: toMemberRef(row.raisedBy, this.media.sign),
            type: file.type as string,
            caption: row.description,
            url: this.media.sign(file.storageKey) ?? null,
            createdAt: row.createdAt.toISOString(),
          }),
        ),
        ...row.evidence.flatMap((item): EvidenceView[] => {
          const files = attachments.get(item.id) ?? [];
          const uploadedBy = toMemberRef(item.submittedBy, this.media.sign);

          // An entry with a note and no file is `TEXT`, which is a real case rather than a gap:
          // "both of you can add evidence" includes saying something rather than showing it.
          if (!files.length) {
            return [
              {
                id: item.id,
                uploadedBy,
                type: 'TEXT',
                caption: item.note,
                url: null,
                createdAt: item.createdAt.toISOString(),
              },
            ];
          }

          return files.map(file => ({
            id: item.id,
            uploadedBy,
            type: file.type as string,
            caption: item.note,
            url: this.media.sign(file.storageKey) ?? null,
            createdAt: item.createdAt.toISOString(),
          }));
        }),
      ],
      subject,
      deal,
      resolutionNote: row.resolutionNote,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      outcome: row.outcome,
      resolvedBy: row.resolvedById ? (staff.get(row.resolvedById) ?? null) : null,
    };
  }

  /** Taking it on, giving it to somebody, or promising a date. */
  async update(actor: AdminPrincipal, id: string, dto: UpdateDisputeDto) {
    dto.assertSomething();

    const row = await this.live(id);

    if (dto.state && dto.state !== DisputeState.IN_REVIEW) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'The only state this sets is IN_REVIEW. Ending a dispute goes through `resolve`.',
        { details: [{ field: 'state', message: 'Use resolve to end a dispute.' }] },
      );
    }

    if (dto.assigneeId) {
      await this.assignees.assertHolds(dto.assigneeId, ['disputes:manage'], 'assigneeId');
    }

    const now = new Date();

    await this.audit.mutate(
      {
        action: 'dispute.updated' as const,
        targetType: 'DISPUTE' as const,
        targetId: id,
        before: {
          state: row.state,
          assignedToId: row.assignedToId,
          expectedResolutionAt: row.expectedResolutionAt?.toISOString() ?? null,
        },
        after: {
          state: dto.state ?? row.state,
          assignedToId: dto.assigneeId === undefined ? row.assignedToId : dto.assigneeId,
          expectedResolutionAt:
            dto.expectedResolutionAt ?? row.expectedResolutionAt?.toISOString() ?? null,
        },
      },
      tx =>
        tx.dispute.update({
          where: { id },
          data: {
            ...(dto.state ? { state: dto.state } : {}),
            ...(dto.assigneeId === undefined
              ? {}
              : { assignedToId: dto.assigneeId, assignedAt: dto.assigneeId ? now : null }),
            ...(dto.expectedResolutionAt
              ? { expectedResolutionAt: new Date(dto.expectedResolutionAt) }
              : {}),
          },
        }),
    );

    // Both parties hear that somebody is on it, and when to expect an answer. A dispute where the
    // platform has gone quiet is the complaint underneath most complaints about a dispute.
    if (dto.state === DisputeState.IN_REVIEW && row.state !== DisputeState.IN_REVIEW) {
      await this.tellBothParties(
        row,
        SystemMessageType.DISPUTE_IN_REVIEW,
        dto.expectedResolutionAt
          ? `Circl is looking into this. We will come back to you by ${new Date(dto.expectedResolutionAt).toDateString()}.`
          : 'Circl is looking into this and will come back to both of you.',
      );
    }

    void actor;

    return this.detail(id);
  }

  /**
   * The finding (§5.17).
   *
   * One note, shown to **both** of them, because a finding told to one party is half a resolution —
   * and the half that is missing is the one who is about to hear a second-hand version of it.
   */
  async resolve(actor: AdminPrincipal, id: string, dto: ResolveDisputeDto) {
    const reason = dto.assertReasoned();
    const row = await this.live(id);
    const state = WITHDRAWN_OUTCOMES.includes(dto.outcome)
      ? DisputeState.WITHDRAWN
      : DisputeState.RESOLVED;
    const now = new Date();

    await this.audit.mutate(
      {
        action: 'dispute.resolved' as const,
        targetType: 'DISPUTE' as const,
        targetId: id,
        before: { state: row.state },
        after: { state, outcome: dto.outcome },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
        metadata: { resolutionNote: dto.resolutionNote },
      },
      tx =>
        tx.dispute.update({
          where: { id },
          data: {
            state,
            outcome: dto.outcome,
            resolutionNote: dto.resolutionNote,
            resolvedAt: now,
            resolvedById: actor.id,
          },
        }),
    );

    await this.tellBothParties(row, SystemMessageType.DISPUTE_RESOLVED, dto.resolutionNote, {
      outcome: dto.outcome,
    });

    return this.detail(id);
  }

  // ─── Deal problems ─────────────────────────────────────────────────────────

  async problems(query: ListDealProblemsDto) {
    query.assertDepth();

    const state = query.problemState ?? DealProblemState.OPEN;
    const where: Prisma.DealWhereInput = {
      hasProblem: true,
      // A deal flagged before this column existed has a null `problemState` and is open work:
      // nobody has settled it, which is exactly what `OPEN` means. Reading it as "not open" would
      // have hidden every flag raised before §5.17 landed.
      ...(state === DealProblemState.OPEN
        ? { OR: [{ problemState: DealProblemState.OPEN }, { problemState: null }] }
        : { problemState: state }),
      ...(query.track ? { track: query.track } : {}),
      ...(query.from || query.to
        ? {
            problemAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.deal.count({ where }),
      this.database.deal.findMany({
        where,
        select: { ...DEAL_SELECT, steps: { orderBy: { reachedAt: 'desc' }, take: 1 } },
        // Newest flag first, and nulls **last**: Postgres puts NULLs first on a `DESC` sort, so a
        // legacy row flagged before `problemAt` was written would have sat at the top of the queue
        // forever on a date nobody has.
        orderBy: [{ problemAt: { sort: 'desc', nulls: 'last' } }],
        take: query.size,
        skip: (query.currentPage - 1) * query.size,
      }),
    ]);

    return {
      data: rows.map(row => ({
        dealId: row.id,
        track: row.track,
        payer: toMemberRef(row.payer, this.media.sign),
        provider: toMemberRef(row.provider, this.media.sign),
        amountPence: row.amount,
        currency: row.currency,
        problemNote: row.problemNote,
        problemAt: row.problemAt?.toISOString() ?? null,
        problemState: row.problemState ?? DealProblemState.OPEN,
        // The furthest step reached, which is what says how much of the deal had happened when
        // somebody raised their hand.
        lastStage: row.steps[0]?.stage ?? null,
        conversationId: row.conversationId,
      })),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        openCount: await this.database.deal.count({
          where: {
            hasProblem: true,
            OR: [{ problemState: DealProblemState.OPEN }, { problemState: null }],
          },
        }),
      }),
    };
  }

  async deal(id: string) {
    const row = await this.database.deal.findUnique({
      where: { id },
      select: {
        ...DEAL_SELECT,
        depositAmount: true,
        timing: true,
        isAgreedByBoth: true,
        isCancelled: true,
        hasProblem: true,
        problemResolutionNote: true,
        problemResolvedAt: true,
        problemResolvedById: true,
        createdAt: true,
        steps: {
          orderBy: { reachedAt: 'asc' },
          select: { stage: true, byRole: true, amount: true, reachedAt: true },
        },
      },
    });

    if (!row) throw ApiException.notFound('No such deal.');

    const staff = await this.staffFor([row.problemResolvedById]);

    return {
      id: row.id,
      track: row.track,
      payer: toMemberRef(row.payer, this.media.sign),
      provider: toMemberRef(row.provider, this.media.sign),
      amountPence: row.amount,
      depositPence: row.depositAmount,
      currency: row.currency,
      timing: row.timing,
      isAgreedByBoth: row.isAgreedByBoth,
      isCancelled: row.isCancelled,
      steps: row.steps.map(step => ({
        stage: step.stage,
        byRole: step.byRole,
        amountPence: step.amount,
        reachedAt: step.reachedAt.toISOString(),
      })),
      hasProblem: row.hasProblem,
      problemNote: row.problemNote,
      problemAt: row.problemAt?.toISOString() ?? null,
      problemState: row.hasProblem ? (row.problemState ?? DealProblemState.OPEN) : null,
      problemResolutionNote: row.problemResolutionNote,
      problemResolvedAt: row.problemResolvedAt?.toISOString() ?? null,
      problemResolvedBy: row.problemResolvedById
        ? (staff.get(row.problemResolvedById) ?? null)
        : null,
      conversationId: row.conversationId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Settling a flagged deal.
   *
   * `hasProblem` is deliberately **not** cleared: a member raised their hand, and that is part of
   * the deal's record whatever happened next. What changes is `problemState`, which is the staff
   * queue's own field — the two were one flag before, so a settled problem and a live one looked
   * identical to everybody except whoever remembered settling it.
   */
  async resolveProblem(actor: AdminPrincipal, id: string, dto: ResolveDealProblemDto) {
    const reason = dto.assertReasoned();
    const row = await this.database.deal.findUnique({
      where: { id },
      select: {
        id: true,
        hasProblem: true,
        problemState: true,
        payerId: true,
        providerId: true,
        problemFlaggedById: true,
      },
    });

    if (!row) throw ApiException.notFound('No such deal.');

    if (!row.hasProblem) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'Nobody has flagged a problem on this deal.',
      );
    }

    if (row.problemState === DealProblemState.RESOLVED) {
      throw ApiException.conflict(
        ApiErrorCode.ALREADY_DECIDED,
        'That problem has already been settled.',
      );
    }

    await this.audit.mutate(
      {
        action: 'deal.problem_resolved' as const,
        targetType: 'DEAL' as const,
        targetId: id,
        before: { problemState: row.problemState ?? DealProblemState.OPEN },
        after: { problemState: DealProblemState.RESOLVED },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
        metadata: { resolutionNote: dto.resolutionNote },
      },
      tx =>
        tx.deal.update({
          where: { id },
          data: {
            problemState: DealProblemState.RESOLVED,
            problemResolutionNote: dto.resolutionNote,
            problemResolvedAt: new Date(),
            problemResolvedById: actor.id,
            // `hasProblem` stays true. See the method comment: it is the record that somebody
            // raised their hand, not a to-do item.
          },
        }),
    );

    await this.tellTheFlagger(row, dto.resolutionNote);

    return this.deal(id);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async live(id: string) {
    const row = await this.database.dispute.findUnique({ where: { id }, select: DISPUTE_SELECT });

    if (!row) throw ApiException.notFound('No such dispute.');

    if (!OPEN_DISPUTE_STATES.includes(row.state)) {
      throw ApiException.conflict(
        ApiErrorCode.ALREADY_DECIDED,
        'That dispute has already been settled.',
        { data: { state: row.state, resolvedAt: row.resolvedAt?.toISOString() ?? null } },
      );
    }

    return row;
  }

  private async staffFor(ids: Array<string | null>) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];

    if (!wanted.length) return new Map<string, StaffRefView>();

    const rows = await this.database.user.findMany({
      where: { id: { in: wanted } },
      select: staffRefSelect,
    });

    return new Map(rows.map(row => [row.id, toStaffRef(row, this.media.sign)]));
  }

  private toRow(row: DisputeRow, staff: Map<string, StaffRefView>, now: Date) {
    const parties = this.partiesOf(row);

    return {
      id: row.id,
      subjectType: row.subjectType,
      subjectId: row.bookingId ?? row.enquiryId,
      raisedBy: toMemberRef(row.raisedBy, this.media.sign),
      // The person on the other side of the job, worked out from the booking or the enquiry — the
      // dispute row itself does not name them, and a screen about a disagreement that shows one
      // party is a screen about a complaint.
      otherParty: parties.other,
      reasonCode: row.reasonCode,
      state: row.state,
      assignedTo: row.assignedToId ? (staff.get(row.assignedToId) ?? null) : null,
      expectedResolutionAt: row.expectedResolutionAt?.toISOString() ?? null,
      overdue:
        OPEN_DISPUTE_STATES.includes(row.state) &&
        !!row.expectedResolutionAt &&
        row.expectedResolutionAt.getTime() < now.getTime(),
      conversationId: row.conversationId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Who is on each side, from whichever subject the dispute hangs off. */
  private partiesOf(row: DisputeRow): { ids: string[]; other: MemberRefView | null } {
    const pair = row.booking
      ? [row.booking.client, row.booking.professional]
      : row.enquiry
        ? [row.enquiry.buyer, row.enquiry.seller]
        : [];
    const other = pair.find(person => person.id !== row.raisedById) ?? null;

    return {
      ids: pair.map(person => person.id),
      other: other ? toMemberRef(other, this.media.sign) : null,
    };
  }

  /** The booking or enquiry, with its timeline — what actually happened before the disagreement. */
  private async subjectOf(row: DisputeRow) {
    if (row.bookingId) {
      const booking = await this.database.booking.findUnique({
        where: { id: row.bookingId },
        select: {
          serviceName: true,
          agreedAmount: true,
          quotedAmount: true,
          state: true,
          events: { orderBy: { reachedAt: 'asc' }, select: { stage: true, reachedAt: true } },
        },
      });

      if (!booking) return null;

      return {
        title: booking.serviceName,
        amountPence: booking.agreedAmount ?? booking.quotedAmount,
        state: booking.state,
        events: booking.events.map(event => ({
          label: STAGE_WORDS[event.stage] ?? event.stage,
          at: event.reachedAt.toISOString(),
        })),
      };
    }

    if (!row.enquiryId) return null;

    const enquiry = await this.database.enquiry.findUnique({
      where: { id: row.enquiryId },
      select: {
        reference: true,
        estimatedTotal: true,
        state: true,
        store: { select: { name: true } },
        events: { orderBy: { reachedAt: 'asc' }, select: { stage: true, reachedAt: true } },
      },
    });

    if (!enquiry) return null;

    return {
      title: `${enquiry.store.name} — ${enquiry.reference}`,
      amountPence: enquiry.estimatedTotal,
      state: enquiry.state,
      events: enquiry.events.map(event => ({
        label: STAGE_WORDS[event.stage] ?? event.stage,
        at: event.reachedAt.toISOString(),
      })),
    };
  }

  /** The deal the two of them recorded in this thread, if they recorded one. */
  private async dealFor(conversationId: string | null) {
    if (!conversationId) return null;

    const row = await this.database.deal.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return row ? this.deal(row.id) : null;
  }

  /** The finding, in the thread both of them can read, and a notification each. */
  private async tellBothParties(
    row: DisputeRow,
    type: SystemMessageType,
    words: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    if (row.conversationId) {
      await this.conversations.postSystemMessage(row.conversationId, type, words, {
        disputeId: row.id,
        ...metadata,
      });
    }

    for (const userId of this.partiesOf(row).ids) {
      this.notifications.raise({
        userId,
        kind: NotificationKind.MODERATION,
        categoryCode: 'ACCOUNT',
        title: 'Circl has looked at your issue',
        body: words,
        route: row.conversationId ? `/messages/${row.conversationId}` : null,
        metadata: { disputeId: row.id },
      });
    }
  }

  /**
   * The member who flagged the deal hears the outcome, in their **support** thread.
   *
   * Not the deal's own conversation, which is between the two members: a staff note about a
   * disagreement posted into the thread they are having with each other is staff joining the
   * argument. §5.17 says the flagger's support thread and that is the right place — it is the
   * thread they raised it in.
   */
  private async tellTheFlagger(
    row: { id: string; payerId: string; providerId: string; problemFlaggedById: string | null },
    words: string,
  ): Promise<void> {
    /**
     * Whoever raised it, and both of them when we do not know.
     *
     * `problemFlaggedById` is new, so a deal flagged before §5.17 landed has none — and the
     * fallback is deliberately to tell *both* parties rather than to guess. "We have looked into
     * your deal" sent to the member who did not complain is a confusing message; sent to neither,
     * it is a resolution nobody heard.
     */
    const flaggers = row.problemFlaggedById
      ? [row.problemFlaggedById]
      : [row.payerId, row.providerId];

    // Their support thread, which is where they raised it: `DealService.tellSupport` opens one
    // SUPPORT conversation per member, keyed on them rather than on the deal, so this is found by
    // member and not by context id.
    const threads = await this.database.supportThread.findMany({
      where: { memberId: { in: flaggers } },
      select: { conversationId: true, memberId: true },
    });

    for (const thread of threads) {
      await this.conversations.postSystemMessage(
        thread.conversationId,
        SystemMessageType.DEAL_PROBLEM_RESOLVED,
        words,
        { dealId: row.id },
      );
    }

    const routeFor = (userId: string) =>
      threads.find(thread => thread.memberId === userId)?.conversationId ?? null;

    for (const userId of flaggers) {
      this.notifications.raise({
        userId,
        kind: NotificationKind.DEAL,
        categoryCode: 'BOOKINGS',
        title: 'Circl has come back about your deal',
        body: words,
        route: routeFor(userId) ? `/messages/${routeFor(userId)}` : null,
        metadata: { dealId: row.id },
      });
    }
  }
}

const DISPUTE_SELECT = {
  id: true,
  subjectType: true,
  bookingId: true,
  enquiryId: true,
  raisedById: true,
  reasonCode: true,
  state: true,
  conversationId: true,
  assignedToId: true,
  resolvedById: true,
  resolvedAt: true,
  expectedResolutionAt: true,
  createdAt: true,
  raisedBy: { select: caseMemberSelect },
  booking: {
    select: {
      client: { select: caseMemberSelect },
      professional: { select: caseMemberSelect },
    },
  },
  enquiry: {
    select: {
      buyer: { select: caseMemberSelect },
      seller: { select: caseMemberSelect },
    },
  },
} satisfies Prisma.DisputeSelect;

const DEAL_SELECT = {
  id: true,
  track: true,
  amount: true,
  currency: true,
  problemNote: true,
  problemAt: true,
  problemState: true,
  problemFlaggedById: true,
  conversationId: true,
  payer: { select: caseMemberSelect },
  provider: { select: caseMemberSelect },
} satisfies Prisma.DealSelect;

type DisputeRow = Prisma.DisputeGetPayload<{ select: typeof DISPUTE_SELECT }>;
