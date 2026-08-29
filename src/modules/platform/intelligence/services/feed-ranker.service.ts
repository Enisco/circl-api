import { Injectable } from '@nestjs/common';
import { FeedItemType } from '@prisma/client';

export interface RankableItem {
  type: FeedItemType;
  id: string;
  createdAt: Date;
  cityId: string | null;
  categoryCode: string | null;
  /** Replies plus reactions plus offers — whatever the type has. */
  engagement: number;
  /** A request needed within days is urgent in a way an evergreen offer is not. */
  neededOn?: Date | null;
  authorId: string;
}

export interface ViewerSignals {
  cityId: string | null;
  journeyStage: string | null;
  interests: string[];
  /** Category codes this member has engaged with, weighted by how much. */
  affinity: Map<string, number>;
  /** Ids this member asked to see less of. */
  suppressed: Set<string>;
}

export type RankingSignal =
  | 'CITY_MATCH'
  | 'JOURNEY_STAGE'
  | 'CATEGORY_AFFINITY'
  | 'URGENT'
  | 'RECENT'
  | 'POPULAR';

export interface RankedItem {
  item: RankableItem;
  score: number;
  signals: RankingSignal[];
  reason: string | null;
}

/** Circl Intelligence: the feed ranker. */
@Injectable()
export class FeedRankerService {
  private static readonly WEIGHTS = {
    cityMatch: 30,
    journeyStage: 10,
    categoryAffinity: 25,
    interestMatch: 15,
    urgency: 35,
    engagement: 12,
    recencyMax: 40,
  };

  /** Hours after which a post has lost half its recency score. */
  private static readonly RECENCY_HALF_LIFE_HOURS = 36;

  /** D3: offers decay roughly four times faster than requests. */
  private static readonly OFFER_DECAY_MULTIPLIER = 4;

  rank(items: RankableItem[], viewer: ViewerSignals, now = new Date()): RankedItem[] {
    return items
      .filter(item => !viewer.suppressed.has(item.id))
      .map(item => this.score(item, viewer, now))
      .sort((a, b) => b.score - a.score);
  }

  private score(item: RankableItem, viewer: ViewerSignals, now: Date): RankedItem {
    const weights = FeedRankerService.WEIGHTS;
    const signals: RankingSignal[] = [];
    let score = 0;

    if (viewer.cityId && item.cityId === viewer.cityId) {
      score += weights.cityMatch;
      signals.push('CITY_MATCH');
    }

    const affinity = item.categoryCode ? (viewer.affinity.get(item.categoryCode) ?? 0) : 0;

    if (affinity > 0) {
      // Saturating rather than linear: someone who has opened forty housing posts should not have a feed that is only housing.
      score += weights.categoryAffinity * Math.min(1, Math.log1p(affinity) / Math.log(10));
      signals.push('CATEGORY_AFFINITY');
    }

    if (item.categoryCode && viewer.interests.includes(item.categoryCode)) {
      score += weights.interestMatch;

      if (!signals.includes('CATEGORY_AFFINITY')) signals.push('CATEGORY_AFFINITY');
    }

    if (viewer.journeyStage && this.stageMatchesCategory(viewer.journeyStage, item.categoryCode)) {
      score += weights.journeyStage;
      signals.push('JOURNEY_STAGE');
    }

    if (item.neededOn) {
      const daysUntil = (item.neededOn.getTime() - now.getTime()) / 86_400_000;

      // Only future deadlines count, and only within a fortnight.
      if (daysUntil >= 0 && daysUntil <= 14) {
        score += weights.urgency * (1 - daysUntil / 14);
        signals.push('URGENT');
      }
    }

    if (item.engagement > 0) {
      score += weights.engagement * Math.min(1, Math.log1p(item.engagement) / Math.log(20));

      if (item.engagement >= 5) signals.push('POPULAR');
    }

    const ageHours = Math.max(0, (now.getTime() - item.createdAt.getTime()) / 3_600_000);
    const halfLife =
      item.type === FeedItemType.OFFER
        ? FeedRankerService.RECENCY_HALF_LIFE_HOURS / FeedRankerService.OFFER_DECAY_MULTIPLIER
        : FeedRankerService.RECENCY_HALF_LIFE_HOURS;
    const recency = weights.recencyMax * Math.pow(0.5, ageHours / halfLife);

    score += recency;

    if (ageHours <= 24) signals.push('RECENT');

    return { item, score, signals, reason: this.reasonFor(signals, viewer) };
  }

  /** A display sentence for "Why this?", or null. */
  private reasonFor(signals: RankingSignal[], viewer: ViewerSignals): string | null {
    const parts: string[] = [];

    if (signals.includes('JOURNEY_STAGE') && viewer.journeyStage) {
      parts.push(`you're ${this.stagePhrase(viewer.journeyStage)}`);
    }

    if (signals.includes('CATEGORY_AFFINITY')) {
      parts.push('it matches what you follow');
    }

    if (signals.includes('URGENT')) {
      parts.push('someone needs help soon');
    }

    if (!parts.length) return null;

    const cityClause = signals.includes('CITY_MATCH') ? ' and this is near you' : '';

    return `Because ${parts.join(', ')}${cityClause}.`;
  }

  /** Which categories matter at which point in someone's arrival. */
  private stageMatchesCategory(stage: string, categoryCode: string | null): boolean {
    if (!categoryCode) return false;

    const byStage: Record<string, string[]> = {
      PLANNING: ['VISA_DOCS', 'ACCOMMODATION', 'UNIVERSITY_STUDY', 'JOBS', 'AIRPORT_PICKUP'],
      JUST_ARRIVED: [
        'AIRPORT_PICKUP',
        'BANK_ACCOUNT',
        'NHS_HEALTHCARE',
        'ACCOMMODATION',
        'SHOPPING_ERRANDS',
        'VISA_DOCS',
        'SETTLING_IN',
      ],
      SETTLING_IN: [
        'JOBS',
        'JOB_SEARCH',
        'MAKE_FRIENDS',
        'LANGUAGE_HELP',
        'CHILDCARE',
        'TRANSPORT',
      ],
      ESTABLISHED: ['JOBS', 'BUSINESS_SETUP', 'CHILDREN_FAMILY', 'LEGAL_RIGHTS', 'REPAIRS_HANDY'],
      CITIZEN_SETTLED: ['BUSINESS_SETUP', 'CHILDREN_FAMILY', 'MAKE_FRIENDS'],
    };

    return byStage[stage]?.includes(categoryCode) ?? false;
  }

  private stagePhrase(stage: string): string {
    switch (stage) {
      case 'PLANNING':
        return 'planning your move';
      case 'JUST_ARRIVED':
        return 'newly arrived';
      case 'SETTLING_IN':
        return 'settling in';
      default:
        return 'settled here';
    }
  }
}
