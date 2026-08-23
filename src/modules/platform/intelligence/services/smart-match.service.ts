import { Injectable } from '@nestjs/common';
import { BriefUrgency } from '@prisma/client';
import { distanceMiles } from '@/common';

export interface MatchCandidateInput {
  listingId: string;
  userId: string;
  professionTitle: string;
  ratingAverage: number;
  ratingCount: number;
  jobsCompleted: number;
  medianResponseMinutes: number | null;
  priceFrom: number | null;
  cityId: string;
  latitude: number | null;
  longitude: number | null;
  isAcceptingWork: boolean;
  /** Similar jobs this professional has completed, for the rationale. */
  similarJobs: number;
}

export interface BriefInput {
  categoryCode: string;
  cityId: string | null;
  latitude: number | null;
  longitude: number | null;
  budget: number | null;
  urgency: BriefUrgency;
}

export type ScoreQualifier = 'EXCELLENT' | 'GOOD' | 'FAIR';

export interface ScoredMatch {
  listingId: string;
  userId: string;
  rank: number;
  totalScore: number;
  scores: {
    rating: { value: number; qualifier: ScoreQualifier };
    distance: { value: number; qualifier: ScoreQualifier };
    price: { value: number; qualifier: ScoreQualifier };
    response: { value: number; qualifier: ScoreQualifier };
  };
  priceForBrief: number | null;
  rationale: string | null;
}

/**
 * Circl Intelligence: Smart Match, which powers "Circl Handle It".
 *
 * "Briefs are scored against professional rating, distance, price fit, and
 * response time to surface the best three matches."
 *
 * Those are exactly the four axes the client renders as mini-bars, so they are
 * computed here as 0..1 with a one-word qualifier — server-side, so the bars and
 * their labels agree everywhere (2.8.2). No model: a member is being told why
 * these three people and not others, and a weighted sum is the only version of
 * that which can be explained truthfully.
 */
@Injectable()
export class SmartMatchService {
  /** At most 3, ranked. Fewer is allowed and the client says so honestly. */
  static readonly SHORTLIST_SIZE = 3;

  private static readonly WEIGHTS = {
    rating: 0.35,
    distance: 0.2,
    price: 0.25,
    response: 0.2,
  };

  /** Beyond this a "local" professional is not local. */
  private static readonly MAX_USEFUL_MILES = 50;

  /** Beyond this, response time stops distinguishing anyone: they are all slow. */
  private static readonly MAX_USEFUL_RESPONSE_MINUTES = 48 * 60;

  match(brief: BriefInput, candidates: MatchCandidateInput[]): ScoredMatch[] {
    const origin =
      brief.latitude !== null && brief.longitude !== null
        ? { latitude: brief.latitude, longitude: brief.longitude }
        : null;

    return candidates
      .filter(candidate => candidate.isAcceptingWork)
      .map(candidate => {
        const rating = this.ratingScore(candidate);
        const distance = this.distanceScore(brief, candidate, origin);
        const price = this.priceScore(brief, candidate);
        const response = this.responseScore(brief, candidate);

        const weights = SmartMatchService.WEIGHTS;
        const totalScore =
          rating * weights.rating +
          distance * weights.distance +
          price * weights.price +
          response * weights.response;

        return {
          listingId: candidate.listingId,
          userId: candidate.userId,
          rank: 0,
          totalScore: Number(totalScore.toFixed(4)),
          scores: {
            rating: { value: round(rating), qualifier: qualify(rating) },
            distance: { value: round(distance), qualifier: qualify(distance) },
            price: { value: round(price), qualifier: qualify(price) },
            response: { value: round(response), qualifier: qualify(response) },
          },
          priceForBrief: candidate.priceFrom,
          rationale: this.rationale(brief, candidate, { rating, distance, price, response }),
        };
      })
      .sort((a, b) => b.totalScore - a.totalScore)
      .slice(0, SmartMatchService.SHORTLIST_SIZE)
      .map((match, index) => ({ ...match, rank: index + 1 }));
  }

  /**
   * Rating, discounted by how few people said it.
   *
   * A single 5-star review is not evidence of a 5-star professional, and ranking
   * it above someone with thirty 4.8s would be the matcher's most visible
   * mistake — the member picks one of three and finds out later.
   */
  private ratingScore(candidate: MatchCandidateInput): number {
    if (candidate.ratingCount === 0) {
      // Unrated is not bad, it is unknown. A neutral score lets a new
      // professional appear when there is nobody better, without displacing a
      // proven one.
      return 0.5;
    }

    const confidence = Math.min(1, Math.log1p(candidate.ratingCount) / Math.log(15));

    return (candidate.ratingAverage / 5) * confidence + 0.5 * (1 - confidence);
  }

  private distanceScore(
    brief: BriefInput,
    candidate: MatchCandidateInput,
    origin: { latitude: number; longitude: number } | null,
  ): number {
    if (origin) {
      const miles = distanceMiles(origin, candidate);

      if (miles === null) return 0.5;

      return Math.max(0, 1 - miles / SmartMatchService.MAX_USEFUL_MILES);
    }

    // No coordinates: fall back to the coarse signal we do have, rather than
    // inventing a distance (D25).
    if (!brief.cityId) return 0.5;

    return candidate.cityId === brief.cityId ? 1 : 0.3;
  }

  /**
   * How well the price fits the budget.
   *
   * Under budget is a full score rather than a bonus — cheapest is not best, and
   * rewarding it would quietly turn Smart Match into a race to the bottom for
   * every professional listed.
   */
  private priceScore(brief: BriefInput, candidate: MatchCandidateInput): number {
    if (brief.budget === null || candidate.priceFrom === null) return 0.5;
    if (candidate.priceFrom <= brief.budget) return 1;

    const overBy = (candidate.priceFrom - brief.budget) / brief.budget;

    return Math.max(0, 1 - overBy);
  }

  /** Weighted by urgency: a slow reply costs more on an ASAP brief. */
  private responseScore(brief: BriefInput, candidate: MatchCandidateInput): number {
    if (candidate.medianResponseMinutes === null) return 0.5;

    const base = Math.max(
      0,
      1 - candidate.medianResponseMinutes / SmartMatchService.MAX_USEFUL_RESPONSE_MINUTES,
    );

    switch (brief.urgency) {
      case BriefUrgency.ASAP:
        // Squared, so the gap between a two-hour and a two-day reply widens.
        return base ** 2 * 0.5 + base * 0.5;
      case BriefUrgency.FLEXIBLE:
        // Flattened toward neutral: on a flexible brief, response time should not
        // decide it.
        return 0.5 + base * 0.5;
      default:
        return base;
    }
  }

  /**
   * A plain sentence, or null.
   *
   * "If the matcher cannot produce an honest one, send null rather than a
   * template. A wrong explanation is worse than none." So each clause below is
   * only emitted when the fact behind it is actually true of this candidate.
   */
  private rationale(
    brief: BriefInput,
    candidate: MatchCandidateInput,
    scores: { rating: number; distance: number; price: number; response: number },
  ): string | null {
    const clauses: string[] = [];

    if (candidate.ratingCount >= 3 && candidate.ratingAverage >= 4.5) {
      clauses.push(`rated ${candidate.ratingAverage.toFixed(1)} by ${candidate.ratingCount} people`);
    }

    if (candidate.similarJobs >= 3) {
      clauses.push(`has done ${candidate.similarJobs} similar jobs`);
    }

    if (brief.budget !== null && candidate.priceFrom !== null && scores.price === 1) {
      clauses.push('within your budget');
    }

    if (scores.distance >= 0.9 && brief.cityId && candidate.cityId === brief.cityId) {
      clauses.push('based in your city');
    }

    if (
      candidate.medianResponseMinutes !== null &&
      candidate.medianResponseMinutes <= 240 &&
      brief.urgency === BriefUrgency.ASAP
    ) {
      clauses.push('usually replies within a few hours');
    }

    if (!clauses.length) return null;

    const sentence = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(', ')} and ${clauses.at(-1)}`;

    return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
  }
}

const round = (value: number): number => Number(Math.max(0, Math.min(1, value)).toFixed(2));

/**
 * The one-word label beside each bar. Computed here so the bar and its label can
 * never disagree, which they would if the client thresholded the number itself.
 */
const qualify = (value: number): ScoreQualifier =>
  value >= 0.85 ? 'EXCELLENT' : value >= 0.6 ? 'GOOD' : 'FAIR';
