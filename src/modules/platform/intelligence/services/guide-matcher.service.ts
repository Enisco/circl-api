import { Injectable } from '@nestjs/common';
import { RequestStatus } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  daysAgo,
  keywordCoverage,
  keywordOverlapCount,
  keywordSimilarity,
  keywords,
  questionSignature,
} from '@/common';

export interface MatchCandidate {
  type: 'GUIDE' | 'RESOLVED_REQUEST';
  id: string;
  confidence: number;
}

export interface MatchResult {
  matches: MatchCandidate[];
  similarAskCount: number;
}

/**
 * Circl Intelligence: Auto-Guides and the "Before you post" interstitial.
 *
 * Two jobs, one measure of similarity:
 *
 *   1. `POST /community/guides/match` (1.6.5) — before a member posts, does an
 *      existing guide or resolved request already answer this?
 *   2. Question clustering — when three or more members ask the same thing, that
 *      is a guide waiting to be written.
 *
 * The similarity is keyword overlap (Jaccard) narrowed by a Postgres trigram
 * prefilter. Not embeddings, and the constraint is stated plainly in the spec:
 * this call sits between a member tapping Post and their post existing, and must
 * answer in under 400ms. A network round trip to an embedding API cannot promise
 * that, and if it is slow or errors the client posts anyway — so a slow clever
 * matcher degrades to no matcher at all, which is strictly worse than a fast
 * plain one.
 */
@Injectable()
export class GuideMatcherService {
  /** Below this, return nothing and let the member post straight through (1.6.5). */
  private static readonly MIN_CONFIDENCE = 0.8;

  /** At most 2 matches. More is a wall, not a nudge. */
  private static readonly MAX_MATCHES = 2;

  /** "1 person asked something similar" is not a reason to interrupt anyone. */
  private static readonly MIN_SIMILAR_ASKS = 3;

  constructor(private readonly database: PrismaService) {}

  async match(input: {
    categoryCode: string;
    title: string;
    description?: string;
    cityId?: string;
  }): Promise<MatchResult> {
    const draftText = [input.title, input.description].filter(Boolean).join(' ');
    const draftKeywords = keywords(draftText);

    if (draftKeywords.length < 2) {
      // Two words of signal is not enough to claim a match, and a wrong match
      // here costs the member a wasted screen at the exact moment they are trying
      // to ask for help.
      return { matches: [], similarAskCount: 0 };
    }

    const [guides, resolved, similarAskCount] = await Promise.all([
      this.candidateGuides(input, draftKeywords),
      this.candidateResolvedRequests(input, draftKeywords),
      this.countSimilarAsks(input.categoryCode, input.cityId, draftKeywords),
    ]);

    const matches = [...guides, ...resolved]
      .filter(candidate => candidate.confidence >= GuideMatcherService.MIN_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, GuideMatcherService.MAX_MATCHES);

    return {
      matches,
      // Omitted below the threshold, so the client's "Circl noticed, 12 people
      // asked something similar" line only appears when it is true.
      similarAskCount:
        similarAskCount >= GuideMatcherService.MIN_SIMILAR_ASKS ? similarAskCount : 0,
    };
  }

  private async candidateGuides(
    _input: { title: string; cityId?: string },
    draftKeywords: string[],
  ): Promise<MatchCandidate[]> {
    // The trigram index narrows this to a handful before the exact scoring runs,
    // which is what keeps the whole call inside its latency budget.
    const guides = await this.database.guide.findMany({
      where: {
        deletedAt: null,
        publishedAt: { not: null },
        OR: draftKeywords.slice(0, 6).map(word => ({
          OR: [
            { title: { contains: word, mode: 'insensitive' as const } },
            { intro: { contains: word, mode: 'insensitive' as const } },
          ],
        })),
      },
      select: { id: true, title: true, intro: true, viewCount: true },
      take: 25,
    });

    return guides.map(guide => ({
      type: 'GUIDE' as const,
      id: guide.id,
      confidence: this.confidence(draftKeywords, guide.title, guide.intro, {
        // A guide is written to answer a question, so it is a better answer than a
        // thread even at equal word overlap.
        boost: 0.1,
      }),
    }));
  }

  private async candidateResolvedRequests(
    input: { categoryCode: string },
    draftKeywords: string[],
  ): Promise<MatchCandidate[]> {
    const requests = await this.database.communityRequest.findMany({
      where: {
        deletedAt: null,
        status: RequestStatus.RESOLVED,
        categoryCode: input.categoryCode,
        replyCount: { gt: 0 },
        OR: draftKeywords.slice(0, 6).map(word => ({
          title: { contains: word, mode: 'insensitive' as const },
        })),
      },
      select: { id: true, title: true, description: true, helperCount: true },
      orderBy: { helperCount: 'desc' },
      take: 25,
    });

    return requests.map(request => ({
      type: 'RESOLVED_REQUEST' as const,
      id: request.id,
      confidence: this.confidence(
        draftKeywords,
        request.title,
        request.description ?? '',
        // A thread nobody answered is not an answer, however similar the question.
        { boost: request.helperCount > 0 ? 0.05 : -0.15 },
      ),
    }));
  }

  /**
   * How many people asked something similar recently. This is also the signal
   * that produces an Auto-Guide cluster once it crosses the threshold.
   */
  private async countSimilarAsks(
    categoryCode: string,
    cityId: string | undefined,
    draftKeywords: string[],
  ): Promise<number> {
    const requests = await this.database.communityRequest.findMany({
      where: {
        deletedAt: null,
        categoryCode,
        createdAt: { gte: daysAgo(90) },
        ...(cityId ? { cityId } : {}),
        OR: draftKeywords.slice(0, 6).map(word => ({
          title: { contains: word, mode: 'insensitive' as const },
        })),
      },
      select: { title: true, authorId: true },
      take: 200,
    });

    // Distinct people, not distinct posts: one member asking five times is one
    // person who could not find the answer, not five.
    const askers = new Set<string>();

    for (const request of requests) {
      if (keywordSimilarity(draftKeywords, keywords(request.title)) >= 0.35) {
        askers.add(request.authorId);
      }
    }

    return askers.size;
  }

  /**
   * How confident we are that this candidate answers the draft question.
   *
   * The measure is COVERAGE, not similarity: of the words the member used, how
   * many does the candidate cover? A thorough guide is longer than the question
   * it answers, and a symmetric measure punishes it for exactly the thoroughness
   * that makes it the right answer. That mistake is what made this matcher return
   * nothing for "how do I open a bank account without proof of address" against a
   * guide literally titled "Opening a UK bank account with no proof of address".
   *
   * The title is weighted above the body because a title is the question the
   * guide claims to answer, whereas a body mentions many things in passing.
   */
  private confidence(
    draftKeywords: string[],
    titleText: string,
    bodyText: string,
    options: { boost: number },
  ): number {
    const titleKeywords = keywords(titleText);
    const bodyKeywords = keywords(bodyText);
    const allKeywords = [...new Set([...titleKeywords, ...bodyKeywords])];

    const shared = keywordOverlapCount(draftKeywords, allKeywords);

    // A floor against generic overlaps: one shared word is a coincidence, however
    // short the question was.
    if (shared < 2) return 0;

    const titleCoverage = keywordCoverage(draftKeywords, titleKeywords);
    const bodyCoverage = keywordCoverage(draftKeywords, allKeywords);
    const coverage = titleCoverage * 0.7 + bodyCoverage * 0.3;

    return Math.max(0, Math.min(1, coverage + options.boost));
  }

  /** The normalised phrase a cluster forms around. Shared with the Auto-Guide job. */
  signatureOf(text: string): string {
    return questionSignature(text);
  }
}
