import { Injectable, Logger } from '@nestjs/common';
import {
  GuideBlockType,
  GuideSourceType,
  ModerationQueueType,
  ReportTargetType,
  RequestStatus,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { daysAgo, keywordSimilarity, keywords, readTimeMinutes, toJson } from '@/common';

/** "When three or more members ask the same question" — the threshold is the spec's. */
const CLUSTER_THRESHOLD = 3;

/** How similar two questions must be to be the same question. */
const SIMILARITY = 0.4;

/** How far back the clustering looks. */
const WINDOW_DAYS = 120;

/**
 * Circl Intelligence: Auto-Guides.
 *
 * "When three or more members ask the same question, the system drafts a Guide
 * and cites the most helpful comments."
 *
 * Two things this does that matter more than the clustering:
 *
 * It never publishes. A drafted guide goes into the moderation queue for a human
 * to approve, and `publishedAt` stays null until they do. Machine-drafted content
 * reaching members unreviewed is the fastest way to lose a community's trust.
 *
 * It cites its sources, and the guide model REJECTS an auto-generated guide with
 * none (1.6.2). The draft is assembled from real answers real people wrote, with
 * a provenance line naming how many — so a reader can see where it came from
 * rather than being told to trust it.
 *
 * The drafting is extraction, not generation: it takes the most-credited answers
 * verbatim as steps. That is deliberate. A model rewriting immigration advice
 * into cleaner prose is a model introducing errors into immigration advice.
 */
@Injectable()
export class AutoGuideService {
  private readonly logger = new Logger(AutoGuideService.name);

  constructor(private readonly database: PrismaService) {}

  /**
   * Finds clusters of repeated questions and drafts one guide per cluster that
   * has enough answered material to be worth a human's time.
   */
  async run(): Promise<{ clusters: number; drafted: number }> {
    const requests = await this.database.communityRequest.findMany({
      where: {
        deletedAt: null,
        createdAt: { gte: daysAgo(WINDOW_DAYS) },
        visibility: 'PUBLIC',
      },
      select: {
        id: true,
        title: true,
        description: true,
        categoryCode: true,
        cityId: true,
        authorId: true,
        status: true,
        replyCount: true,
        createdAt: true,
      },
      take: 2000,
    });

    const clusters = this.cluster(requests);
    let drafted = 0;

    for (const cluster of clusters) {
      if (cluster.askers.size < CLUSTER_THRESHOLD) continue;

      const row = await this.database.questionCluster.upsert({
        where: {
          categoryCode_cityId_signature: {
            categoryCode: cluster.categoryCode,
            cityId: cluster.cityId ?? '',
            signature: cluster.signature,
          },
        },
        update: {
          askCount: cluster.askers.size,
          requestIds: toJson(cluster.requestIds),
          lastAskedAt: cluster.lastAskedAt,
          label: cluster.label,
        },
        create: {
          categoryCode: cluster.categoryCode,
          cityId: cluster.cityId ?? '',
          signature: cluster.signature,
          label: cluster.label,
          requestIds: toJson(cluster.requestIds),
          askCount: cluster.askers.size,
          firstAskedAt: cluster.firstAskedAt,
          lastAskedAt: cluster.lastAskedAt,
        },
      });

      // Already drafted once. Redrafting on every run would put the same guide in
      // front of a reviewer every night.
      if (row.draftedGuideId) continue;

      const guideId = await this.draft(row.id, cluster);

      if (guideId) drafted += 1;
    }

    return { clusters: clusters.length, drafted };
  }

  /**
   * Groups requests by (category, city) and then by keyword similarity within the
   * group. Single-link agglomeration over a small set — readable, and the whole
   * job is one background pass rather than a per-request cost.
   */
  private cluster(
    requests: Array<{
      id: string;
      title: string;
      description: string | null;
      categoryCode: string;
      cityId: string;
      authorId: string;
      createdAt: Date;
    }>,
  ) {
    const groups = new Map<string, typeof requests>();

    for (const request of requests) {
      const key = `${request.categoryCode}:${request.cityId}`;

      groups.set(key, [...(groups.get(key) ?? []), request]);
    }

    const clusters: Array<{
      categoryCode: string;
      cityId: string | null;
      signature: string;
      label: string;
      requestIds: string[];
      askers: Set<string>;
      firstAskedAt: Date;
      lastAskedAt: Date;
    }> = [];

    for (const [key, group] of groups) {
      const [categoryCode, cityId] = key.split(':');
      const buckets: Array<{ words: string[]; members: typeof group }> = [];

      for (const request of group) {
        const words = keywords(`${request.title} ${request.description ?? ''}`);

        if (words.length < 2) continue;

        const bucket = buckets.find(
          candidate => keywordSimilarity(words, candidate.words) >= SIMILARITY,
        );

        if (bucket) {
          bucket.members.push(request);
          // The bucket's signature is the words its members share, which keeps it
          // from drifting as loosely-related questions join.
          bucket.words = bucket.words.filter(word => words.includes(word));
        } else {
          buckets.push({ words, members: [request] });
        }
      }

      for (const bucket of buckets) {
        if (bucket.members.length < CLUSTER_THRESHOLD) continue;

        const dates = bucket.members.map(member => member.createdAt.getTime());

        clusters.push({
          categoryCode,
          cityId: cityId || null,
          signature: [...bucket.words].sort().join(' '),
          // The longest title in the cluster reads best as a heading: it is the
          // one that spelled the question out.
          label: bucket.members.reduce((a, b) => (a.title.length >= b.title.length ? a : b)).title,
          requestIds: bucket.members.map(member => member.id),
          askers: new Set(bucket.members.map(member => member.authorId)),
          firstAskedAt: new Date(Math.min(...dates)),
          lastAskedAt: new Date(Math.max(...dates)),
        });
      }
    }

    return clusters;
  }

  /**
   * Drafts one guide from a cluster's best answers, unpublished, and queues it
   * for a human.
   */
  private async draft(
    clusterId: string,
    cluster: { categoryCode: string; cityId: string | null; label: string; requestIds: string[]; askers: Set<string> },
  ): Promise<string | null> {
    // Only credited or well-received answers. An unanswered thread has nothing to
    // extract, and an uncredited reply is not evidence of anything.
    const responses = await this.database.requestResponse.findMany({
      where: {
        requestId: { in: cluster.requestIds },
        deletedAt: null,
        isPrivate: false,
        content: { not: '' },
      },
      include: {
        author: { select: { firstName: true, lastName: true } },
        request: {
          select: {
            status: true,
            helpers: { select: { userId: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 60,
    });

    const useful = responses
      .map(response => ({
        response,
        // A credited helper's answer is the strongest evidence available that it
        // actually helped somebody.
        credited: response.request.helpers.some(helper => helper.userId === response.authorId),
      }))
      .filter(
        entry =>
          (entry.credited ||
            (entry.response.isHelpOffer && entry.response.request.status === RequestStatus.RESOLVED)) &&
          entry.response.content.trim().length >= 60,
      )
      .slice(0, 8);

    if (useful.length < 2) {
      // Not enough answered material. A guide drafted from one reply is not a
      // guide; it is a reply with a title on it.
      return null;
    }

    const steps = useful.map(entry => entry.response.content.trim().slice(0, 2000));
    const intro =
      `${cluster.askers.size} members have asked about this recently. ` +
      'This guide collects what other members answered, in their own words.';

    const guide = await this.database.$transaction(async tx => {
      const created = await tx.guide.create({
        data: {
          authorId: null,
          topicCode: await this.topicFor(cluster.categoryCode),
          title: cluster.label.slice(0, 140),
          intro,
          blocks: toJson(steps.map(text => ({ type: GuideBlockType.STEP, text }))),
          cityId: cluster.cityId || null,
          readTimeMinutes: readTimeMinutes([intro, ...steps].join(' ')),
          isAutoGenerated: true,
          // Required when isAutoGenerated (1.6.2). Machine-drafted content with no
          // visible provenance is the fastest way to lose a community's trust.
          provenanceSummary: `Drafted by Circl from ${useful.length} community answers`,
          // Stays null until a human approves it. Nothing here reaches a member
          // unreviewed.
          publishedAt: null,
          sources: {
            create: useful.map(entry => ({
              type: GuideSourceType.REQUEST_RESPONSE,
              refId: entry.response.id,
              label: `Reply by ${entry.response.author.firstName} ${entry.response.author.lastName.charAt(0)}.`,
              requestResponseId: entry.response.id,
            })),
          },
        },
      });

      await tx.questionCluster.update({
        where: { id: clusterId },
        data: { draftedGuideId: created.id },
      });

      await tx.moderationQueueItem.upsert({
        where: {
          type_targetType_targetId: {
            type: ModerationQueueType.AUTO_GUIDE,
            targetType: ReportTargetType.GUIDE,
            targetId: created.id,
          },
        },
        update: {},
        create: {
          type: ModerationQueueType.AUTO_GUIDE,
          targetType: ReportTargetType.GUIDE,
          targetId: created.id,
          summary: created.title,
          payload: toJson({
            askCount: cluster.askers.size,
            sourceCount: useful.length,
            clusterId,
          }),
        },
      });

      return created;
    });

    this.logger.log(`Drafted auto-guide ${guide.id} from ${useful.length} answers`);

    return guide.id;
  }

  /** Publishes an approved draft. Called by the admin decision path. */
  async publish(guideId: string, reviewerId: string): Promise<void> {
    const guide = await this.database.guide.findUnique({
      where: { id: guideId },
      include: { sources: true },
    });

    if (!guide) return;

    // The same rule the create endpoint enforces: an auto-generated guide with no
    // sources is never published, whoever asks.
    if (guide.isAutoGenerated && guide.sources.length === 0) return;

    await this.database.guide.update({
      where: { id: guideId },
      data: { publishedAt: new Date(), reviewedAt: new Date(), reviewedById: reviewerId },
    });
  }

  /** Maps a community category onto a guide topic, defaulting rather than failing. */
  private async topicFor(categoryCode: string): Promise<string> {
    const map: Record<string, string> = {
      VISA_DOCS: 'VISA_DOCS',
      LEGAL_RIGHTS: 'VISA_DOCS',
      BANK_ACCOUNT: 'FINANCE',
      BENEFITS_SUPPORT: 'FINANCE',
      NHS_HEALTHCARE: 'HEALTH',
      MENTAL_HEALTH: 'HEALTH',
      ACCOMMODATION: 'HOUSING',
      JOBS: 'JOBS',
      JOB_SEARCH: 'JOBS',
      TRANSPORT: 'TRANSPORT',
      AIRPORT_PICKUP: 'TRANSPORT',
      MOVING_HELP: 'TRANSPORT',
      UNIVERSITY_STUDY: 'EDUCATION',
      LANGUAGE_HELP: 'EDUCATION',
    };

    return map[categoryCode] ?? 'CULTURE';
  }
}
