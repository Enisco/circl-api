import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  ActivityVerb,
  ContentScanTrigger,
  DeflectionOutcome,
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  Prisma,
  ReportTargetType,
  TaxonomyKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, ReasonedDto, readTimeMinutes, toJson } from '@/common';
import { ContentSafetyService, MediaService, TaxonomyService } from '@/modules/platform/shared';
import { AutoGuideService } from '@/modules/platform/intelligence';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import { staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';
import { GuideInputDto, GuidePerformanceDto, PatchGuideDto } from './admin-guide.dto';

/** Progress at or above this counts as read to the end (§5.8). */
const COMPLETION = 0.9;

const DAY_MS = 86_400_000;

/**
 * Guides Circl writes itself (§5.8).
 *
 * Separate from §5.7's content screens, which *list* guides among sixteen other kinds and can hide
 * or remove one. This is the editor: authoring, editing, publishing and the numbers that say
 * whether a guide was worth writing.
 *
 * A staff-written guide has `authorId = null`, which is what the member-facing read path already
 * renders as "by Circl". It is scanned like anything else — a guide is published copy, and the one
 * written by staff is the one nobody else will check.
 */
@Injectable()
export class AdminGuideService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly taxonomy: TaxonomyService,
    private readonly safety: ContentSafetyService,
    private readonly audit: AuditService,
    private readonly autoGuides: AutoGuideService,
  ) {}

  async findOne(id: string) {
    const guide = await this.load(id);

    return { data: await this.toView(guide) };
  }

  async create(actor: AdminPrincipal, dto: GuideInputDto) {
    await this.taxonomy.assertValid(TaxonomyKind.GUIDE_TOPIC, dto.topicCode, 'topicCode');

    if (dto.cityId) await this.assertCity(dto.cityId);

    const blocks = dto.blocks.map(block => ({ type: block.type, text: block.text }));

    const { result, auditId } = await this.audit.mutate(
      (guide: { id: string }) => ({
        action: 'guide.created',
        targetType: 'GUIDE',
        targetId: guide.id,
        targetLabel: dto.title,
        after: { title: dto.title, topicCode: dto.topicCode, published: false },
        metadata: { blocks: blocks.length },
      }),
      async tx => {
        const guide = await tx.guide.create({
          data: {
            // Null, not the staff member's id: the guide is Circl's, and the member-facing read
            // path renders a null author as "by Circl". Putting a staff id here would publish an
            // employee's name and profile to the community.
            authorId: null,
            topicCode: dto.topicCode,
            title: dto.title,
            intro: dto.intro,
            blocks: toJson(blocks),
            resourceUrl: dto.resourceUrl ?? null,
            cityId: dto.cityId ?? null,
            readTimeMinutes: readTimeMinutes(
              [dto.intro, ...blocks.map(block => block.text)].join(' '),
            ),
            // A draft until somebody publishes it. Writing `publishedAt` here would put an
            // unreviewed guide straight into the feed.
            publishedAt: null,
          },
          select: { id: true },
        });

        await this.scan(tx, guide.id, dto.title, dto.intro, blocks);

        return guide;
      },
    );

    return { data: await this.toView(await this.load(result.id)), auditId };
  }

  async update(actor: AdminPrincipal, id: string, dto: PatchGuideDto) {
    const guide = await this.load(id);

    if (dto.topicCode) {
      await this.taxonomy.assertValid(TaxonomyKind.GUIDE_TOPIC, dto.topicCode, 'topicCode');
    }

    if (dto.cityId) await this.assertCity(dto.cityId);

    const blocks = dto.blocks
      ? dto.blocks.map(block => ({ type: block.type, text: block.text }))
      : ((guide.blocks ?? []) as Array<{ type: string; text: string }>);
    const title = dto.title ?? guide.title;
    const intro = dto.intro ?? guide.intro;

    const { auditId } = await this.audit.mutate(
      {
        action: 'guide.updated',
        targetType: 'GUIDE',
        targetId: id,
        targetLabel: title,
        before: {
          title: guide.title,
          intro: guide.intro,
          topicCode: guide.topicCode,
          blocks: ((guide.blocks ?? []) as unknown[]).length,
          resourceUrl: guide.resourceUrl,
          cityId: guide.cityId,
        },
        after: {
          title,
          intro,
          topicCode: dto.topicCode ?? guide.topicCode,
          blocks: blocks.length,
          resourceUrl: dto.resourceUrl ?? guide.resourceUrl,
          cityId: dto.cityId === undefined ? guide.cityId : dto.cityId,
        },
      },
      async tx => {
        await tx.guide.update({
          where: { id },
          data: {
            ...(dto.topicCode ? { topicCode: dto.topicCode } : {}),
            ...(dto.title ? { title: dto.title } : {}),
            ...(dto.intro ? { intro: dto.intro } : {}),
            ...(dto.blocks ? { blocks: toJson(blocks) } : {}),
            ...(dto.resourceUrl !== undefined ? { resourceUrl: dto.resourceUrl } : {}),
            ...(dto.cityId !== undefined ? { cityId: dto.cityId } : {}),
            readTimeMinutes: readTimeMinutes([intro, ...blocks.map(block => block.text)].join(' ')),
          },
        });

        // Re-scanned on every edit, even one that only moved a comma: the scan is of the words as
        // they are now, and an edit is exactly when they changed.
        await this.scan(tx, id, title, intro, blocks);
      },
    );

    return { data: await this.toView(await this.load(id)), auditId };
  }

  /**
   * Publishes a guide (§5.8).
   *
   * An **auto-generated** guide goes through `AutoGuideService.publish`, which is where the
   * provenance rules live: a machine-drafted guide with no sources is refused rather than published
   * bare. Re-implementing that here would be a second answer to "is this fit to publish", and the
   * one that gets it wrong publishes invented advice with Circl's name on it.
   */
  async publish(actor: AdminPrincipal, id: string) {
    const guide = await this.load(id);

    if (guide.publishedAt) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'That guide is already published.',
        { data: { publishedAt: guide.publishedAt.toISOString() } },
      );
    }

    if (guide.isAutoGenerated) {
      // §1.8: an auto-generated guide with no sources is never published, whoever asks.
      //
      // Checked **here**, before delegating, for the reason the queue's own decide path already
      // documents: `AutoGuideService.publish` enforces the rule by returning quietly, and silence
      // called from an endpoint is the worst available outcome — the audit entry says a reviewer
      // published it, the response is a 200, and the guide stays a draft with nothing anywhere
      // saying why. The first version of this endpoint did exactly that, and the suite caught it.
      //
      // The same error code and wording as the queue, so the two doors give one answer.
      if (guide.sources.length === 0) {
        throw ApiException.unprocessable(
          ApiErrorCode.INVALID_DECISION,
          'An auto-generated guide with no sources cannot be published. Reject it instead.',
          { data: { sources: 0 } },
        );
      }

      await this.autoGuides.publish(id, actor.id);

      // Belt and braces: `publish` is a `void` that can decline, so the row is read back rather
      // than assumed. A 200 over an unpublished guide is the thing this whole branch is avoiding.
      const after = await this.load(id);

      if (!after.publishedAt) {
        throw ApiException.unprocessable(
          ApiErrorCode.INVALID_DECISION,
          'That guide could not be published.',
        );
      }

      // §5.8 asks for the `AUTO_GUIDE` item to be resolved. The queue's decide path does its own
      // bookkeeping, so nothing does it when the publish comes from the editor instead — leaving
      // an item for a reviewer to pick up and find already done.
      await this.resolveAutoGuideItem(id, actor.id);

      const auditId = await this.audit.note({
        action: 'guide.published',
        targetType: 'GUIDE',
        targetId: id,
        targetLabel: guide.title,
        after: { published: true, isAutoGenerated: true },
        actorId: actor.id,
      });

      return { data: await this.toView(after), auditId };
    }

    const { auditId } = await this.audit.mutate(
      {
        action: 'guide.published',
        targetType: 'GUIDE',
        targetId: id,
        targetLabel: guide.title,
        before: { published: false },
        after: { published: true, isAutoGenerated: false },
      },
      async tx => {
        const now = new Date();

        await tx.guide.update({
          where: { id },
          data: {
            publishedAt: now,
            // Who stood behind it. `reviewedAt` without `reviewedById` would be a review nobody
            // is answerable for, which is the state §1.6.2 exists to prevent.
            reviewedAt: now,
            reviewedById: actor.id,
          },
        });

        // A staff-written guide that no queue item covers still has to be resolved if one exists —
        // a reviewer could have hidden it through §5.7 first.
        await tx.moderationQueueItem.updateMany({
          where: {
            targetType: ReportTargetType.GUIDE,
            targetId: id,
            state: { not: ModerationQueueState.RESOLVED },
          },
          data: {
            state: ModerationQueueState.RESOLVED,
            decision: ModerationDecision.APPROVE,
            decisionNote: 'Published from the guide editor.',
            decidedAt: now,
            decidedById: actor.id,
          },
        });
      },
    );

    return { data: await this.toView(await this.load(id)), auditId };
  }

  /** Takes a guide out of the feed without deleting it (§5.8). */
  async unpublish(actor: AdminPrincipal, id: string, dto: ReasonedDto) {
    const reason = dto.assertReasoned();
    const guide = await this.load(id);

    if (!guide.publishedAt) {
      throw ApiException.conflict(ApiErrorCode.INVALID_TRANSITION, 'That guide is not published.');
    }

    const { auditId } = await this.audit.mutate(
      {
        action: 'guide.unpublished',
        targetType: 'GUIDE',
        targetId: id,
        targetLabel: guide.title,
        before: { published: true, publishedAt: guide.publishedAt.toISOString() },
        after: { published: false },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
      },
      async tx => {
        // `publishedAt` only. The review stays recorded: somebody did read it, and clearing that
        // would make the next publish look like the first.
        await tx.guide.update({ where: { id }, data: { publishedAt: null } });
      },
    );

    return { data: await this.toView(await this.load(id)), auditId };
  }

  /**
   * Whether a guide was worth writing (§5.8's `GuidePerformance`).
   *
   * `reads` and the daily series come from `ActivityEvent` rather than `Guide.viewCount`, because
   * the counter has no dates on it — it can say how many reads there have ever been and nothing
   * about when. The counter is left alone: it is what the member-facing read path shows.
   *
   * `deflections` is the number that matters most and the one nobody would think to ask for: how
   * often somebody about to post a question read this instead, and how often they posted anyway.
   * A guide with a high read count and no deflections is being read by the wrong people.
   */
  async performance(id: string, query: GuidePerformanceDto) {
    await this.load(id);

    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * DAY_MS);
    const window = { gte: from, lt: to };

    const [views, uniqueReaders, progress, likes, bookmarks, feedback, deflections, series] =
      await Promise.all([
        this.database.activityEvent.count({
          where: {
            subject: ActivitySubject.GUIDE,
            subjectId: id,
            verb: ActivityVerb.VIEW,
            occurredAt: window,
          },
        }),
        // Signed-out reads have no `userId`, so this is "distinct members who read it" and not
        // "distinct readers" — which is why the two numbers are reported separately rather than a
        // ratio being implied between them.
        this.database.activityEvent
          .findMany({
            where: {
              subject: ActivitySubject.GUIDE,
              subjectId: id,
              verb: ActivityVerb.VIEW,
              occurredAt: window,
              userId: { not: null },
            },
            distinct: ['userId'],
            select: { userId: true },
          })
          .then(rows => rows.length),
        this.database.guideProgress.count({
          where: { guideId: id, progress: { gte: COMPLETION } },
        }),
        this.database.guideReaction.count({ where: { guideId: id } }),
        this.database.guideBookmark.count({ where: { guideId: id } }),
        this.database.guideFeedback.groupBy({
          by: ['useful'],
          where: { guideId: id },
          _count: { _all: true },
        }),
        this.database.guideDeflection.groupBy({
          by: ['outcome'],
          where: { guideId: id, createdAt: window },
          _count: { _all: true },
        }),
        this.database.$queryRaw<Array<{ day: Date; reads: bigint }>>`
          SELECT (a."occurred_at" AT TIME ZONE 'Europe/London')::date AS day,
                 COUNT(*)::bigint AS reads
          FROM "activity_events" a
          WHERE a."subject" = 'GUIDE' AND a."subject_id" = ${id}
            AND a."verb" = 'VIEW'
            AND a."occurred_at" >= ${from} AND a."occurred_at" < ${to}
          GROUP BY 1
          ORDER BY 1
        `,
      ]);

    const answered =
      deflections.find(row => row.outcome === DeflectionOutcome.ANSWERED)?._count._all ?? 0;
    const postedAnyway =
      deflections.find(row => row.outcome === DeflectionOutcome.POSTED_ANYWAY)?._count._all ?? 0;
    const shown = answered + postedAnyway;
    const byDay = new Map(
      series.map(row => [row.day.toISOString().slice(0, 10), Number(row.reads)]),
    );

    return {
      data: {
        reads: views,
        uniqueReaders,
        completions: progress,
        likes,
        bookmarks,
        usefulYes: feedback.find(row => row.useful)?._count._all ?? 0,
        usefulNo: feedback.find(row => !row.useful)?._count._all ?? 0,
        deflections: {
          answered,
          postedAnyway,
          // Null rather than zero when the interstitial has never been shown for this guide: a
          // rate of 0% reads as "it never helps anybody", and "we have not asked" is a different
          // thing.
          rate: shown ? answered / shown : null,
        },
        // Every day in the window, including the zeroes: a sparse series draws a line between two
        // points a fortnight apart and calls it a trend.
        series: this.days(from, to).map(day => ({ date: day, reads: byDay.get(day) ?? 0 })),
      },
    };
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

  /** Closes the queue item a published auto-guide came from. */
  private async resolveAutoGuideItem(guideId: string, actorId: string) {
    await this.database.moderationQueueItem.updateMany({
      where: {
        type: ModerationQueueType.AUTO_GUIDE,
        targetType: ReportTargetType.GUIDE,
        targetId: guideId,
        state: { not: ModerationQueueState.RESOLVED },
      },
      data: {
        state: ModerationQueueState.RESOLVED,
        decision: ModerationDecision.APPROVE,
        decisionNote: 'Published from the guide editor.',
        decidedAt: new Date(),
        decidedById: actorId,
      },
    });
  }

  private days(from: Date, to: Date): string[] {
    const out: string[] = [];

    for (let at = new Date(from); at < to; at = new Date(at.getTime() + DAY_MS)) {
      out.push(at.toISOString().slice(0, 10));
    }

    return out;
  }

  private async load(id: string) {
    // visibility: the staff editor, which reads a guide whatever state it is in — a draft, a held
    // one and an unpublished one are all things this screen exists to show.
    const guide = await this.database.guide.findFirst({
      where: { id, deletedAt: null },
      include: { sources: true },
    });

    if (!guide) throw ApiException.notFound('That guide could not be found.');

    return guide;
  }

  private async assertCity(cityId: string) {
    const city = await this.database.city.findUnique({ where: { id: cityId } });

    if (!city) {
      throw ApiException.badRequest(ApiErrorCode.VALIDATION_FAILED, 'That city does not exist.', {
        details: [{ field: 'cityId', message: 'Unknown city.' }],
      });
    }
  }

  /** The same scan a member's guide gets. Staff copy is the copy nobody else will check. */
  private async scan(
    tx: Prisma.TransactionClient,
    id: string,
    title: string,
    intro: string,
    blocks: Array<{ type: string; text: string }>,
  ) {
    await this.safety.assess(tx, {
      targetType: ReportTargetType.GUIDE,
      targetId: id,
      authorId: null,
      fields: {
        title,
        intro,
        ...Object.fromEntries(blocks.map((block, index) => [`step ${index + 1}`, block.text])),
      },
      trigger: ContentScanTrigger.EDIT,
      summary: title,
    });
  }

  private async toView(guide: Prisma.GuideGetPayload<{ include: { sources: true } }>) {
    const [topics, reviewer] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.GUIDE_TOPIC),
      guide.reviewedById
        ? this.database.user.findUnique({
            where: { id: guide.reviewedById },
            select: staffRefSelect,
          })
        : Promise.resolve(null),
    ]);

    return {
      id: guide.id,
      topic: {
        code: guide.topicCode,
        label: topics.get(guide.topicCode) ?? guide.topicCode,
      },
      title: guide.title,
      intro: guide.intro,
      blocks: (guide.blocks ?? []) as Array<{ type: string; text: string }>,
      resourceUrl: guide.resourceUrl,
      city: guide.cityId ? { id: guide.cityId } : null,
      isAutoGenerated: guide.isAutoGenerated,
      provenanceSummary: guide.provenanceSummary,
      sources: guide.sources.map(source => ({
        type: source.type,
        refId: source.refId,
        label: source.label,
      })),
      publishedAt: guide.publishedAt?.toISOString() ?? null,
      reviewedBy: reviewer ? toStaffRef(reviewer, this.media.sign) : null,
      visibilityState: guide.visibilityState,
      createdAt: guide.createdAt.toISOString(),
      updatedAt: guide.updatedAt.toISOString(),
    };
  }
}
