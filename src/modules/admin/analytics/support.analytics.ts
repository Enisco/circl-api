import { Injectable } from '@nestjs/common';
import { DisputeReason, DisputeState, Prisma } from '@prisma/client';
import { ApiErrorCode } from '@/common';
import { AnalyticsRunnerService } from './analytics-runner.service';
import { Chart, MatrixChart } from './chart.types';
import { toMatrix } from './breakdown';
import { ResolvedMemberFilter, ResolvedRange } from '../filters/member-filter.builder';
import { SupportFilters } from '../dtos/admin-analytics.dto';

/**
 * The charts whose source table the support milestone has not built yet.
 *
 * `support_threads` does not exist in any shape — not under another name, not as a view. Four of
 * this tab's five charts read nothing else, so they are returned as chart-level errors with the
 * code §5.25 names for it. Stated here as data rather than four near-identical methods, because
 * the interesting thing about them is that they are the same.
 */
const AWAITING_THREADS: Record<string, string> = {
  openedResolved: 'Support threads are not recorded yet.',
  responseTimes: 'Support threads are not recorded yet, so there are no response times.',
  threadsByType: 'Support threads are not recorded yet.',
  workloadPerAgent: 'Support threads are not recorded yet, so there is no workload to divide.',
};

/**
 * Support (§5.25).
 *
 * One chart of five, and the other four say why. Everything this tab is specified to measure comes
 * from `support_threads`, which the support milestone will create; the exception is
 * `disputesByReasonOutcome`, whose `disputes` table is live and carries real cases today.
 *
 * Shipping the tab with one real chart rather than refusing the whole tab is the deliberate
 * choice: the dispute matrix is useful now, `charts=` lets the portal fetch it alone, and §5.25
 * provides `NOT_AVAILABLE_YET` precisely so a page can be drawn before every panel on it can be
 * filled.
 */
@Injectable()
export class SupportAnalytics {
  constructor(private readonly runner: AnalyticsRunnerService) {}

  static readonly FILTER_SEMANTICS: Record<string, string> = {
    threadTypes: 'accepted and recorded, but reaches nothing until support threads exist.',
    assigneeIds: 'accepted and recorded, but reaches nothing until support threads exist.',
    memberFilters: 'narrow by the member who raised the dispute.',
  };

  charts(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SupportFilters,
  ): Record<string, () => Promise<Chart>> {
    return {
      ...Object.fromEntries(
        Object.entries(AWAITING_THREADS).map(([id, message]) => [
          id,
          () =>
            Promise.resolve<Chart>({
              kind: 'error',
              code: ApiErrorCode.NOT_AVAILABLE_YET,
              message,
            }),
        ]),
      ),
      disputesByReasonOutcome: () => this.disputesByReasonOutcome(filter, range, extra),
    };
  }

  /**
   * Why disputes are raised, against how they end.
   *
   * Rows are the reason the member gave, columns the state the dispute reached — including `OPEN`
   * and `IN_REVIEW`, which are not outcomes yet. Dropping them would make a chart of a recent
   * range read as though every dispute had been settled, and the unresolved column is the one a
   * support lead is looking for.
   *
   * `WITHDRAWN` is kept distinct from `RESOLVED`: a member thinking better of it and a dispute
   * somebody worked through are opposite facts about the same reason code.
   */
  private async disputesByReasonOutcome(
    filter: ResolvedMemberFilter,
    range: ResolvedRange,
    extra: SupportFilters,
  ): Promise<MatrixChart> {
    const parts: Prisma.Sql[] = [];

    if (extra.hasMemberFilters) {
      parts.push(
        Prisma.sql`EXISTS (
          SELECT 1 FROM "mv_member_dimensions" m
          WHERE m."user_id" = d."raised_by_id" AND ${filter.viewSql}
        )`,
      );
    }

    const rows = await this.runner.query(
      tx => tx.$queryRaw<Array<{ row: string; col: string; total: bigint }>>`
        SELECT d."reason_code"::text AS row, d."state"::text AS col, COUNT(*) AS total
        FROM "disputes" d
        WHERE d."created_at" >= ${range.fromInstant} AND d."created_at" < ${range.toInstant}
          ${parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty}
        GROUP BY 1, 2
      `,
    );

    return toMatrix(rows, {
      // Disputes, not members: one member can raise several, and a dispute is the unit of work.
      unit: 'count',
      rows: Object.values(DisputeReason).map(reason => ({
        key: reason,
        label: titleise(reason),
      })),
      cols: Object.values(DisputeState).map(state => ({ key: state, label: titleise(state) })),
    });
  }
}

const titleise = (code: string): string =>
  code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');
