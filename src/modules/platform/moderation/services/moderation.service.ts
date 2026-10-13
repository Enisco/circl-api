import { Injectable, Logger } from '@nestjs/common';
import {
  ContentRiskTier,
  ContentScanTrigger,
  Prisma,
  ReportReason,
  ReportState,
  ReportTargetType,
  RiskLevel,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, buildPageMeta, Paginated, toJson } from '@/common';
import {
  AuthorView,
  ContentSafetyService,
  MediaService,
  RiskScannerService,
  authorSelect,
  toAuthorView,
} from '../../shared';
import { CreateBlockDto, CreateReportDto, ListBlocksDto } from '../dtos/moderation.dto';
import { IntakeResult, ReportCaseService } from './report-case.service';

/**
 * Which table holds each reportable thing, and where the member who put it there is named.
 *
 * `authorField` is a column on the row itself. `authorVia` is for the rows that do not have one —
 * a shop's item is owned by the shop, not by a member — and without it the queue was handed the
 * owning row's id where it wanted a member: nobody to show, and nothing for a suspend to act on.
 */
interface ReportTarget {
  model: keyof PrismaService;
  authorField: string;
  hasReportToken: boolean;
  authorVia?: { relation: string; field: string };
}

const TARGETS: Record<ReportTargetType, ReportTarget | null> = {
  REQUEST: { model: 'communityRequest', authorField: 'authorId', hasReportToken: true },
  RESPONSE: { model: 'requestResponse', authorField: 'authorId', hasReportToken: false },
  OFFER: { model: 'communityOffer', authorField: 'authorId', hasReportToken: true },
  UPDATE: { model: 'communityUpdate', authorField: 'authorId', hasReportToken: true },
  UPDATE_REPLY: { model: 'updateReply', authorField: 'authorId', hasReportToken: false },
  GUIDE: { model: 'guide', authorField: 'authorId', hasReportToken: false },
  GROUP: { model: 'group', authorField: 'createdById', hasReportToken: true },
  GROUP_POST: { model: 'groupPost', authorField: 'authorId', hasReportToken: true },
  GROUP_POST_REPLY: { model: 'groupPostReply', authorField: 'authorId', hasReportToken: false },
  MESSAGE: { model: 'message', authorField: 'senderId', hasReportToken: false },
  CONVERSATION: null,
  STORE: { model: 'store', authorField: 'ownerId', hasReportToken: true },
  STORE_ITEM: {
    model: 'storeItem',
    authorField: 'storeId',
    hasReportToken: true,
    // An item belongs to a shop and a shop belongs to a member. Read through rather than
    // denormalised onto every item: one join on a path nobody takes twice a day beats a column
    // that has to be written correctly on every create for ever.
    authorVia: { relation: 'store', field: 'ownerId' },
  },
  CONNECT_PROFILE: { model: 'connectProfile', authorField: 'userId', hasReportToken: true },
  // A report names one item, because a photo is what somebody objects to. `media` holds the item
  // and `uploadedById` is who put it there; taking it down leaves the rest of its post standing
  // unless it was the last one (3.9).
  CONNECT_MEDIA: { model: 'media', authorField: 'uploadedById', hasReportToken: false },
  CONNECT_STORY: { model: 'connectStory', authorField: 'userId', hasReportToken: true },
  PROFESSIONAL_LISTING: {
    model: 'professionalListing',
    authorField: 'userId',
    hasReportToken: false,
  },
  // Added with the scanner (§4.1): these four are now scanned, so they are also reportable and
  // removable. A caption, a service, a review and the written part of a profile.
  CONNECT_POST: { model: 'connectPost', authorField: 'profileId', hasReportToken: false },
  PROFESSIONAL_SERVICE: {
    model: 'professionalService',
    authorField: 'listingId',
    hasReportToken: false,
    // A service belongs to a listing and a listing belongs to a member, the same read-through the
    // store item uses rather than a column that has to be written correctly for ever.
    authorVia: { relation: 'listing', field: 'userId' },
  },
  REVIEW: { model: 'review', authorField: 'reviewerId', hasReportToken: false },
  USER_PROFILE: { model: 'userProfile', authorField: 'userId', hasReportToken: false },
  // An image scanned in its own right (§6.1), which today means an avatar. `CONNECT_MEDIA` is the
  // same table under the name the app reports a Connect photo by; this is the scanner's name for
  // one that belongs to no post, and the two must not be merged: a report on a Connect photo
  // groups under its post (§3.9) and this one has no post to group under.
  MEDIA: { model: 'media', authorField: 'uploadedById', hasReportToken: false },
  USER: null,
};

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly risk: RiskScannerService,
    private readonly media: MediaService,
    private readonly safety: ContentSafetyService,
    private readonly cases: ReportCaseService,
  ) {}

  // ─── 1.8.1 Reports ─────────────────────────────────────────────────────────

  /**
   * Returns 202 to the member, and the case the report landed in to a caller that needs it.
   *
   * The return value exists for §5.10's escalations: a staff escalation with a target files a
   * staff report, and the escalation has to record **which case** that was. Working it out
   * afterwards would mean guessing from the newest report of that type, which is right until two
   * staff escalate two different posts in the same second. The member-facing controller ignores
   * it, as it did when this returned nothing.
   *
   * Where this reporter had already filed an open report about the same target, nothing new is
   * written and the case their first report is in comes back — with a null `priority`, because
   * nothing was re-prioritised. Null only when there is no case at all to point at.
   */
  async report(reporterId: string, dto: CreateReportDto): Promise<IntakeResult | null> {
    const resolved = await this.resolveTarget(dto.targetType, dto.targetId);

    if (!resolved) {
      throw ApiException.notFound('That content could not be found.');
    }

    // SAFETY_CONCERN routes into the Guard workflow rather than the standard moderation queue (1.8.1): a member reporting that someone is in danger is not the same job as a member reporting spam.
    //
    // The lexicon is run over the **report** — the reason and the note the reporter typed — which
    // is what decides Guard routing. §7.1's scan of the *content* is separate and happens inside
    // the transaction below, because it writes a verdict.
    const assessment = await this.risk.scan(dto.note, resolved.text);
    const isGuard =
      dto.reasonCode === ReportReason.SAFETY_CONCERN || this.risk.isUrgent(assessment);

    // A member tapping twice on a bad connection should not see a failure (G2). The second tap
    // reuses the open report rather than filing another for the moderator to close by hand.
    const existing = await this.database.report.findFirst({
      where: {
        reporterId,
        targetType: dto.targetType,
        targetId: resolved.id,
        state: { in: [ReportState.RECEIVED, ReportState.TRIAGED] },
      },
      select: { id: true, caseId: true },
    });

    // Named explicitly, because "also block" on a reported post means block its author and on a
    // reported group means nothing at all.
    const blockTargetId = dto.blockUserId
      ? await this.resolveUserOrToken(dto.blockUserId)
      : resolved.authorId;

    if (existing) {
      if (dto.alsoBlock && blockTargetId && blockTargetId !== reporterId) {
        await this.database.block.upsert({
          where: { blockerId_blockedId: { blockerId: reporterId, blockedId: blockTargetId } },
          update: {},
          create: { blockerId: reporterId, blockedId: blockTargetId },
        });
      }

      // The case their first report is already in, rather than null. Nothing new was filed, but
      // the question a caller asks of this method is "where did this land" and that is still the
      // answer — §5.10's escalation has to link to the case either way, and it is the same case.
      return existing.caseId
        ? { caseId: existing.caseId, priority: null, settled: null, late: false }
        : null;
    }

    let grouping: IntakeResult | null = null;
    const file = async (tx: Prisma.TransactionClient) => {
      const report = await tx.report.create({
        data: {
          reporterId,
          targetType: dto.targetType,
          targetId: resolved.id,
          targetUserId: resolved.authorId,
          reasonCode: dto.reasonCode,
          note: dto.note ?? null,
          // Snapshotted server-side, so deleting the content afterwards does not erase the evidence (5.7).
          snapshot: toJson({
            capturedAt: new Date().toISOString(),
            targetType: dto.targetType,
            text: resolved.text,
          }),
          riskLevel:
            isGuard && assessment.level === RiskLevel.NONE ? RiskLevel.MEDIUM : assessment.level,
          riskCategory: assessment.category,
        },
      });

      // §7.1 step 2: the content is scanned by the pipeline, not by a second bare lexicon call
      // that writes nothing down. A report is the one moment somebody is asking for a fresh look,
      // so it re-scans even when the words have not changed — the lexicon may have grown since.
      // Content with no row to read (a conversation, a member) scans to nothing and the report's
      // own risk level stands.
      const verdict = await this.safety.rescan(tx, {
        targetType: dto.targetType,
        targetId: resolved.id,
        authorId: resolved.authorId,
        trigger: ContentScanTrigger.REPORT,
      });

      const grouped = await this.cases.intake(tx, {
        reportId: report.id,
        reporterId,
        reasonCode: dto.reasonCode,
        targetType: dto.targetType,
        targetId: resolved.id,
        targetUserId: resolved.authorId,
        targetRemoved: resolved.removed,
        tier: verdict?.tier ?? ContentRiskTier.CLEAN,
        riskLevel:
          isGuard && assessment.level === RiskLevel.NONE ? RiskLevel.MEDIUM : assessment.level,
        riskScore: assessment.score,
        riskSignals: assessment.signals,
        summary: resolved.text?.slice(0, 200) ?? null,
        guard: isGuard,
      });

      // Assigned rather than returned, because `file` is the retried half below: the winner of a
      // case race runs it twice and the second run is the one whose answer is true.
      grouping = grouped;

      if (grouped.settled) {
        // Answered from a case that was already decided (§7.1 step 5). Nothing more to do here:
        // the reporter is told the outcome by §7.3's notification, which reads `outcomeNotifiedAt`.
        this.logger.log(
          `Report ${report.id} answered from case ${grouped.caseId}: ${grouped.settled}`,
        );
      }

      // In the same transaction as the report (1.8.1): a member who asked for both and got one is
      // worse off than one who got neither.
      if (dto.alsoBlock && blockTargetId && blockTargetId !== reporterId) {
        await tx.block.upsert({
          where: { blockerId_blockedId: { blockerId: reporterId, blockedId: blockTargetId } },
          update: {},
          create: { blockerId: reporterId, blockedId: blockTargetId },
        });
      }
    };

    try {
      await this.database.$transaction(file);
    } catch (error) {
      if (!this.lostTheCaseRace(error)) throw error;

      // Two reports about the same target, arriving together: §4.6's partial unique index is what
      // makes "one open case per target" true rather than usually true, and this is its other
      // half. The loser's whole transaction rolled back, so the retry re-reads, finds the case the
      // winner opened and joins it. Retried outside the transaction because a failed statement
      // aborts a Postgres transaction — nothing can be caught and continued inside one.
      //
      // Not reproducible on this machine: eight reports fired at one post land as one case with
      // eight reporters, because Prisma's connection pool serialises the transactions long before
      // Postgres has to. A bigger pool is all it would take for that to stop being true, and the
      // failure it would cause is a member's report lost to a 500.
      this.logger.warn(`Report on ${dto.targetType} ${resolved.id} lost the case race; retrying`);
      await this.database.$transaction(file);
    }

    return grouping;
  }

  /** Whether a write failed on §4.6's "one open case per target" index. */
  private lostTheCaseRace(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return false;
    }

    // Prisma does not know this index — it is raw SQL in `extra-indexes.sql` — so the target it
    // reports is the constraint's name rather than a field list.
    return JSON.stringify(error.meta ?? {}).includes('report_cases_open_target');
  }

  // ─── 1.8.2 Blocks ──────────────────────────────────────────────────────────

  async block(blockerId: string, dto: CreateBlockDto): Promise<void> {
    const blockedId = await this.resolveUserOrToken(dto.userId);

    if (!blockedId) throw ApiException.notFound('That member could not be found.');

    if (blockedId === blockerId) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'You cannot block yourself.',
        { details: [{ field: 'userId', message: 'You cannot block yourself.' }] },
      );
    }

    await this.database.block.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      update: {},
      create: { blockerId, blockedId },
    });
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.database.block.deleteMany({ where: { blockerId, blockedId } });
  }

  async listBlocks(
    blockerId: string,
    query: ListBlocksDto,
  ): Promise<Paginated<{ user: AuthorView; blockedAt: string }>> {
    const where: Prisma.BlockWhereInput = { blockerId };

    const [total, rows] = await this.database.$transaction([
      this.database.block.count({ where }),
      this.database.block.findMany({
        where,
        include: { blocked: { select: authorSelect } },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
    ]);

    return {
      data: rows.map(row => ({
        user: toAuthorView(row.blocked, { sign: this.media.sign }),
        blockedAt: row.createdAt.toISOString(),
      })),
      meta: buildPageMeta(query, total),
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Resolves a target id, accepting a `reportToken` in place of an id for anonymous content (D2). */
  private async resolveTarget(
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<{
    id: string;
    authorId: string | null;
    text: string | null;
    /** Already taken down, which is what makes a previous decision the answer to this report (§7.1). */
    removed: boolean;
  } | null> {
    if (targetType === ReportTargetType.USER || targetType === ReportTargetType.CONVERSATION) {
      const id = await this.resolveUserOrToken(targetId);

      return id
        ? {
            id,
            authorId: targetType === ReportTargetType.USER ? id : null,
            text: null,
            removed: false,
          }
        : null;
    }

    const target = TARGETS[targetType];

    if (!target) return null;

    const delegate = this.database[target.model] as unknown as {
      findFirst(args: unknown): Promise<Record<string, unknown> | null>;
    };

    const where = target.hasReportToken
      ? { OR: [{ id: targetId }, { reportToken: targetId }] }
      : { id: targetId };

    const row = await delegate
      .findFirst({
        where,
        ...(target.authorVia
          ? {
              include: {
                [target.authorVia.relation]: { select: { [target.authorVia.field]: true } },
              },
            }
          : {}),
      })
      .catch(() => null);

    if (!row) return null;

    const viaRow = target.authorVia
      ? (row[target.authorVia.relation] as Record<string, unknown> | null)
      : null;

    return {
      id: row.id as string,
      authorId: target.authorVia
        ? ((viaRow?.[target.authorVia.field] as string | null) ?? null)
        : ((row[target.authorField] as string | null) ?? null),
      text:
        (row.title as string | undefined) ??
        (row.content as string | undefined) ??
        (row.body as string | undefined) ??
        (row.name as string | undefined) ??
        null,
      // Reportable content is soft-deleted, so the row is still here to resolve — which is how a
      // member reporting from a screen that has not refreshed gets an answer rather than a 404.
      // A service is switched off rather than deleted, and that counts as taken down too.
      removed:
        row.deletedAt !== null && row.deletedAt !== undefined ? true : row.isActive === false,
    };
  }

  /** A user id, or the reportToken of any anonymous content, resolved to the author behind it. */
  private async resolveUserOrToken(value: string): Promise<string | null> {
    const user = await this.database.user
      .findUnique({
        where: { id: value },
        select: { id: true },
      })
      .catch(() => null);

    if (user) return user.id;

    const [request, update, offer] = await Promise.all([
      // visibility: a report is about content, so the report path has to be able to see content
      // in any state — including the state a previous report put it in.
      this.database.communityRequest.findUnique({
        where: { reportToken: value },
        select: { authorId: true },
      }),
      this.database.communityUpdate.findUnique({
        where: { reportToken: value },
        select: { authorId: true },
      }),
      // visibility: a report is about content, so this path sees content in any state.
      this.database.communityOffer.findUnique({
        where: { reportToken: value },
        select: { authorId: true },
      }),
    ]);

    return request?.authorId ?? update?.authorId ?? offer?.authorId ?? null;
  }
}
