import { Injectable, Logger } from '@nestjs/common';
import { EscalationState, Prisma, ReportReason } from '@prisma/client';
import { ApiErrorCode, ApiException, buildPageMeta } from '@/common';
import { PrismaService } from '@/infrastructure';
import { MediaService } from '@/modules/platform/shared';
import { ModerationService } from '@/modules/platform/moderation';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import {
  CreateEscalationDto,
  EscalationCategory,
  ListEscalationsDto,
  UpdateEscalationDto,
} from '../dtos/admin-escalation.dto';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';
import { staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';
import { toMemberRef } from '../serializers/admin-member.serializer';

/** Still work: the dashboard's `openEscalations` is this list (§5.10). */
export const OPEN_ESCALATION_STATES: EscalationState[] = [
  EscalationState.OPEN,
  EscalationState.ACKNOWLEDGED,
];

/**
 * Which report reason a category files under, and therefore how urgent the case is.
 *
 * The spec says "priority from category: SAFETY/SCAM → URGENT", and this is how that is true
 * without a second priority table: `SAFETY` and `SCAM` map onto the two reasons §7.1 already
 * treats as urgent whatever the content scored. So there is one rule about what is urgent, in
 * `report-priority.ts`, and this is a translation into its vocabulary rather than a rival copy of
 * it — if that table changes, escalations follow it.
 *
 * `ENFORCEMENT_REQUEST` is `OTHER` deliberately. It is a colleague asking for a suspension to be
 * considered, which is a judgement about a member rather than a claim about a post, and filing it
 * as something stronger would push cases up the queue on the strength of the asking.
 */
export const REASON_FOR: Record<EscalationCategory, ReportReason> = {
  HARASSMENT: ReportReason.HARASSMENT,
  SCAM: ReportReason.SCAM,
  SAFETY: ReportReason.SAFETY_CONCERN,
  ENFORCEMENT_REQUEST: ReportReason.OTHER,
  OTHER: ReportReason.OTHER,
};

/** What a `RESOLVED` escalation can still become: nothing. */
export const ALLOWED_FROM: Record<EscalationState, EscalationState[]> = {
  [EscalationState.OPEN]: [EscalationState.ACKNOWLEDGED, EscalationState.RESOLVED],
  [EscalationState.ACKNOWLEDGED]: [EscalationState.RESOLVED],
  [EscalationState.RESOLVED]: [],
};

/**
 * §5.10: Support hands a member's problem to Trust & Safety, and can see what happened to it.
 *
 * The thing this is **not** is a report case. A case is grouped by target, so three people
 * reporting one post is one piece of work; an escalation is one colleague asking another to look at
 * a *member*, and two about the same person are two asks with two answers. Folding them together
 * would silently lose the second.
 *
 * Where a target is given, both exist: the escalation is the conversation between colleagues and a
 * staff report files the content into the queue as actual work. That report is filed through the
 * member-facing path rather than written here, so §7.1's grouping, snapshotting, re-scan and
 * one-open-case-per-target race are the same ones a member's report goes through.
 */
@Injectable()
export class AdminEscalationService {
  private readonly logger = new Logger(AdminEscalationService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    private readonly moderation: ModerationService,
  ) {}

  async create(actor: AdminPrincipal, dto: CreateEscalationDto) {
    if (!!dto.targetType !== !!dto.targetId) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Send both the target type and its id, or neither.',
        {
          details: [
            {
              field: dto.targetType ? 'targetId' : 'targetType',
              message: 'Required when the other is given.',
            },
          ],
        },
      );
    }

    // visibility: staff checking the member exists before raising something about them.
    const member = await this.database.user.findUnique({
      where: { id: dto.memberId },
      select: { id: true },
    });

    if (!member) {
      throw ApiException.notFound('That member could not be found.', ApiErrorCode.NOT_FOUND);
    }

    // Filed **before** the escalation row, deliberately. If the second write failed we would
    // rather be left with a report in the queue and no escalation than an escalation claiming a
    // target that nobody is looking at: the first is a reviewer seeing work with less context, the
    // second is work that does not exist.
    //
    // Where the same staff member had already filed an open report about this target, `report`
    // answers with the case that first one is in rather than null — so the link is right whether
    // this is the first escalation about the content or the second, and whether the target was an
    // id or an anonymous post's token.
    const filed =
      dto.targetType && dto.targetId
        ? await this.moderation.report(actor.id, {
            targetType: dto.targetType,
            targetId: dto.targetId,
            reasonCode: REASON_FOR[dto.category],
            // The report's note is capped at 1,000 on the member path and this is the same column.
            // The full 2,000 lives on the escalation, which the case links back to.
            note: dto.note.slice(0, 1000),
          })
        : null;
    const reportCaseId = filed?.caseId ?? null;

    const { result } = await this.audit.mutate(
      (created: { id: string }) => ({
        action: 'escalation.created' as const,
        targetType: 'MEMBER' as const,
        targetId: dto.memberId,
        after: {
          escalationId: created.id,
          category: dto.category,
          reportCaseId,
          conversationId: dto.conversationId ?? null,
        },
        reason: dto.note,
      }),
      tx =>
        tx.escalation.create({
          data: {
            memberId: dto.memberId,
            raisedById: actor.id,
            category: dto.category,
            note: dto.note,
            conversationId: dto.conversationId ?? null,
            reportCaseId,
          },
          select: { id: true },
        }),
    );

    this.logger.log(
      `Escalation ${result.id} raised by ${actor.id} about ${dto.memberId} (${dto.category})` +
        (reportCaseId ? `, case ${reportCaseId}` : ''),
    );

    return this.findOne(result.id);
  }

  async list(actor: AdminPrincipal, query: ListEscalationsDto) {
    const where: Prisma.EscalationWhereInput = {
      state: { in: query.state?.length ? query.state : OPEN_ESCALATION_STATES },
      ...(query.mine ? { raisedById: actor.id } : {}),
      ...(query.memberId ? { memberId: query.memberId } : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.escalation.count({ where }),
      this.database.escalation.findMany({
        where,
        include: { member: { select: caseMemberSelect } },
        // Oldest first within the open states, because this is a list of people waiting. A
        // `createdAt desc` default would put the newest ask at the top and leave the one that has
        // been open longest at the bottom of page three.
        orderBy: [{ createdAt: 'asc' }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    const staff = await this.staffFor(rows);

    return {
      data: rows.map(row => this.toView(row, staff)),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        openCount: await this.database.escalation.count({
          where: { state: { in: OPEN_ESCALATION_STATES } },
        }),
      }),
    };
  }

  async findOne(id: string) {
    const row = await this.database.escalation.findUnique({
      where: { id },
      include: { member: { select: caseMemberSelect } },
    });

    if (!row) {
      throw ApiException.notFound('That escalation could not be found.', ApiErrorCode.NOT_FOUND);
    }

    return this.toView(row, await this.staffFor([row]));
  }

  async update(actor: AdminPrincipal, id: string, dto: UpdateEscalationDto) {
    const row = await this.database.escalation.findUnique({
      where: { id },
      select: { id: true, state: true, memberId: true, raisedById: true },
    });

    if (!row) {
      throw ApiException.notFound('That escalation could not be found.', ApiErrorCode.NOT_FOUND);
    }

    if (!ALLOWED_FROM[row.state].includes(dto.state)) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        row.state === EscalationState.RESOLVED
          ? 'That escalation is resolved. Raise a new one if there is something more to do.'
          : `An escalation cannot go from ${row.state} to ${dto.state}.`,
        { data: { from: row.state, to: dto.state, allowed: ALLOWED_FROM[row.state] } },
      );
    }

    const now = new Date();
    const resolving = dto.state === EscalationState.RESOLVED;

    await this.audit.mutate(
      {
        action: 'escalation.updated' as const,
        targetType: 'MEMBER' as const,
        targetId: row.memberId,
        before: { state: row.state },
        after: { escalationId: row.id, state: dto.state },
        reason: dto.resolutionNote ?? null,
      },
      async tx => {
        // Conditional on the state that was read, not just on the id. Two reviewers opening the
        // same escalation is the ordinary case, and without this the second write lands on top of
        // the first: an acknowledgement arriving after a resolution would reopen a closed
        // escalation with a resolution note still attached to it. The transition check above
        // cannot see that, because by then it has already read.
        const { count } = await tx.escalation.updateMany({
          where: { id: row.id, state: row.state },
          data: {
            state: dto.state,
            ...(resolving
              ? {
                  resolvedById: actor.id,
                  resolvedAt: now,
                  // Stored only with RESOLVED (§5.10): a resolution note on an acknowledgement
                  // would be an answer attached to something still open.
                  resolutionNote: dto.resolutionNote ?? null,
                }
              : { acknowledgedById: actor.id, acknowledgedAt: now }),
          },
        });

        if (!count) {
          throw ApiException.conflict(
            ApiErrorCode.INVALID_TRANSITION,
            'Somebody else answered that escalation while this was open. Reload it.',
            { data: { from: row.state, to: dto.state } },
          );
        }

        return { id: row.id };
      },
    );

    // §5.10 asks for the raiser to be notified in-portal. There is no staff notification channel
    // yet — §5.2 says as much about `alerts.assignedToMe`, which is "stored but not used until
    // staff notifications exist" — so the answer reaches them by the two surfaces that do exist:
    // `GET admin/escalations?mine=true`, which now carries who answered and what they said, and
    // the dashboard count, which drops as things are resolved. When the channel lands, this is
    // where the one line goes; it is not a silent omission.
    this.logger.log(`Escalation ${row.id} → ${dto.state} by ${actor.id}; raiser ${row.raisedById}`);

    return this.findOne(row.id);
  }

  /**
   * The escalations raised out of one support thread (§5.15's `linked`).
   *
   * Capped rather than paged. A thread with more than a handful of escalations on it is a thread
   * somebody should be reading rather than scrolling, and the detail payload is not the place to
   * discover that — the full list, filtered by member, is one endpoint away.
   */
  async forConversation(conversationId: string) {
    const rows = await this.database.escalation.findMany({
      where: { conversationId },
      include: { member: { select: caseMemberSelect } },
      orderBy: [{ createdAt: 'desc' }],
      take: 20,
    });

    if (!rows.length) return [];

    const staff = await this.staffFor(rows);

    return rows.map(row => this.toView(row, staff));
  }

  private async staffFor(rows: Array<{ raisedById: string }>) {
    const ids = [...new Set(rows.map(row => row.raisedById))];

    if (!ids.length) return new Map<string, Awaited<ReturnType<typeof this.staffRows>>[number]>();

    return new Map((await this.staffRows(ids)).map(person => [person.id, person]));
  }

  private staffRows(ids: string[]) {
    return this.database.user.findMany({ where: { id: { in: ids } }, select: staffRefSelect });
  }

  private toView(
    row: {
      id: string;
      member: Parameters<typeof toMemberRef>[0];
      raisedById: string;
      category: string;
      note: string;
      conversationId: string | null;
      reportCaseId: string | null;
      state: EscalationState;
      resolutionNote: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    staff: Map<string, Parameters<typeof toStaffRef>[0]>,
  ) {
    const person = staff.get(row.raisedById);

    return {
      id: row.id,
      member: toMemberRef(row.member, this.media.sign),
      raisedBy: person ? toStaffRef(person, this.media.sign) : null,
      category: row.category,
      note: row.note,
      conversationId: row.conversationId,
      reportCaseId: row.reportCaseId,
      state: row.state,
      resolutionNote: row.resolutionNote,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
