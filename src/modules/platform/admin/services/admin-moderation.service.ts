import { Injectable } from '@nestjs/common';
import {
  ModerationDecision,
  ModerationQueueState,
  Prisma,
  ReportTargetType,
  RiskLevel,
  UserAccountStatus,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, buildPageMeta } from '@/common';
import { authorSelect, toAuthorView } from '../../shared';
import { DecideQueueItemDto, ListQueueDto, SuspendUserDto } from '../dtos/admin.dto';

/** Ordering weight per band, so CRITICAL always outranks a heavily-reported spam post. */
const RISK_WEIGHT: Record<RiskLevel, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  NONE: 0,
};

/**
 * The admin queue.
 *
 * "Sensitive requests are ranked by urgency and pushed to the top of the admin
 * queue with an alert." That ranking is the whole reason this is one queue rather
 * than four: a member disclosing domestic abuse must not be sitting behind a
 * backlog of spam reports, and they only cannot be if both are in the same
 * ordered list.
 *
 * Every decision writes an append-only ModerationAction. A safeguarding decision
 * nobody can review afterwards is not a decision anyone should be making.
 */
@Injectable()
export class AdminModerationService {
  constructor(private readonly database: PrismaService) {}

  async listQueue(query: ListQueueDto, adminId: string) {
    const where: Prisma.ModerationQueueItemWhereInput = {
      state: query.state ?? ModerationQueueState.PENDING,
      ...(query.type ? { type: query.type } : {}),
      ...(query.mine ? { assignedToId: adminId } : {}),
      ...(query.minRiskLevel
        ? {
            riskLevel: {
              in: (Object.keys(RISK_WEIGHT) as RiskLevel[]).filter(
                level => RISK_WEIGHT[level] >= RISK_WEIGHT[query.minRiskLevel!],
              ),
            },
          }
        : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.moderationQueueItem.count({ where }),
      this.database.moderationQueueItem.findMany({
        where,
        include: {
          subjectUser: { select: authorSelect },
          assignedTo: { select: authorSelect },
        },
        // Urgency first, then how many people reported it, then age. An old item
        // never outranks a critical new one.
        orderBy: [{ riskLevel: 'desc' }, { riskScore: 'desc' }, { createdAt: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
    ]);

    const content = await this.resolveContent(rows);

    return {
      data: rows.map(row => ({
        id: row.id,
        type: row.type,
        state: row.state,
        targetType: row.targetType,
        targetId: row.targetId,
        subject: row.subjectUser ? toAuthorView(row.subjectUser) : null,
        assignedTo: row.assignedTo ? toAuthorView(row.assignedTo) : null,
        risk: {
          level: row.riskLevel,
          category: row.riskCategory,
          score: row.riskScore,
          // The matched phrases, so "why was this escalated" has an answer a
          // reviewer can read rather than a number they have to trust.
          signals: row.riskSignals ?? [],
        },
        summary: row.summary,
        content: content.get(`${row.targetType}:${row.targetId}`) ?? null,
        reportCount: row.reportId ? 1 : 0,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: buildPageMeta(query, total, {
        // What an alert would be raised on: the count that should never sit.
        urgentCount: await this.database.moderationQueueItem.count({
          where: {
            state: ModerationQueueState.PENDING,
            riskLevel: { in: [RiskLevel.HIGH, RiskLevel.CRITICAL] },
          },
        }),
      }),
    };
  }

  /**
   * Approve or reject one item.
   *
   * The anonymous-post queue and the reported-content queue share this, because
   * the decision is the same shape: leave it, remove it, or act on the author.
   * "Anonymous Post — toggle to hide identity. Still moderated" is what makes
   * every anonymous post arrive here whether or not anyone reported it.
   */
  async decide(adminId: string, id: string, dto: DecideQueueItemDto) {
    const item = await this.database.moderationQueueItem.findUnique({ where: { id } });

    if (!item) throw ApiException.notFound('That queue item could not be found.');

    if (item.state === ModerationQueueState.RESOLVED) {
      throw ApiException.conflict(ApiErrorCode.CONFLICT, 'That item has already been decided.', {
        data: { decision: item.decision, decidedAt: item.decidedAt },
      });
    }

    await this.database.$transaction(async tx => {
      if (dto.decision === ModerationDecision.REMOVE_CONTENT) {
        await this.softDeleteTarget(tx, item.targetType, item.targetId);
      }

      if (dto.decision === ModerationDecision.SUSPEND_AUTHOR && item.subjectUserId) {
        await tx.user.update({
          where: { id: item.subjectUserId },
          data: { status: UserAccountStatus.SUSPENDED },
        });
        await tx.userSession.updateMany({
          where: { userId: item.subjectUserId },
          data: { isActive: false, revokedAt: new Date() },
        });
      }

      await tx.moderationQueueItem.update({
        where: { id },
        data: {
          state: ModerationQueueState.RESOLVED,
          decision: dto.decision,
          decisionNote: dto.reason ?? null,
          decidedById: adminId,
          decidedAt: new Date(),
        },
      });

      if (item.reportId) {
        await tx.report.update({
          where: { id: item.reportId },
          data: {
            state: dto.decision === ModerationDecision.NO_ACTION ? 'DISMISSED' : 'ACTIONED',
            decision: dto.decision,
            decisionNote: dto.reason ?? null,
            reviewedById: adminId,
            reviewedAt: new Date(),
          },
        });
      }

      // Append-only. This is the record that makes the queue reviewable.
      await tx.moderationAction.create({
        data: {
          actorId: adminId,
          targetType: item.targetType,
          targetId: item.targetId,
          decision: dto.decision,
          reason: dto.reason ?? null,
          metadata: { queueItemId: id, queueType: item.type },
        },
      });
    });

    return { id, decision: dto.decision, state: ModerationQueueState.RESOLVED };
  }

  async claim(adminId: string, id: string) {
    const item = await this.database.moderationQueueItem.findUnique({ where: { id } });

    if (!item) throw ApiException.notFound('That queue item could not be found.');

    if (item.assignedToId && item.assignedToId !== adminId) {
      // Two people working the same disclosure is worse than one, so a claim by
      // someone else is a conflict rather than a silent overwrite.
      throw ApiException.conflict(
        ApiErrorCode.CONFLICT,
        'Someone else is already working on this.',
        { data: { assignedToId: item.assignedToId } },
      );
    }

    await this.database.moderationQueueItem.update({
      where: { id },
      data: { assignedToId: adminId, state: ModerationQueueState.IN_REVIEW },
    });

    return { id, assignedToId: adminId, state: ModerationQueueState.IN_REVIEW };
  }

  async setUserStatus(adminId: string, userId: string, dto: SuspendUserDto) {
    const user = await this.database.user.findUnique({ where: { id: userId } });

    if (!user || user.isAnonymised) throw ApiException.notFound('That member could not be found.');

    await this.database.$transaction(async tx => {
      await tx.user.update({
        where: { id: userId },
        data: { status: dto.status as UserAccountStatus },
      });

      if (dto.status === 'SUSPENDED') {
        // Revoked immediately: a suspension that leaves a live session running is
        // not a suspension.
        await tx.userSession.updateMany({
          where: { userId },
          data: { isActive: false, revokedAt: new Date() },
        });
      }

      await tx.moderationAction.create({
        data: {
          actorId: adminId,
          targetType: ReportTargetType.USER,
          targetId: userId,
          decision:
            dto.status === 'SUSPENDED'
              ? ModerationDecision.SUSPEND_AUTHOR
              : ModerationDecision.NO_ACTION,
          reason: dto.reason ?? null,
        },
      });
    });

    return { userId, status: dto.status };
  }

  /** The audit trail for one piece of content or one member. */
  async actionsFor(targetType: ReportTargetType, targetId: string) {
    const actions = await this.database.moderationAction.findMany({
      where: { targetType, targetId },
      include: { actor: { select: authorSelect } },
      orderBy: { createdAt: 'desc' },
    });

    return actions.map(action => ({
      id: action.id,
      actor: toAuthorView(action.actor),
      decision: action.decision,
      reason: action.reason,
      createdAt: action.createdAt.toISOString(),
    }));
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * The actual text a reviewer needs to see, fetched per target type.
   *
   * A queue row with only an id in it forces a reviewer to open another screen to
   * decide anything, which is how a backlog forms.
   */
  private async resolveContent(items: Array<{ targetType: ReportTargetType; targetId: string }>) {
    const byType = new Map<ReportTargetType, string[]>();

    for (const item of items) {
      const list = byType.get(item.targetType) ?? [];

      list.push(item.targetId);
      byType.set(item.targetType, list);
    }

    const result = new Map<string, Record<string, unknown>>();

    const load = async (
      type: ReportTargetType,
      loader: (ids: string[]) => Promise<Array<{ id: string } & Record<string, unknown>>>,
    ) => {
      const ids = byType.get(type);

      if (!ids?.length) return;

      for (const row of await loader(ids)) {
        result.set(`${type}:${row.id}`, row);
      }
    };

    await Promise.all([
      load(ReportTargetType.REQUEST, ids =>
        this.database.communityRequest.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true, description: true, visibility: true, deletedAt: true },
        }),
      ),
      load(ReportTargetType.UPDATE, ids =>
        this.database.communityUpdate.findMany({
          where: { id: { in: ids } },
          select: { id: true, content: true, visibility: true, deletedAt: true },
        }),
      ),
      load(ReportTargetType.OFFER, ids =>
        this.database.communityOffer.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true, description: true, deletedAt: true },
        }),
      ),
      load(ReportTargetType.GROUP_POST, ids =>
        this.database.groupPost.findMany({
          where: { id: { in: ids } },
          select: { id: true, content: true, deletedAt: true },
        }),
      ),
      load(ReportTargetType.RESPONSE, ids =>
        this.database.requestResponse.findMany({
          where: { id: { in: ids } },
          select: { id: true, content: true, deletedAt: true },
        }),
      ),
      load(ReportTargetType.STORE_ITEM, ids =>
        this.database.storeItem.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, description: true, deletedAt: true },
        }),
      ),
    ]);

    return result;
  }

  private async softDeleteTarget(
    tx: Prisma.TransactionClient,
    targetType: ReportTargetType,
    targetId: string,
  ) {
    const now = { deletedAt: new Date() };

    switch (targetType) {
      case ReportTargetType.REQUEST:
        await tx.communityRequest.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.UPDATE:
        await tx.communityUpdate.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.OFFER:
        await tx.communityOffer.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.RESPONSE:
        await tx.requestResponse.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.UPDATE_REPLY:
        await tx.updateReply.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.GROUP_POST:
        await tx.groupPost.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.GROUP_POST_REPLY:
        await tx.groupPostReply.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.GUIDE:
        await tx.guide.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.GROUP:
        await tx.group.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.STORE:
        await tx.store.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.STORE_ITEM:
        await tx.storeItem.updateMany({
          where: { id: targetId },
          data: { ...now, isAvailable: false },
        });
        break;
      case ReportTargetType.MESSAGE:
        // Tombstoned like any other deletion, so the thread does not renumber.
        await tx.message.updateMany({ where: { id: targetId }, data: { ...now, body: null } });
        break;
      default:
        break;
    }
  }
}
