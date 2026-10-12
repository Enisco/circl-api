import { AdminExport, AdminExportKind, AdminExportState } from '@prisma/client';
import { StaffRefView } from '../serializers/admin-staff.serializer';

export interface ExportView {
  id: string;
  kind: AdminExportKind;
  state: AdminExportState;
  rowCount: number | null;
  columns: string[];
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  /** Why it failed, in a sentence the staff member can act on. Null unless `state` is FAILED. */
  error: string | null;
  /** Only on `GET admin/exports?all=true`, and only for a caller with `exports:read_all`. */
  requestedBy?: StaffRefView;
}

/** What was asked for, as stored. */
export interface ExportParams {
  columns: string[];
  filters: Record<string, unknown>;
}

export const paramsOf = (row: Pick<AdminExport, 'params'>): ExportParams => {
  const params = (row.params ?? {}) as { columns?: unknown; filters?: unknown };

  return {
    columns: Array.isArray(params.columns) ? params.columns.map(String) : [],
    filters:
      params.filters && typeof params.filters === 'object' && !Array.isArray(params.filters)
        ? (params.filters as Record<string, unknown>)
        : {},
  };
};

/**
 * One export.
 *
 * `storageKey` is deliberately absent. The key is not a secret, but publishing it invites a client
 * to build its own URL for the object, and the five-minute signature on `POST :id/download` — and
 * the audit entry that goes with it — is the only way the file is meant to be reached (§5.26).
 */
export const toExportView = (row: AdminExport, requestedBy?: StaffRefView | null): ExportView => ({
  id: row.id,
  kind: row.kind,
  state: row.state,
  rowCount: row.rowCount,
  columns: paramsOf(row).columns,
  createdAt: row.createdAt.toISOString(),
  completedAt: row.completedAt?.toISOString() ?? null,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  error: row.error,
  ...(requestedBy ? { requestedBy } : {}),
});
