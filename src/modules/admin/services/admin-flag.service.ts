import { Injectable } from '@nestjs/common';
import { ModerationQueueType, Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiException, buildPageMeta } from '@/common';
import { MediaService } from '@/modules/platform/shared';
import { ListFlagsDto } from '../dtos/admin-flag.dto';
import { toMemberRef } from '../serializers/admin-member.serializer';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';
import { AdminContentTargetService } from './admin-content-target.service';

type SafetyRow = Prisma.ContentSafetyGetPayload<Record<string, never>>;

/** The member view a flag row carries, resolved by id. */
type AuthorRef = ReturnType<typeof toMemberRef> | null;

/**
 * Every scanned thing, flagged or not (§5.12).
 *
 * The flagged *queue* is a tab of §5.9 and only holds what crossed a threshold somebody has to
 * act on. This is the layer underneath it: every row the scanner has ever written, including the
 * LOW signals that were published without review.
 *
 * Those are the point. A term's weight is judged on what it matched, and most of what it matches
 * is never queued — so a lexicon tuned only on the items that reached a reviewer is tuned on a
 * biased sample of itself. This is also the drill-down behind the analytics charts: a tier
 * breakdown nobody can click through to the rows is a number staff have to take on trust.
 */
@Injectable()
export class AdminFlagService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly targets: AdminContentTargetService,
  ) {}

  async list(query: ListFlagsDto) {
    const where: Prisma.ContentSafetyWhereInput = {
      ...(query.tier?.length ? { tier: { in: query.tier } } : {}),
      ...(query.visibilityState?.length ? { visibilityState: { in: query.visibilityState } } : {}),
      ...(query.category?.length ? { category: { in: query.category } } : {}),
      ...(query.scanStatus?.length ? { scanStatus: { in: query.scanStatus } } : {}),
      ...(query.targetType?.length ? { targetType: { in: query.targetType } } : {}),
      ...(query.authorId ? { authorId: query.authorId } : {}),
      ...(query.minScore !== undefined ? { finalScore: { gte: query.minScore } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const sort = query.sortField(['score', 'createdAt', 'updatedAt'], 'score');
    const direction = query.order ?? 'desc';

    const [total, rows] = await Promise.all([
      this.database.contentSafety.count({ where }),
      this.database.contentSafety.findMany({
        where,
        orderBy:
          sort === 'score'
            ? [{ finalScore: direction }, { createdAt: 'desc' }]
            : [{ [sort]: direction }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    const [targets, authors] = await Promise.all([
      this.targets.resolve(rows),
      this.authorsFor(rows),
    ]);

    return {
      data: rows.map(row =>
        this.toRow(
          row,
          targets.get(this.targets.key(row))?.title ?? null,
          row.authorId ? (authors.get(row.authorId) ?? null) : null,
        ),
      ),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total),
    };
  }

  async findOne(id: string) {
    const row = await this.database.contentSafety.findUnique({ where: { id } });

    if (!row) throw ApiException.notFound('That scan could not be found.');

    const [targets, authors, scans, openQueueItem] = await Promise.all([
      this.targets.resolve([row]),
      this.authorsFor([row]),
      // Oldest first: the story of a piece of content is what the scanner thought each time it
      // looked, and reading it backwards is how "it got worse" and "it got better" swap places.
      this.database.contentScan.findMany({
        where: { contentSafetyId: id },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
      // What a reviewer would act through. The flags list is a read-only view — every decision
      // is taken on the queue item, and without this the portal has no link from one to the other.
      this.database.moderationQueueItem.findFirst({
        where: {
          type: ModerationQueueType.FLAGGED_CONTENT,
          targetType: row.targetType,
          targetId: row.targetId,
          decidedAt: null,
        },
        select: { id: true },
      }),
    ]);

    const target = targets.get(this.targets.key(row)) ?? null;

    return {
      ...this.toRow(
        row,
        target?.title ?? null,
        row.authorId ? (authors.get(row.authorId) ?? null) : null,
      ),
      fields: target?.fields ?? {},
      openQueueItemId: openQueueItem?.id ?? null,
      scans: scans.map(scan => ({
        id: scan.id,
        trigger: scan.trigger,
        scanVersion: scan.scanVersion,
        tier: scan.tier,
        finalScore: scan.finalScore,
        lexiconScore: scan.lexiconScore,
        lexiconSignals: scan.lexiconSignals ?? [],
        classifierModel: scan.classifierModel,
        classifierScores: scan.classifierScores ?? null,
        // Kept rather than logged: a week of `classifierError = 'timeout'` is the thing a safety
        // dashboard has to be able to show.
        classifierError: scan.classifierError,
        degraded: scan.degraded,
        durationMs: scan.durationMs,
        createdAt: scan.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The authors, by id.
   *
   * `ContentSafety` holds `authorId` with no foreign key, deliberately — the same reason
   * `ModerationAction` holds `actorId` that way: a scan is a record of what the platform did, and
   * it has to survive the deletion of the account it was about. So this resolves against the live
   * table and simply finds nothing for an account that has since gone.
   */
  private async authorsFor(rows: Array<{ authorId: string | null }>) {
    const ids = [...new Set(rows.map(row => row.authorId).filter((id): id is string => !!id))];

    if (!ids.length) return new Map<string, NonNullable<AuthorRef>>();

    const people = await this.database.user.findMany({
      where: { id: { in: ids } },
      select: caseMemberSelect,
    });

    return new Map(people.map(person => [person.id, toMemberRef(person, this.media.sign)]));
  }

  private toRow(row: SafetyRow, title: string | null, author: AuthorRef) {
    return {
      id: row.id,
      targetType: row.targetType,
      targetId: row.targetId,
      title,
      author,
      tier: row.tier,
      visibilityState: row.visibilityState,
      category: row.category,
      finalScore: row.finalScore,
      // Both parts beside the total, never averaged: "the lexicon said 70 and the classifier said
      // 2" is the disagreement a reviewer needs to see, and one number hides it.
      lexiconScore: row.lexiconScore,
      lexiconSignals: row.lexiconSignals ?? [],
      classifierScores: row.classifierScores ?? null,
      classifierFlagged: row.classifierFlagged,
      scanStatus: row.scanStatus,
      scanVersion: row.scanVersion,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
