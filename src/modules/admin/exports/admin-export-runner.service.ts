import { Injectable, Logger } from '@nestjs/common';
import { AdminExport, AdminExportKind, AdminExportState } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { PrismaService } from '@/infrastructure';
import { SYSTEM_CONFIG_KEYS } from '@/common';
import { StorageProvider, SystemConfigService } from '@/modules/platform/shared';
import { ListMembersDto } from '../dtos/analytics-filter.dto';
import { MemberExportRow, AdminMemberService } from '../services/admin-member.service';
import { CSV_BOM, CSV_MIME, csvRow } from './export-csv';
import { paramsOf } from './admin-export.serializer';

/** How many members are read per round trip while a file is built. */
const PAGE_SIZE = 500;

/**
 * The most rows one export may contain, from `exports.maxRows` (§13.17, default 100,000).
 *
 * A limit rather than a truncation: a CSV silently cut off is a wrong answer that looks like a
 * right one, and the staff member who exported "all members" to count them would never know. Told
 * to narrow the filters instead, which is the same answer the member list gives for a page too
 * deep. Read from config rather than hard-coded, because the key exists for exactly this and a
 * constant beside it would be the number that is actually in force.
 */

/** Seven days, as §12's settings table and S12.2 both say. */
const FILE_TTL_DAYS = 7;

/** Raised when the file would be larger than anybody wants to open. */
class ExportTooLarge extends Error {
  constructor(cap: number) {
    super(
      `That export would be more than ${cap.toLocaleString('en-GB')} rows. Narrow the filters and try again.`,
    );
  }
}

/** A cell, per column, for a MEMBERS export (§13.18). */
const MEMBER_CELLS: Record<string, (row: MemberExportRow) => unknown> = {
  id: row => row.view.id,
  name: row => [row.view.firstName, row.view.lastName].filter(Boolean).join(' '),
  username: row => row.view.username,
  status: row => row.view.status,
  city: row => row.view.city?.name ?? null,
  // The label staff read, falling back to the code where the taxonomy has no label for it: a
  // column of blanks would be worse than a column of codes.
  journeyStage: row => row.view.journeyStage?.label ?? row.view.journeyStage?.code ?? null,
  platform: row => row.view.platform,
  createdAt: row => row.view.createdAt,
  lastActiveAt: row => row.view.lastActiveAt,
  email: row => row.email,
  phone: row => row.phone,
};

/**
 * Builds one export (§5.26).
 *
 * The permissions were settled when the export was requested and are checked **again** when the
 * file is downloaded, so nothing here asks who the staff member is: the job's only job is to put
 * the columns that were approved over the filters that were approved into a file. That separation
 * is deliberate — a worker that re-derived the permissions would be a second implementation of
 * them, running without a request to read them from.
 */
@Injectable()
export class AdminExportRunner {
  private readonly logger = new Logger(AdminExportRunner.name);

  constructor(
    private readonly database: PrismaService,
    private readonly members: AdminMemberService,
    private readonly storage: StorageProvider,
    private readonly config: SystemConfigService,
  ) {}

  async run(exportId: string, options: { lastAttempt: boolean }): Promise<void> {
    const row = await this.database.adminExport.findUnique({ where: { id: exportId } });

    if (!row) return;

    // Anything past QUEUED/RUNNING has been settled — by an earlier attempt, or by the expiry
    // sweep. A stale job must not overwrite a READY row with a second file.
    if (row.state !== AdminExportState.QUEUED && row.state !== AdminExportState.RUNNING) return;

    await this.database.adminExport.update({
      where: { id: exportId },
      data: { state: AdminExportState.RUNNING },
    });

    try {
      const { body, rowCount } = await this.build(row);
      const key = `admin-exports/${row.requestedById}/${row.id}.csv`;

      await this.storage.put(key, body, CSV_MIME);

      const completedAt = new Date();

      await this.database.adminExport.update({
        where: { id: exportId },
        data: {
          state: AdminExportState.READY,
          storageKey: key,
          rowCount,
          completedAt,
          expiresAt: new Date(completedAt.getTime() + FILE_TTL_DAYS * 86_400_000),
          error: null,
        },
      });

      this.logger.log(`Export ${exportId} ready: ${rowCount} row(s), ${body.byteLength} bytes`);
    } catch (error) {
      const tooLarge = error instanceof ExportTooLarge;

      if (tooLarge || options.lastAttempt) {
        await this.database.adminExport.update({
          where: { id: exportId },
          data: {
            state: AdminExportState.FAILED,
            completedAt: new Date(),
            error: tooLarge
              ? (error as Error).message
              : 'The export could not be built. Try again, or ask an engineer to look at the log.',
          },
        });
      }

      // Retried unless it is the row count, which no number of attempts will change.
      if (!tooLarge) throw error;
    }
  }

  private async build(row: AdminExport): Promise<{ body: Buffer; rowCount: number }> {
    const { columns, filters } = paramsOf(row);

    switch (row.kind) {
      case AdminExportKind.MEMBERS:
        return this.buildMembers(columns, filters);
      default:
        // Unreachable: the service refuses every other kind at request time. Here so that adding
        // a kind to the enum without a builder fails loudly rather than producing an empty file.
        throw new Error(`No builder for export kind ${row.kind}`);
    }
  }

  private async buildMembers(
    columns: string[],
    filters: Record<string, unknown>,
  ): Promise<{ body: Buffer; rowCount: number }> {
    const dto = plainToInstance(ListMembersDto, filters);
    // `true`, because an email search was already refused at request time for anybody without
    // `members:pii_reveal`. See `AdminExportService.request`.
    const scope = await this.members.exportScope(dto, true);

    if (scope === 'DENIED') throw new Error('The export filters are no longer acceptable.');

    const cap = await this.config.get(SYSTEM_CONFIG_KEYS.EXPORT_MAX_ROWS);
    const chunks: string[] = [CSV_BOM, csvRow(columns)];
    const cells = columns.map(column => {
      const cell = MEMBER_CELLS[column];

      if (!cell) throw new Error(`No cell for member column ${column}`);

      return cell;
    });

    let cursor: string | null = null;
    let rowCount = 0;

    for (;;) {
      const page = await this.members.exportPage(scope, cursor, PAGE_SIZE);

      if (!page.lastId) break;

      for (const member of page.rows) {
        chunks.push(csvRow(cells.map(cell => cell(member))));
        rowCount += 1;
      }

      if (rowCount > cap) throw new ExportTooLarge(cap);

      cursor = page.lastId;
    }

    return { body: Buffer.from(chunks.join(''), 'utf8'), rowCount };
  }
}
