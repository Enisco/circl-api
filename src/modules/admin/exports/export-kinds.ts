import { AdminExportKind } from '@prisma/client';

/** One column a kind can offer. */
export interface ExportColumn {
  /** What the portal asks for and what the header row says. One name, so a file explains itself. */
  key: string;
  /**
   * Whether this column carries a contact detail, and so needs `members:pii_reveal` on top of
   * `exports:csv` (§5.26, S8.3) — checked when the export is asked for **and again** when the
   * file is downloaded, because a permission can be taken away in between.
   */
  contact?: true;
}

export interface ExportKind {
  /** Any one of these, besides `exports:csv`, lets a staff member ask for this kind (§13.18). */
  listPermissions: string[];
  columns: ExportColumn[];
  /**
   * Whether the list behind the kind exists yet.
   *
   * §5.26 is P0 for members and P3 for the rest, and the rest are lists M2–M4 have not built. A
   * kind declared here but refused at request time is the honest answer: the portal learns the
   * name and the columns now, and gets a 422 naming the reason instead of an empty CSV that looks
   * like "no reports matched".
   */
  available: boolean;
  /** What a staff member is told when they ask for one that is not built. */
  pending?: string;
}

const CONTACT = { contact: true } as const;

/**
 * What each kind of export may contain (§13.18).
 *
 * The allowlist is the whole security boundary of this feature. An export is the one action in the
 * portal that takes member data past the masking and the read-audit and onto somebody's laptop, so
 * the set of columns is declared here, in one place, rather than inferred from whatever the caller
 * asked for — `SELECT` built from a request body is how an export of "members" comes to contain a
 * password hash.
 */
export const EXPORT_KINDS: Record<AdminExportKind, ExportKind> = {
  [AdminExportKind.MEMBERS]: {
    listPermissions: ['members:read'],
    available: true,
    columns: [
      { key: 'id' },
      { key: 'name' },
      { key: 'username' },
      { key: 'status' },
      { key: 'city' },
      { key: 'journeyStage' },
      { key: 'platform' },
      { key: 'createdAt' },
      { key: 'lastActiveAt' },
      { key: 'email', ...CONTACT },
      { key: 'phone', ...CONTACT },
    ],
  },

  [AdminExportKind.AUDIT]: {
    /**
     * R8's three levels, applied **by construction**: the builder calls the list's own
     * `exportWhere`, whose first clause is the caller's scope. That is the one thing that mattered
     * about waiting for the list to exist — an export built from a second implementation of the
     * scope would be a way around the audit scope, on the one path where rows leave as a file.
     */
    listPermissions: ['audit:read', 'audit:read_area', 'audit:read_self'],
    available: true,
    columns: [
      { key: 'occurredAt' },
      { key: 'actor' },
      { key: 'action' },
      { key: 'target' },
      { key: 'reasonCode' },
    ],
  },

  [AdminExportKind.REPORTS]: {
    listPermissions: ['reports:read'],
    available: false,
    // The list exists (§5.10). What this needs is the one thing an export of it cannot copy: the
    // list's `where` is built inline from eleven filters, so an export has to either share it or
    // reimplement it — and a reimplementation that drifts would hand somebody a CSV describing a
    // different set of cases from the screen they exported it from. Extracting it is the work.
    pending:
      'The report case export is not built yet: it needs the case list’s filter to be shared rather than copied.',
    columns: [
      { key: 'id' },
      { key: 'priority' },
      { key: 'state' },
      { key: 'reasonCodes' },
      { key: 'reportCount' },
      { key: 'firstReportedAt' },
      { key: 'decision' },
    ],
  },

  [AdminExportKind.ENFORCEMENT]: {
    listPermissions: ['moderation:read'],
    available: false,
    // Same shape of work as the reports export, and the same reason for not guessing at it.
    pending:
      'The enforcement export is not built yet: it needs the enforcement list’s filter to be shared rather than copied.',
    columns: [
      { key: 'member' },
      { key: 'kind' },
      { key: 'reasonCode' },
      { key: 'issuedAt' },
      { key: 'expiresAt' },
      { key: 'active' },
    ],
  },

  [AdminExportKind.CONTENT]: {
    listPermissions: ['content:read'],
    available: false,
    /**
     * The hardest of the five, and the reason is structural rather than scheduling: §5.7's list is
     * raw SQL **per content kind** — seventeen tables with different author columns, different
     * date columns and different status expressions — so "export the content list" is seventeen
     * queries, not one. It wants its own pass rather than a builder that quietly covers four kinds
     * and returns empty for the rest.
     */
    pending:
      'The content export is not built yet: §5.7’s list is a query per content kind, and an export has to cover all seventeen or none.',
    columns: [
      { key: 'targetType' },
      { key: 'targetId' },
      { key: 'visibilityState' },
      { key: 'createdAt' },
    ],
  },

  [AdminExportKind.SUPPORT_THREADS]: {
    /**
     * R7 travels with it: the builder calls the inbox's own `exportWhere`, which excludes Guard
     * threads for anybody without `guard:read`. A support agent exporting the inbox gets the inbox
     * they are allowed, not the one that exists.
     */
    listPermissions: ['support:read'],
    available: true,
    columns: [
      { key: 'conversationId' },
      { key: 'type' },
      { key: 'state' },
      { key: 'createdAt' },
      { key: 'firstResponseAt' },
    ],
  },

  [AdminExportKind.ANALYTICS_CHART]: {
    listPermissions: ['analytics:read', 'analytics:safety'],
    available: false,
    // Not "not yet": not ever, by design. A chart CSV is built in the browser from the payload the
    // staff member is already looking at, so no new data leaves the API; the download is audited
    // through `POST admin/audit/client-event` instead (§5.26).
    pending:
      'Chart CSVs are produced in the portal from the chart you already have, and audited with ' +
      '`analytics.chart_csv`. There is no server-side chart export.',
    columns: [],
  },
};

/** Whether a column name is one this kind offers. */
export const columnOf = (kind: AdminExportKind, key: string): ExportColumn | undefined =>
  EXPORT_KINDS[kind].columns.find(column => column.key === key);

/**
 * The columns asked for, in the kind's own order, de-duplicated.
 *
 * The kind's order rather than the request's, so two staff members who ask for the same columns
 * get the same file and a saved spreadsheet formula does not move a column between exports.
 */
export const orderColumns = (kind: AdminExportKind, keys: string[]): string[] =>
  EXPORT_KINDS[kind].columns.filter(column => keys.includes(column.key)).map(column => column.key);

/** The contact columns among those asked for, which is what `members:pii_reveal` gates. */
export const contactColumns = (kind: AdminExportKind, keys: string[]): string[] =>
  EXPORT_KINDS[kind].columns
    .filter(column => column.contact && keys.includes(column.key))
    .map(column => column.key);
