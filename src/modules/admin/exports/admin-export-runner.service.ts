import { Injectable, Logger } from '@nestjs/common';
import { AdminExport, AdminExportKind, AdminExportState } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { PrismaService } from '@/infrastructure';
import { SYSTEM_CONFIG_KEYS } from '@/common';
import { StorageProvider, SystemConfigService } from '@/modules/platform/shared';
import { ListMembersDto } from '../dtos/analytics-filter.dto';
import { ListAuditDto } from '../dtos/admin-audit.dto';
import { ListSupportThreadsDto } from '../dtos/admin-support.dto';
import { AdminPrincipal } from '../common/admin-principal';
import { AdminAuditService } from '../services/admin-audit.service';
import { AdminEnforcementLogService } from '../services/admin-enforcement-log.service';
import { AdminReportCaseService } from '../services/admin-report-case.service';
import { AdminContentService } from '../content/admin-content.service';
import { ExportContentDto } from '../content/admin-content.dto';
import { ListEnforcementDto } from '../dtos/admin-enforcement.dto';
import { ListReportCasesDto } from '../dtos/admin-report-case.dto';
import { AdminSupportService } from '../services/admin-support.service';
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
    // The two lists whose own predicates these exports reuse. Injected rather than copied, so the
    // scope each one applies on screen is the scope the file is built under.
    private readonly auditTrail: AdminAuditService,
    private readonly support: AdminSupportService,
    private readonly cases: AdminReportCaseService,
    private readonly enforcement: AdminEnforcementLogService,
    private readonly content: AdminContentService,
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
      case AdminExportKind.AUDIT:
        return this.buildAudit(row, columns, filters);
      case AdminExportKind.SUPPORT_THREADS:
        return this.buildSupportThreads(row, columns, filters);
      case AdminExportKind.REPORTS:
        return this.buildReports(row, columns, filters);
      case AdminExportKind.ENFORCEMENT:
        return this.buildEnforcement(columns, filters);
      case AdminExportKind.CONTENT:
        return this.buildContent(columns, filters);
      default:
        // Unreachable: the service refuses every other kind at request time. Here so that adding
        // a kind to the enum without a builder fails loudly rather than producing an empty file.
        throw new Error(`No builder for export kind ${row.kind}`);
    }
  }

  /**
   * §5.26's audit export, under the requester's **own** R8 scope.
   *
   * The scope comes from `AdminAuditService.exportWhere`, which is the list's own predicate — so a
   * reader with `audit:read_self` exports their own entries and a reader with `audit:read_area`
   * exports their areas, without this file knowing what either of those means. The actor is
   * rebuilt from the stored row because the worker runs long after the request: an export is a
   * receipt, and the scope that applied when it was asked for is the scope it must keep.
   */
  private async buildAudit(
    row: AdminExport,
    columns: string[],
    filters: Record<string, unknown>,
  ): Promise<{ body: Buffer; rowCount: number }> {
    const actor = await this.actorOf(row);
    const query = plainToInstance(ListAuditDto, filters);
    const where = this.auditTrail.exportWhere(actor, query);
    const cap = await this.config.get(SYSTEM_CONFIG_KEYS.EXPORT_MAX_ROWS);
    const chunks: string[] = [CSV_BOM, csvRow(columns)];

    let cursor: string | undefined;
    let rowCount = 0;

    for (;;) {
      const page = await this.database.auditLog.findMany({
        where,
        select: {
          id: true,
          occurredAt: true,
          actorId: true,
          actorRole: true,
          action: true,
          area: true,
          targetType: true,
          targetId: true,
          targetLabel: true,
          reasonCode: true,
        },
        // By id, not `occurredAt`: two entries written in the same millisecond would make a
        // timestamp cursor skip one of them, and an audit export that quietly drops a row is the
        // worst kind of wrong file to hand somebody.
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (!page.length) break;

      const staff = await this.staffNames(page.map(entry => entry.actorId));

      for (const entry of page) {
        chunks.push(
          csvRow(
            columns.map(column => {
              if (column === 'occurredAt') return entry.occurredAt.toISOString();
              // The name, with the id beside it: the trail holds no foreign key to the staff
              // account on purpose, so a deleted actor is an id and nothing else — and a column
              // of bare ids is a file nobody can read.
              if (column === 'actor') {
                return entry.actorId
                  ? `${staff.get(entry.actorId) ?? 'deleted account'} (${entry.actorId})`
                  : 'system';
              }
              if (column === 'action') return entry.action;
              if (column === 'target') {
                return [entry.targetType, entry.targetLabel ?? entry.targetId]
                  .filter(Boolean)
                  .join(': ');
              }

              return entry.reasonCode ?? null;
            }),
          ),
        );
        rowCount += 1;
      }

      if (rowCount > cap) throw new ExportTooLarge(cap);

      cursor = page[page.length - 1].id;
    }

    return { body: Buffer.from(chunks.join(''), 'utf8'), rowCount };
  }

  /**
   * §5.26's support inbox export, under R7.
   *
   * The predicate is the inbox's own, so a support agent exports the inbox they are allowed rather
   * than the one that exists — a Guard thread is excluded for anybody without `guard:read`, as it
   * is on the screen.
   */
  private async buildSupportThreads(
    row: AdminExport,
    columns: string[],
    filters: Record<string, unknown>,
  ): Promise<{ body: Buffer; rowCount: number }> {
    const actor = await this.actorOf(row);
    const query = plainToInstance(ListSupportThreadsDto, filters);
    const where = await this.support.exportWhere(actor, query);
    const cap = await this.config.get(SYSTEM_CONFIG_KEYS.EXPORT_MAX_ROWS);
    const chunks: string[] = [CSV_BOM, csvRow(columns)];

    let cursor: string | undefined;
    let rowCount = 0;

    for (;;) {
      const page = await this.database.supportThread.findMany({
        where,
        select: {
          conversationId: true,
          type: true,
          state: true,
          createdAt: true,
          firstResponseAt: true,
        },
        orderBy: { conversationId: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { conversationId: cursor } } : {}),
      });

      if (!page.length) break;

      for (const thread of page) {
        chunks.push(
          csvRow(
            columns.map(column => {
              if (column === 'conversationId') return thread.conversationId;
              if (column === 'type') return thread.type;
              if (column === 'state') return thread.state;
              if (column === 'createdAt') return thread.createdAt.toISOString();

              return thread.firstResponseAt?.toISOString() ?? null;
            }),
          ),
        );
        rowCount += 1;
      }

      if (rowCount > cap) throw new ExportTooLarge(cap);

      cursor = page[page.length - 1].conversationId;
    }

    return { body: Buffer.from(chunks.join(''), 'utf8'), rowCount };
  }

  /**
   * §5.26's report case export, over the case list's **own** predicate.
   *
   * `whereFor` is the list's, extracted rather than copied — eleven filters reimplemented here
   * would hand somebody a CSV describing a different set of cases from the screen they exported it
   * from, and nothing would say which was right.
   */
  private async buildReports(
    row: AdminExport,
    columns: string[],
    filters: Record<string, unknown>,
  ): Promise<{ body: Buffer; rowCount: number }> {
    const actor = await this.actorOf(row);
    const query = plainToInstance(ListReportCasesDto, filters);
    const where = this.cases.whereFor(actor, query);
    const cap = await this.config.get(SYSTEM_CONFIG_KEYS.EXPORT_MAX_ROWS);
    const chunks: string[] = [CSV_BOM, csvRow(columns)];

    let cursor: string | undefined;
    let rowCount = 0;

    for (;;) {
      const page = await this.database.reportCase.findMany({
        where,
        select: {
          id: true,
          priority: true,
          state: true,
          reasonCodes: true,
          reportCount: true,
          firstReportedAt: true,
          decision: true,
        },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (!page.length) break;

      for (const entry of page) {
        chunks.push(
          csvRow(
            columns.map(column => {
              if (column === 'priority') return entry.priority;
              if (column === 'state') return entry.state;
              // Joined with a space, not a comma: the cell is already comma-quoted and a reader
              // opening it in a spreadsheet should see a list, not a nested CSV.
              if (column === 'reasonCodes') return entry.reasonCodes.join(' ');
              if (column === 'reportCount') return entry.reportCount;
              if (column === 'firstReportedAt') return entry.firstReportedAt.toISOString();
              if (column === 'decision') return entry.decision;

              return entry.id;
            }),
          ),
        );
        rowCount += 1;
      }

      if (rowCount > cap) throw new ExportTooLarge(cap);

      cursor = page[page.length - 1].id;
    }

    return { body: Buffer.from(chunks.join(''), 'utf8'), rowCount };
  }

  /**
   * §5.26's enforcement export, over the log's own union.
   *
   * The log reads strikes and suspensions as one list, and `active` means different things in the
   * two tables — a strike runs out, a permanent suspension never does. That is exactly the rule a
   * second implementation would get wrong, so this pages the list itself rather than querying the
   * tables again.
   */
  private async buildEnforcement(
    columns: string[],
    filters: Record<string, unknown>,
  ): Promise<{ body: Buffer; rowCount: number }> {
    const query = plainToInstance(ListEnforcementDto, filters);
    const cap = await this.config.get(SYSTEM_CONFIG_KEYS.EXPORT_MAX_ROWS);
    const chunks: string[] = [CSV_BOM, csvRow(columns)];

    let page = 1;
    let rowCount = 0;

    for (;;) {
      const rows = await this.enforcement.exportPage(query, page, PAGE_SIZE);

      if (!rows.length) break;

      for (const entry of rows) {
        chunks.push(
          csvRow(
            columns.map(column => {
              if (column === 'member') {
                const member = entry.member;

                return member
                  ? `${[member.firstName, member.lastName].filter(Boolean).join(' ')} (${member.id})`
                  : null;
              }
              if (column === 'kind') return entry.kind;
              if (column === 'reasonCode') return entry.reasonCode;
              if (column === 'issuedAt') return entry.issuedAt;
              if (column === 'expiresAt') return entry.expiresAt;

              // `active` is the log's own `isActive`, which is the only field here that cannot be
              // derived from the two dates without knowing which table the row came from.
              return entry.isActive;
            }),
          ),
        );
        rowCount += 1;
      }

      if (rowCount > cap) throw new ExportTooLarge(cap);
      if (rows.length < PAGE_SIZE) break;

      page += 1;
    }

    return { body: Buffer.from(chunks.join(''), 'utf8'), rowCount };
  }

  /**
   * §5.26's content export: every kind in one file, or one kind when asked for.
   *
   * `targetType` is one of its columns, so the file can cover the lot — seventeen kinds, one query
   * each, concatenated. That is only possible because the four columns asked for are the four
   * every kind has: the list's own per-kind SQL joins authors, cities, categories and a status
   * expression, and none of those is here. `type` narrows it to one kind, which is how a
   * type-specific filter becomes usable at all.
   *
   * The kinds are walked in the registry's order so the file is grouped by type, which is how
   * somebody reads it.
   */
  private async buildContent(
    columns: string[],
    filters: Record<string, unknown>,
  ): Promise<{ body: Buffer; rowCount: number }> {
    const query = plainToInstance(ExportContentDto, filters);
    const cap = await this.config.get(SYSTEM_CONFIG_KEYS.EXPORT_MAX_ROWS);
    const chunks: string[] = [CSV_BOM, csvRow(columns)];

    /**
     * Which kinds this file covers, asked rather than assumed.
     *
     * One kind when the request named a `type`. Otherwise every kind that can answer the filters:
     * a review has no city, so a city-filtered file leaves reviews out instead of including every
     * one of them unfiltered, which is what it used to do.
     */
    const slugs = this.content.exportSlugs(query);

    let rowCount = 0;

    for (const slug of slugs) {
      let offset = 0;

      for (;;) {
        const rows = await this.content.exportPage(slug, query, offset, PAGE_SIZE);

        if (!rows.length) break;

        for (const entry of rows) {
          chunks.push(
            csvRow(
              columns.map(column => {
                if (column === 'targetType') return entry.targetType;
                if (column === 'targetId') return entry.targetId;
                if (column === 'visibilityState') return entry.visibilityState;

                return entry.createdAt;
              }),
            ),
          );
          rowCount += 1;
        }

        if (rowCount > cap) throw new ExportTooLarge(cap);
        if (rows.length < PAGE_SIZE) break;

        offset += PAGE_SIZE;
      }
    }

    return { body: Buffer.from(chunks.join(''), 'utf8'), rowCount };
  }

  /**
   * The requester, rebuilt as a principal.
   *
   * The worker runs minutes after the request, so the permissions have to come from the account
   * rather than from the request that is long gone. Rebuilt rather than stored on the row: a
   * permission set frozen at request time would let somebody who has since been deactivated, or
   * had their role narrowed, still receive the file their old role could see.
   */
  private async actorOf(row: AdminExport): Promise<AdminPrincipal> {
    const person = await this.database.user.findUnique({
      where: { id: row.requestedById },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        adminCredential: { select: { deactivatedAt: true } },
        userRole: {
          select: {
            role: {
              select: {
                code: true,
                rolePermissions: { select: { permission: { select: { code: true } } } },
              },
            },
          },
        },
      },
    });

    if (!person || person.adminCredential?.deactivatedAt) {
      throw new Error('The staff account that asked for this export is no longer active.');
    }

    const role = person.userRole?.role;

    return {
      id: person.id,
      email: person.email ?? '',
      firstName: person.firstName,
      lastName: person.lastName ?? '',
      roleCode: role?.code ?? 'unknown',
      permissions: new Set((role?.rolePermissions ?? []).map(entry => entry.permission.code)),
      sessionId: '',
    } as AdminPrincipal;
  }

  /** Staff names for an audit page, so the `actor` column reads as a person. */
  private async staffNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];

    if (!wanted.length) return new Map();

    const rows = await this.database.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, firstName: true, lastName: true },
    });

    return new Map(
      rows.map(person => [
        person.id,
        [person.firstName, person.lastName].filter(Boolean).join(' '),
      ]),
    );
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
