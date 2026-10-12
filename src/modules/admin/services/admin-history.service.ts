import { Injectable } from '@nestjs/common';
import { ReportTargetType } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { MediaService } from '@/modules/platform/shared';
import { staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';

/** One entry in §5.9's `ModerationHistoryItem`. */
export interface ModerationHistoryItem {
  at: string;
  kind: 'SCAN' | 'REPORT' | 'DECISION';
  actor: ReturnType<typeof toStaffRef> | null;
  summary: string;
  details: Record<string, unknown>;
}

/**
 * What happened to one piece of content, oldest first (§5.9's `ModerationHistoryItem`).
 *
 * Extracted from the report case service, which was the only thing that could tell this story —
 * and so the Guard case detail, which §5.12 says carries the same `history`, would have been a
 * second copy of the same three queries and the same staff-name resolution. The queue's own
 * `history` is a different contract (decisions only, newest first) and is deliberately left where
 * it is rather than bent to fit this one.
 */
@Injectable()
export class AdminHistoryService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
  ) {}

  /**
   * @param caseId when given, the reports grouped under that case are included. Without it the
   * reports are left out rather than guessed at: a target may have several cases over its life,
   * and folding all of them into one history would show a reviewer reports that belong to a
   * decision somebody else already took.
   */
  async forTarget(
    targetType: ReportTargetType,
    targetId: string,
    caseId?: string,
  ): Promise<ModerationHistoryItem[]> {
    const [scans, actions, reports] = await Promise.all([
      this.database.contentScan.findMany({
        where: { contentSafety: { targetType, targetId } },
        select: { createdAt: true, trigger: true, tier: true, finalScore: true, degraded: true },
        orderBy: { createdAt: 'asc' },
        take: 20,
      }),
      this.database.moderationAction.findMany({
        where: { targetType, targetId },
        select: { createdAt: true, decision: true, reason: true, actorId: true },
        orderBy: { createdAt: 'asc' },
        take: 20,
      }),
      caseId
        ? this.database.report.findMany({
            where: { caseId },
            select: { createdAt: true, reasonCode: true },
            orderBy: { createdAt: 'asc' },
            take: 50,
          })
        : Promise.resolve([]),
    ]);

    const staff = await this.database.user.findMany({
      where: { id: { in: [...new Set(actions.map(action => action.actorId))] } },
      select: staffRefSelect,
    });
    const byId = new Map(staff.map(person => [person.id, person]));

    return [
      ...scans.map(scan => ({
        at: scan.createdAt.toISOString(),
        kind: 'SCAN' as const,
        actor: null,
        summary: `Scanned (${scan.trigger.toLowerCase()}): ${scan.tier}${scan.degraded ? ', degraded' : ''}`,
        details: { finalScore: scan.finalScore },
      })),
      ...reports.map(report => ({
        at: report.createdAt.toISOString(),
        kind: 'REPORT' as const,
        // Never the reporter, at any permission level: this list is the one a member could one
        // day be shown, and §7.3 is explicit that they learn nothing about who reported them.
        actor: null,
        summary: `Reported: ${report.reasonCode}`,
        details: {},
      })),
      ...actions.map(action => {
        const person = byId.get(action.actorId);

        return {
          at: action.createdAt.toISOString(),
          kind: 'DECISION' as const,
          // A real `StaffRef`, because that is what the portal draws. A two-field stand-in of
          // `{ id, firstName }` satisfied nothing and would render as a blank avatar beside half
          // a name.
          actor: person ? toStaffRef(person, this.media.sign) : null,
          summary: `${action.decision}${action.reason ? `: ${action.reason}` : ''}`,
          details: {},
        };
      }),
    ].sort((a, b) => a.at.localeCompare(b.at));
  }
}
