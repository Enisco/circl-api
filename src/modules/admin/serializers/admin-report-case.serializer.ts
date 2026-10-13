import {
  ModerationDecision,
  RiskCategory,
  ReportCasePriority,
  ReportCaseState,
  ReportReason,
  ReportTargetType,
  RiskLevel,
  UserAccountStatus,
} from '@prisma/client';
import { UrlSigner } from '@/modules/platform/shared';
import { AdminContentPageView } from './admin-content.serializer';
import { MemberRefView, toMemberRef } from './admin-member.serializer';
import { StaffRefView, toStaffRef } from './admin-staff.serializer';

/**
 * §5.10's `ReportCaseRow` and `ReportCaseDetail`.
 *
 * The masking rule (R9) is the one thing worth saying twice: a reporter's identity and the note
 * they typed are only in the detail, and only for a caller allowed to see them. A member who
 * reports somebody has to be able to trust that the person they reported will never be shown who
 * did it, and the reviewer's screen is the one place that could leak it.
 */

export interface CaseTargetView {
  targetType: ReportTargetType;
  targetId: string;
  /** A line a reviewer can recognise the thing by, from the content itself. */
  title: string | null;
  /** Whether the content has already been taken down. */
  removed: boolean;
  /** For a MESSAGE or CONVERSATION target, the thread §5.6 would open. */
  conversationId: string | null;
}

type MemberSource = Parameters<typeof toMemberRef>[0];
type StaffSource = Parameters<typeof toStaffRef>[0];

export interface CaseRowSource {
  id: string;
  targetType: ReportTargetType;
  targetId: string;
  priority: ReportCasePriority;
  state: ReportCaseState;
  reasonCodes: ReportReason[];
  reportCount: number;
  uniqueReporterCount: number;
  riskLevel: RiskLevel;
  riskScore: number;
  dueAt: Date;
  firstReportedAt: Date;
  lastReportedAt: Date;
  decidedAt: Date | null;
  decision: ModerationDecision | null;
  decisionNote: string | null;
  claimedAt: Date | null;
  reopenedAt: Date | null;
  queueItemId: string | null;
  targetUser: MemberSource | null;
  assignedTo: StaffSource | null;
}

export interface CaseRowView {
  id: string;
  target: CaseTargetView;
  targetMember: MemberRefView | null;
  priority: ReportCasePriority;
  state: ReportCaseState;
  reasonCodes: ReportReason[];
  reportCount: number;
  uniqueReporterCount: number;
  risk: { level: RiskLevel; finalScore: number; category: RiskCategory | null };
  dueAt: string;
  /** Computed rather than stored: a case is overdue until somebody decides it, and then it is not. */
  overdue: boolean;
  assignedTo: StaffRefView | null;
  claimedAt: string | null;
  firstReportedAt: string;
  lastReportedAt: string;
  decidedAt: string | null;
  decision: ModerationDecision | null;
  decisionNote: string | null;
  reopenedAt: string | null;
  queueItemId: string | null;
}

const LIVE: readonly ReportCaseState[] = [ReportCaseState.OPEN, ReportCaseState.IN_REVIEW];

export const toCaseRow = (
  source: CaseRowSource,
  target: CaseTargetView,
  sign: UrlSigner,
  now = new Date(),
  riskCategory: RiskCategory | null = null,
): CaseRowView => ({
  id: source.id,
  target,
  targetMember: source.targetUser ? toMemberRef(source.targetUser, sign) : null,
  priority: source.priority,
  state: source.state,
  reasonCodes: source.reasonCodes,
  reportCount: source.reportCount,
  uniqueReporterCount: source.uniqueReporterCount,
  risk: {
    level: source.riskLevel,
    finalScore: source.riskScore,
    // The case's own category is not stored: the reports disagree about it by nature, and the
    // scanner's category lives on the content's verdict. A row reads it as null — a list does not
    // join the safety table — and the detail passes the scan's, which is the one a reviewer wants.
    category: riskCategory,
  },
  dueAt: source.dueAt.toISOString(),
  overdue: LIVE.includes(source.state) && source.dueAt.getTime() < now.getTime(),
  assignedTo: source.assignedTo ? toStaffRef(source.assignedTo, sign) : null,
  claimedAt: source.claimedAt?.toISOString() ?? null,
  firstReportedAt: source.firstReportedAt.toISOString(),
  lastReportedAt: source.lastReportedAt.toISOString(),
  decidedAt: source.decidedAt?.toISOString() ?? null,
  decision: source.decision,
  decisionNote: source.decisionNote,
  reopenedAt: source.reopenedAt?.toISOString() ?? null,
  queueItemId: source.queueItemId,
});

export interface CaseReportSource {
  id: string;
  reasonCode: ReportReason;
  note: string | null;
  state: string;
  createdAt: Date;
  outcomeNotifiedAt: Date | null;
  snapshot: unknown;
  reporter: MemberSource | null;
}

export interface CaseDetailExtras {
  reports: CaseReportSource[];
  /** The content as it is now (§5.7's page). Null for a member, conversation or message target. */
  liveContent: AdminContentPageView | null;
  appeals: unknown[];
  /** The scanner's category for the content, which the case itself does not store. */
  riskCategory: RiskCategory | null;
  targetMemberHistory: {
    activeStrikes: number;
    priorCases: number;
    priorActioned: number;
    accountAgeDays: number;
    suspensions: number;
  } | null;
  relatedConversationId: string | null;
  history: Array<{
    at: string;
    kind: 'SCAN' | 'DECISION' | 'STAFF_ACTION' | 'REPORT' | 'AUTHOR_EDIT';
    actor: StaffRefView | MemberRefView | null;
    summary: string;
    details: Record<string, unknown>;
  }>;
}

export const toCaseDetail = (
  source: CaseRowSource,
  target: CaseTargetView,
  extras: CaseDetailExtras,
  sign: UrlSigner,
  /** R9: whether this caller may see who reported it and what they wrote. */
  canSeeReporters: boolean,
  now = new Date(),
) => ({
  ...toCaseRow(source, target, sign, now, extras.riskCategory),
  reports: extras.reports.map(report => ({
    id: report.id,
    reporter: canSeeReporters && report.reporter ? toMemberRef(report.reporter, sign) : null,
    reasonCode: report.reasonCode,
    note: canSeeReporters ? report.note : null,
    state: report.state,
    createdAt: report.createdAt.toISOString(),
    outcomeNotifiedAt: report.outcomeNotifiedAt?.toISOString() ?? null,
    snapshot: toSnapshot(report.snapshot),
  })),
  liveContent: extras.liveContent,
  appeals: extras.appeals,
  targetMemberHistory: extras.targetMemberHistory,
  relatedConversationId: extras.relatedConversationId,
  history: extras.history,
});

/**
 * The report's evidence, under the one field name §5.10 gives it.
 *
 * The snapshot is written at report time and the writers do not agree on what to call the words:
 * the member-facing report path stores `text`, the message paths store `body`. Rather than
 * migrating rows that are evidence — a snapshot is kept precisely so that nobody edits it — the
 * read normalises, and leaves whatever else each writer put there in place beside it.
 */
const toSnapshot = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const snapshot = value as Record<string, unknown>;
  const text = snapshot.text ?? snapshot.body ?? snapshot.content ?? null;

  return { ...snapshot, text: typeof text === 'string' ? text : null };
};

/** The raw report log (§5.10, `ReportRow`). */
export const toReportRow = (
  source: {
    id: string;
    caseId: string | null;
    targetType: ReportTargetType;
    targetId: string;
    reasonCode: ReportReason;
    state: string;
    createdAt: Date;
    reporter: MemberSource | null;
  },
  sign: UrlSigner,
  canSeeReporters: boolean,
) => ({
  id: source.id,
  caseId: source.caseId,
  reporter: canSeeReporters && source.reporter ? toMemberRef(source.reporter, sign) : null,
  targetType: source.targetType,
  targetId: source.targetId,
  reasonCode: source.reasonCode,
  state: source.state,
  createdAt: source.createdAt.toISOString(),
});

/** Kept here so the service and the serializer agree on what a member ref needs selected. */
export const caseMemberSelect = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  avatarKey: true,
  profileImageUrl: true,
  status: true,
  isAnonymised: true,
} satisfies Record<string, true>;

export type CaseMemberRow = {
  id: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  avatarKey: string | null;
  profileImageUrl: string | null;
  status: UserAccountStatus;
  isAnonymised: boolean;
};
