import { Injectable } from '@nestjs/common';
import {
  ModerationQueueType,
  Prisma,
  ReportReason,
  ReportTargetType,
  RiskLevel,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, buildPageMeta, Paginated, toJson } from '@/common';
import { AuthorView, RiskScannerService, authorSelect, toAuthorView } from '../../shared';
import { CreateBlockDto, CreateReportDto, ListBlocksDto } from '../dtos/moderation.dto';

/**
 * Which table holds each reportable thing, and which of its columns names the
 * author. One map rather than a switch in four places, so adding a content type
 * is one row.
 */
const TARGETS: Record<
  ReportTargetType,
  { model: keyof PrismaService; authorField: string; hasReportToken: boolean } | null
> = {
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
  STORE_ITEM: { model: 'storeItem', authorField: 'storeId', hasReportToken: true },
  CONNECT_PROFILE: { model: 'connectProfile', authorField: 'userId', hasReportToken: true },
  PROFESSIONAL_LISTING: {
    model: 'professionalListing',
    authorField: 'userId',
    hasReportToken: false,
  },
  USER: null,
};

@Injectable()
export class ModerationService {
  constructor(
    private readonly database: PrismaService,
    private readonly risk: RiskScannerService,
  ) {}

  // ─── 1.8.1 Reports ─────────────────────────────────────────────────────────

  /**
   * Returns 202. The response never reveals what happened to the reported
   * content, because telling a reporter that their report succeeded and the post
   * survived is an invitation to argue with the outcome, and telling them it was
   * removed exposes a moderation decision about someone else.
   */
  async report(reporterId: string, dto: CreateReportDto): Promise<void> {
    const resolved = await this.resolveTarget(dto.targetType, dto.targetId);

    if (!resolved) {
      throw ApiException.notFound('That content could not be found.');
    }

    // SAFETY_CONCERN routes into the Guard workflow rather than the standard
    // moderation queue (1.8.1): a member reporting that someone is in danger is
    // not the same job as a member reporting spam.
    const assessment = await this.risk.scan(dto.note, resolved.text);
    const isGuard =
      dto.reasonCode === ReportReason.SAFETY_CONCERN || this.risk.isUrgent(assessment);

    await this.database.$transaction(async tx => {
      const report = await tx.report.create({
        data: {
          reporterId,
          targetType: dto.targetType,
          targetId: resolved.id,
          targetUserId: resolved.authorId,
          reasonCode: dto.reasonCode,
          note: dto.note ?? null,
          // Snapshotted server-side, so deleting the content afterwards does not
          // erase the evidence (5.7).
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

      await tx.moderationQueueItem.upsert({
        where: {
          type_targetType_targetId: {
            type: isGuard ? ModerationQueueType.GUARD_RISK : ModerationQueueType.REPORTED_CONTENT,
            targetType: dto.targetType,
            targetId: resolved.id,
          },
        },
        // A second report on the same content raises its score rather than
        // creating a second row: three people reporting one post is one job for a
        // reviewer, and a more urgent one.
        update: {
          riskScore: { increment: Math.max(10, assessment.score) },
          ...(assessment.level !== RiskLevel.NONE
            ? { riskLevel: assessment.level, riskCategory: assessment.category }
            : {}),
        },
        create: {
          type: isGuard ? ModerationQueueType.GUARD_RISK : ModerationQueueType.REPORTED_CONTENT,
          targetType: dto.targetType,
          targetId: resolved.id,
          subjectUserId: resolved.authorId,
          reportId: report.id,
          riskLevel: assessment.level,
          riskCategory: assessment.category,
          riskScore: Math.max(10, assessment.score),
          riskSignals: toJson(assessment.signals),
          summary: resolved.text?.slice(0, 200) ?? null,
        },
      });

      // Applied in the same transaction, which is what the report sheet's second
      // option promises (1.8.1).
      if (dto.alsoBlock && resolved.authorId && resolved.authorId !== reporterId) {
        await tx.block.upsert({
          where: { blockerId_blockedId: { blockerId: reporterId, blockedId: resolved.authorId } },
          update: {},
          create: { blockerId: reporterId, blockedId: resolved.authorId },
        });
      }
    });
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
        user: toAuthorView(row.blocked),
        blockedAt: row.createdAt.toISOString(),
      })),
      meta: buildPageMeta(query, total),
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Resolves a target id, accepting a `reportToken` in place of an id for
   * anonymous content (D2). The token is what lets someone report or block an
   * anonymous author without the API ever handing out who they are.
   */
  private async resolveTarget(
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<{ id: string; authorId: string | null; text: string | null } | null> {
    if (targetType === ReportTargetType.USER || targetType === ReportTargetType.CONVERSATION) {
      const id = await this.resolveUserOrToken(targetId);

      return id
        ? { id, authorId: targetType === ReportTargetType.USER ? id : null, text: null }
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

    const row = await delegate.findFirst({ where }).catch(() => null);

    if (!row) return null;

    return {
      id: row.id as string,
      authorId: (row[target.authorField] as string | null) ?? null,
      text:
        (row.title as string | undefined) ??
        (row.content as string | undefined) ??
        (row.body as string | undefined) ??
        (row.name as string | undefined) ??
        null,
    };
  }

  /**
   * A user id, or the reportToken of any anonymous content, resolved to the
   * author behind it.
   */
  private async resolveUserOrToken(value: string): Promise<string | null> {
    const user = await this.database.user
      .findUnique({
        where: { id: value },
        select: { id: true },
      })
      .catch(() => null);

    if (user) return user.id;

    const [request, update, offer] = await Promise.all([
      this.database.communityRequest.findUnique({
        where: { reportToken: value },
        select: { authorId: true },
      }),
      this.database.communityUpdate.findUnique({
        where: { reportToken: value },
        select: { authorId: true },
      }),
      this.database.communityOffer.findUnique({
        where: { reportToken: value },
        select: { authorId: true },
      }),
    ]);

    return request?.authorId ?? update?.authorId ?? offer?.authorId ?? null;
  }
}
