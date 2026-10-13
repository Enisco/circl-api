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
    // The list's predicate is shared rather than copied (`AdminReportCaseService.whereFor`), which
    // is what this was waiting for: eleven filters reimplemented here would describe a different
    // set of cases from the screen the file came from, with nothing to say which was right.
    available: true,
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
    available: true,
    // Pages the log itself rather than querying strikes and suspensions again: "active" means a
    // strike that has not run out **or** a suspension that may never end, and that is exactly the
    // rule a second implementation gets wrong.
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
    available: true,
    /**
     * Every kind in one file — `targetType` is a column, so the file covers the lot: seventeen
     * queries, one per kind, concatenated in the registry's order so it reads grouped by type.
     *
     * Possible only because the four columns asked for are the four every kind has. The list's own
     * SQL joins authors, cities, categories and a per-kind status expression; none of that is
     * here, which is why this is a page per kind rather than seventeen bespoke builders.
     *
     * A **type-specific** filter is refused rather than ignored: `?published=true` means something
     * to guides and nothing to shops, and applying it across sixteen other kinds — or silently
     * dropping it — would produce a file nobody could explain.
     */
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
