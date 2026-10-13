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
  /// `triggered/ready/failed`, so the three read as one lifecycle in the trail. The spec names the
  /// first one `member.data_export_triggered` (§5.5) and the portal filters on these strings.
  'member.data_export_triggered': AuditArea.MEMBERS,
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
  /// §5.7: a reviewer asked for a fresh scan. Recorded even though nothing changed on the content,
  /// because "who asked, and when" is what explains a verdict that moved without an edit.
  'content.rescanned': AuditArea.CONTENT,
  /// §5.7: a shop's compliance state. CONTENT rather than CONFIG — it is a decision about one
  /// seller, and SUSPENDED takes them out of browse and search.
  'store.compliance_changed': AuditArea.CONTENT,
  // §2.9: approving a listing in a gated profession. CONTENT rather than SAFETY — nobody broke a
  // rule, and the trail belongs beside the other decisions taken about a piece of content.
  // §2.9: changing which professions are gated. CONFIG, not CONTENT — it is a platform setting,
  // and it is the entry somebody will go looking for when a profession started or stopped holding
  // its listings and nobody remembers agreeing to it.
  'professions.gate_changed': AuditArea.CONFIG,
  /// §2.9: a reviewer opened a member's qualification paper. Recorded because these are identity
  /// documents and "who looked at my certificate" is a question a member is entitled to an answer
  /// to. Throttled to one entry per staff member per document per fifteen minutes, so paging
  /// through a PDF is one view rather than forty.
  'listing.document_viewed': AuditArea.CONTENT,
  'listing.review_approved': AuditArea.CONTENT,
  'listing.review_declined': AuditArea.CONTENT,
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
  /// Both transitions, under one action with `before.state` and `after.state` on the entry (§5.10
  /// names it `escalation.updated`). Acknowledging and resolving are the same act seen twice —
  /// somebody answering a colleague — and splitting them would mean reading two actions to follow
  /// one escalation.
  'escalation.updated': AuditArea.SAFETY,
  'safety.message_escalated': AuditArea.SAFETY,

  // ─── Support (SUPPORT) ─────────────────────────────────────────────────────
  'support.thread_assigned': AuditArea.SUPPORT,
  'support.thread_state_changed': AuditArea.SUPPORT,
  'support.replied': AuditArea.SUPPORT,
  'support.canned_created': AuditArea.SUPPORT,
  'support.canned_updated': AuditArea.SUPPORT,
  'thread.access_granted': AuditArea.SUPPORT,
  'thread.read': AuditArea.SUPPORT,
  /// §5.12's Guard thread read, kept apart from `thread.read` because the two are not the same
  /// act: one is a support conversation, the other is somebody's private disclosure, and the
  /// safety area is where that belongs.
  'guard.thread_read': AuditArea.SAFETY,
  'managed.updated': AuditArea.SUPPORT,
  'managed.brief_placed': AuditArea.SUPPORT,
  /// A brief moved state without a placement — matched, closed, or opened again (§7.7).
  'managed.brief_updated': AuditArea.SUPPORT,
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
  // §5.19's reorder. One entry for the whole move rather than one per term: the decision is the
  // order, and fourteen entries saying "sort changed" is a trail nobody reads.
  'taxonomy.reordered': AuditArea.CONFIG,
  'city.created': AuditArea.CONFIG,
  'city.updated': AuditArea.CONFIG,
  'config.updated': AuditArea.CONFIG,
  /// §5.21's app version policy. Its own action rather than a `config.updated` on the
  /// `appVersions` key, because this is the one setting that can lock every member out of the app
  /// — a force-update is an outage somebody chose — and it should be findable by name in the trail.
  'config.app_versions_updated': AuditArea.CONFIG,
  'support_resource.upserted': AuditArea.CONFIG,
  /// §5.20's deactivation. Its own action rather than an `upserted` with `isActive: false`,
  /// because taking a crisis line off the list is the one change here anybody would come looking
  /// for by name.
  'support_resource.deactivated': AuditArea.CONFIG,
  'job.run': AuditArea.CONFIG,

  // ─── Exports and analytics ─────────────────────────────────────────────────
  // `requested`, not `created`, because that is the moment worth recording: the file is built by a
  // worker minutes later, and the question the trail answers is who asked for which columns.
  'export.requested': AuditArea.EXPORTS,
  'export.downloaded': AuditArea.EXPORTS,
  'analytics.exported': AuditArea.ANALYTICS,

  // ─── The three the **client** may record (§5.23) ───────────────────────────
  //
  // A CSV built in the browser from data it already had leaves no request for the server to
  // audit, so without `POST admin/audit/client-event` the one act that takes member data off the
  // platform would be the one act with no trail. The allowlist is in the DTO and the area comes
  // from here rather than from the caller — a client that could name the area could file its own
  // act somewhere nobody holding `audit:read_area` would look.
  'analytics.chart_csv': AuditArea.ANALYTICS,
  'communications.stats_csv': AuditArea.COMMS,
  'config.versions_csv': AuditArea.CONFIG,

  // ─── Notes take the area of what they are about ────────────────────────────
  //
  // One note table serves members, cases, threads, disputes and deals (§4.7), so the area these
  // three register here is only the default — the note service passes the subject's own area, and
  // a note about a Guard case is a SAFETY entry rather than a MEMBERS one. Registered at MEMBERS
  // because that is the commonest subject and because an action needs *an* area to be a legal
  // action at all.
  'note.created': AuditArea.MEMBERS,
  'note.updated': AuditArea.MEMBERS,
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
