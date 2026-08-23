import { Injectable } from '@nestjs/common';
import { GuardThreadState, Prisma, RiskLevel, TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiException, buildPageMeta } from '@/common';
import { TaxonomyService, authorSelect, toAuthorView } from '../../shared';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import { ListGuardCasesDto, UpdateGuardCaseDto } from '../dtos/admin.dto';

const RISK_ORDER: RiskLevel[] = [
  RiskLevel.CRITICAL,
  RiskLevel.HIGH,
  RiskLevel.MEDIUM,
  RiskLevel.LOW,
  RiskLevel.NONE,
];

/**
 * The Guard case queue, kept separate from ordinary moderation.
 *
 * These are members who chose a private channel over a public post, often about
 * something they are frightened of. Working that is a different job from
 * triaging spam, and the `guard:read` / `guard:manage` permissions exist so it
 * can be a different set of people.
 */
@Injectable()
export class AdminGuardService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly conversations: ConversationFactoryService,
  ) {}

  async list(query: ListGuardCasesDto) {
    const where: Prisma.GuardThreadWhereInput = {
      ...(query.state && query.state !== 'ALL'
        ? { state: query.state as GuardThreadState }
        : { state: { in: [GuardThreadState.OPEN, GuardThreadState.IN_PROGRESS] } }),
      ...(query.minRiskLevel
        ? { riskLevel: { in: RISK_ORDER.slice(0, RISK_ORDER.indexOf(query.minRiskLevel) + 1) } }
        : {}),
    };

    const [total, rows, categoryLabels] = await Promise.all([
      this.database.guardThread.count({ where }),
      this.database.guardThread.findMany({
        where,
        include: {
          user: { select: authorSelect },
          assignedTo: { select: authorSelect },
        },
        // Urgency first, always. This ordering is the product promise.
        orderBy: [{ riskLevel: 'desc' }, { riskScore: 'desc' }, { createdAt: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.taxonomy.labels(TaxonomyKind.COMMUNITY_CATEGORY),
    ]);

    const urgentCount = await this.database.guardThread.count({
      where: {
        state: { in: [GuardThreadState.OPEN, GuardThreadState.IN_PROGRESS] },
        riskLevel: { in: [RiskLevel.HIGH, RiskLevel.CRITICAL] },
      },
    });

    return {
      data: rows.map(row => ({
        id: row.id,
        subject: row.subject,
        category: row.categoryCode
          ? { code: row.categoryCode, label: categoryLabels.get(row.categoryCode) ?? row.categoryCode }
          : null,
        state: row.state,
        member: toAuthorView(row.user),
        assignedTo: row.assignedTo ? toAuthorView(row.assignedTo) : null,
        risk: {
          level: row.riskLevel,
          category: row.riskCategory,
          score: row.riskScore,
          signals: row.riskSignals ?? [],
        },
        conversationId: row.conversationId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      // The number that should never sit. A dashboard that does not surface it
      // separately buries the whole point of ranking by urgency.
      meta: buildPageMeta(query, total, { urgentCount }),
    };
  }

  async findOne(id: string) {
    const thread = await this.database.guardThread.findUnique({
      where: { id },
      include: { user: { select: authorSelect }, assignedTo: { select: authorSelect } },
    });

    if (!thread) throw ApiException.notFound('That case could not be found.');

    return {
      id: thread.id,
      subject: thread.subject,
      state: thread.state,
      member: toAuthorView(thread.user),
      assignedTo: thread.assignedTo ? toAuthorView(thread.assignedTo) : null,
      risk: {
        level: thread.riskLevel,
        category: thread.riskCategory,
        score: thread.riskScore,
        signals: thread.riskSignals ?? [],
      },
      conversationId: thread.conversationId,
      createdAt: thread.createdAt.toISOString(),
    };
  }

  /**
   * Assign or move a case. Assigning also joins the staff member to the thread,
   * because a case you cannot read is a case you cannot work.
   */
  async update(adminId: string, id: string, dto: UpdateGuardCaseDto) {
    const thread = await this.database.guardThread.findUnique({ where: { id } });

    if (!thread) throw ApiException.notFound('That case could not be found.');

    const assignedToId = dto.assignedToId === undefined ? thread.assignedToId : dto.assignedToId;

    await this.database.guardThread.update({
      where: { id },
      data: {
        ...(dto.state ? { state: dto.state as GuardThreadState } : {}),
        assignedToId,
        ...(dto.state === 'RESOLVED' || dto.state === 'CLOSED' ? { resolvedAt: new Date() } : {}),
      },
    });

    if (assignedToId && thread.conversationId) {
      await this.conversations.addStaff(thread.conversationId, [assignedToId]);
    }

    void adminId;

    return this.findOne(id);
  }
}
