import { AuditArea, AuditLog, Prisma } from '@prisma/client';
import { StaffRefView } from './admin-staff.serializer';
import { contentAdminUrl, memberAdminUrl, supportAdminUrl } from './admin-url';
import { AdminPrincipal } from '../common/admin-principal';

export interface AuditEntryView {
  id: string;
  occurredAt: string;
  actor: StaffRefView | null;
  actorRole: string | null;
  action: string;
  area: AuditArea;
  target: {
    type: string | null;
    id: string | null;
    label: string | null;
    adminUrl: string | null;
  };
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reasonCode: string | null;
  policySubtype: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}

/** The areas a `audit:read_area` holder may read: Trust & Safety's own work (R8). */
export const SCOPED_AREAS: AuditArea[] = [AuditArea.SAFETY, AuditArea.CONTENT];

/**
 * The audit scope, as a `where` fragment — applied in the query, never after it (R8).
 *
 * Post-filtering would mean the count and the page disagree, and a reader on page three of a list
 * whose rows were quietly dropped sees a short page and no explanation. It also means the rows
 * reach the process at all, which for a safeguarding entry is the thing being prevented.
 *
 * Three levels, in order of reach. `audit:read` is everything. `audit:read_area` is Trust &
 * Safety's two areas **plus the holder's own actions**, because somebody must always be able to
 * account for what they themselves did. `audit:read_self` is only their own.
 */
export const auditScopeFor = (actor: AdminPrincipal): Prisma.AuditLogWhereInput | null => {
  if (actor.permissions.has('audit:read')) return {};

  if (actor.permissions.has('audit:read_area')) {
    return { OR: [{ area: { in: SCOPED_AREAS } }, { actorId: actor.id }] };
  }

  if (actor.permissions.has('audit:read_self')) return { actorId: actor.id };

  return null;
};

const asRecord = (value: Prisma.JsonValue | null): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * One entry.
 *
 * `before`/`after` are passed through as stored, because the services that write them have already
 * masked what needed masking (S8.4: a contact edit stores the masked values plus a SHA-256 of the
 * full ones). Masking again here would be a second place for the rule to live, and the one that
 * forgot would be the one serving the trail.
 *
 * `ip` is **not** masked, unlike a member session's. This is the IP of the member of staff who took
 * the action, and the whole purpose of the entry is to be able to say who did it from where — an
 * audit trail that records a /24 cannot distinguish two people in an office.
 */
export const toAuditEntry = (
  row: AuditLog,
  actor: StaffRefView | null,
  label?: string | null,
): AuditEntryView => ({
  id: row.id,
  occurredAt: row.occurredAt.toISOString(),
  actor,
  actorRole: row.actorRole,
  action: row.action,
  area: row.area,
  target: {
    type: row.targetType,
    id: row.targetId,
    // Resolved from the live row for members (so anonymising an account needs no history
    // rewritten, which the append-only trigger would refuse anyway), and from the stored snapshot
    // for everything else.
    label: label ?? row.targetLabel,
    adminUrl: adminUrlFor(row.targetType, row.targetId),
  },
  before: asRecord(row.before),
  after: asRecord(row.after),
  reasonCode: row.reasonCode,
  policySubtype: row.policySubtype,
  reason: row.reason,
  metadata: asRecord(row.metadata),
  ip: row.ip,
  userAgent: row.userAgent,
});

const adminUrlFor = (targetType: string | null, targetId: string | null): string | null => {
  if (!targetType || !targetId) return null;

  if (targetType === 'MEMBER' || targetType === 'USER') return memberAdminUrl(targetId);

  return supportAdminUrl(targetType, targetId) ?? contentAdminUrl(targetType as never, targetId);
};
