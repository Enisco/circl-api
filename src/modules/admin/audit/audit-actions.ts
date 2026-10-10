import { AuditArea } from '@prisma/client';

/**
 * Every action the audit trail can record, and which part of the portal it belongs to.
 *
 * A registry rather than free strings for two reasons. The audit filter dropdown is generated from
 * it, so a typo in an action name would otherwise create a category nobody can search for and a
 * filter nobody can select. And `area` decides who may read the entry: a reader with
 * `audit:read_area` sees SAFETY and CONTENT, and that is applied in the query, so an action whose
 * area was guessed at the call site would be readable by the wrong people.
 *
 * The prefix convention is the spec's (§4.1) and this map is its single expression: `member.*` is
 * MEMBERS except for enforcement, which is SAFETY, because that is what Trust & Safety needs to see
 * of each other's work.
 */
export const AUDIT_ACTIONS = {
  // ─── Staff authentication (AUTH) ───────────────────────────────────────────
  'auth.login_password_ok': AuditArea.AUTH,
  'auth.login_failed': AuditArea.AUTH,
  'auth.login_success': AuditArea.AUTH,
  'auth.logout': AuditArea.AUTH,
  'auth.mfa_enrolled': AuditArea.AUTH,
  'auth.password_changed': AuditArea.AUTH,
  'auth.recovery_codes_regenerated': AuditArea.AUTH,
  'auth.recovery_code_used': AuditArea.AUTH,
  'auth.sessions_revoked': AuditArea.AUTH,
  /// A refresh token presented after it was rotated away. Either a stolen token or a broken client,
  /// and the session is revoked either way.
  'auth.refresh_reuse': AuditArea.AUTH,
  /// Actor is null: nobody authenticated, which is the point of recording it.
  'auth.account_locked': AuditArea.AUTH,
  'staff.profile_updated': AuditArea.AUTH,
  /// Written by the bootstrap CLI, which has no actor to name.
  'staff.bootstrap_created': AuditArea.AUTH,

  // ─── Team (TEAM) ───────────────────────────────────────────────────────────
  'team.invite_created': AuditArea.TEAM,
  'team.invite_resent': AuditArea.TEAM,
  'team.invite_revoked': AuditArea.TEAM,
  'team.invite_accepted': AuditArea.TEAM,
  'team.role_changed': AuditArea.TEAM,
  'team.deactivated': AuditArea.TEAM,
  'team.reactivated': AuditArea.TEAM,
  'team.credentials_reset': AuditArea.TEAM,
  'team.mfa_reset': AuditArea.TEAM,
  'team.sessions_revoked': AuditArea.TEAM,

  // ─── Members (MEMBERS) ─────────────────────────────────────────────────────
  'member.updated': AuditArea.MEMBERS,
  'member.pii_reveal': AuditArea.MEMBERS,
  'member.sessions_revoked': AuditArea.MEMBERS,
  'member.login_unlocked': AuditArea.MEMBERS,
  'member.data_export': AuditArea.MEMBERS,
  'member.data_export_ready': AuditArea.MEMBERS,
  'member.data_export_failed': AuditArea.MEMBERS,
  'member.anonymised': AuditArea.MEMBERS,
  'member.bulk_action': AuditArea.MEMBERS,

  // ─── Enforcement (SAFETY, not MEMBERS) ─────────────────────────────────────
  // Deliberately SAFETY: Trust & Safety hold `audit:read_area` for SAFETY and CONTENT, and an
  // enforcement trail they cannot read is one they cannot check each other's work in.
  'member.suspended': AuditArea.SAFETY,
  'member.reactivated': AuditArea.SAFETY,
  'member.warned': AuditArea.SAFETY,
  'member.strike_revoked': AuditArea.SAFETY,
  'member.suspension_changed': AuditArea.SAFETY,
  /// Actor is null: the expiry job, not a person.
  'member.suspension_expired': AuditArea.SAFETY,

  // ─── Content (CONTENT) ─────────────────────────────────────────────────────
  'content.hidden': AuditArea.CONTENT,
  'content.removed': AuditArea.CONTENT,
  'content.restored': AuditArea.CONTENT,
  'guide.created': AuditArea.CONTENT,
  'guide.updated': AuditArea.CONTENT,
  'guide.published': AuditArea.CONTENT,
  'guide.unpublished': AuditArea.CONTENT,
  'store.updated': AuditArea.CONTENT,
  'listing.verification_changed': AuditArea.CONTENT,

  // ─── Safety (SAFETY) ───────────────────────────────────────────────────────
  'moderation.claimed': AuditArea.SAFETY,
  'moderation.released': AuditArea.SAFETY,
  'moderation.assigned': AuditArea.SAFETY,
  'moderation.decided': AuditArea.SAFETY,
  'report.case_created': AuditArea.SAFETY,
  'report.case_assigned': AuditArea.SAFETY,
  'report.case_decided': AuditArea.SAFETY,
  'report.case_reopened': AuditArea.SAFETY,
  'appeal.logged': AuditArea.SAFETY,
  'appeal.decided': AuditArea.SAFETY,
  'appeal.withdrawn': AuditArea.SAFETY,
  'guard.case_created': AuditArea.SAFETY,
  'guard.case_updated': AuditArea.SAFETY,
  'guard.replied': AuditArea.SAFETY,
  'risk_term.upserted': AuditArea.SAFETY,
  'risk_term.deactivated': AuditArea.SAFETY,
  'escalation.created': AuditArea.SAFETY,
  'escalation.resolved': AuditArea.SAFETY,
  'safety.message_escalated': AuditArea.SAFETY,

  // ─── Support (SUPPORT) ─────────────────────────────────────────────────────
  'support.thread_assigned': AuditArea.SUPPORT,
  'support.thread_state_changed': AuditArea.SUPPORT,
  'support.replied': AuditArea.SUPPORT,
  'thread.access_granted': AuditArea.SUPPORT,
  'thread.read': AuditArea.SUPPORT,
  'managed.updated': AuditArea.SUPPORT,
  'managed.brief_placed': AuditArea.SUPPORT,
  'dispute.updated': AuditArea.SUPPORT,
  'dispute.resolved': AuditArea.SUPPORT,
  'deal.problem_resolved': AuditArea.SUPPORT,

  // ─── Communications (COMMS) ────────────────────────────────────────────────
  'announcement.created': AuditArea.COMMS,
  'announcement.updated': AuditArea.COMMS,
  'announcement.sent': AuditArea.COMMS,
  'announcement.cancelled': AuditArea.COMMS,

  // ─── Configuration (CONFIG) ────────────────────────────────────────────────
  'taxonomy.upserted': AuditArea.CONFIG,
  'taxonomy.deactivated': AuditArea.CONFIG,
  'city.created': AuditArea.CONFIG,
  'city.updated': AuditArea.CONFIG,
  'config.updated': AuditArea.CONFIG,
  'support_resource.upserted': AuditArea.CONFIG,
  'job.run': AuditArea.CONFIG,

  // ─── Exports and analytics ─────────────────────────────────────────────────
  'export.created': AuditArea.EXPORTS,
  'export.downloaded': AuditArea.EXPORTS,
  'analytics.exported': AuditArea.ANALYTICS,

  // ─── Notes take the area of what they are about ────────────────────────────
  'note.added': AuditArea.MEMBERS,
  'note.deleted': AuditArea.MEMBERS,
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/** The area an action belongs to. Typed, so an unregistered name is a compile error. */
export const areaOf = (action: AuditAction): AuditArea => AUDIT_ACTIONS[action];

/** The filter dropdown's options, grouped by area. */
export const auditActionList = (): Array<{ action: AuditAction; area: AuditArea }> =>
  (Object.keys(AUDIT_ACTIONS) as AuditAction[]).map(action => ({
    action,
    area: AUDIT_ACTIONS[action],
  }));
