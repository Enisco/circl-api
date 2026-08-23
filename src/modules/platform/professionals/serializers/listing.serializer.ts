import {
  DeliveryMode,
  ExperienceLevel,
  ListingVerificationStatus,
  PriceBasis,
  Prisma,
} from '@prisma/client';
import { money } from '@/common';
import { AuthorView, CityView, TermView } from '../../shared';

export interface ProfessionalSummaryView {
  /** The discriminator that lets `listingType=BOTH` mix listings and offers (D14). */
  type: 'PROFESSIONAL';
  id: string;
  user: AuthorView;
  professionTitle: string;
  category: TermView | null;
  categories: TermView[];
  city: CityView | null;
  /** Null unless `nearMe` was set. Never a city-centre estimate (D25). */
  distanceMiles: number | null;
  rating: { average: number; count: number; excludedCount: number };
  medianResponseMinutes: number | null;
  priceFrom: { amount: number; currency: string } | null;
  priceBasis: PriceBasis;
  isAcceptingWork: boolean;
  trustChecks: string[];
  isImmigrantFriendly: boolean;
  /**
   * D13: with nothing verified, a regulated profile must say so. This is what
   * lets the client print the visible line rather than implying a check happened.
   */
  isRegulated: boolean;
  verificationStatus: ListingVerificationStatus;
}

export interface ProfessionalServiceView {
  id: string;
  name: string;
  description: string | null;
  price: { amount: number; currency: string } | null;
  priceBasis: PriceBasis;
  isActive: boolean;
}

export interface ProfessionalProfileView
  extends Omit<ProfessionalSummaryView, 'type' | 'category'> {
  experienceLevel: ExperienceLevel;
  yearsExperience: number | null;
  about: string;
  deliveryMode: DeliveryMode;
  ratingDistribution: Record<string, number>;
  stats: { jobsCompleted: number; medianResponseMinutes: number | null; profileViews: number };
  services: ProfessionalServiceView[];
  trust: { checks: Array<Record<string, unknown>> };
  communityProfileUrl: string;
  viewer: {
    isOwner: boolean;
    hasBookedBefore: boolean;
    canLeavePriorWorkReview: boolean;
    conversationId: string | null;
  };
}

export const listingInclude = {
  user: { select: { id: true } },
  city: { select: { id: true, name: true, region: true } },
  categories: true,
  services: { where: { isActive: true }, orderBy: { sort: 'asc' } },
} satisfies Prisma.ProfessionalListingInclude;

export const toServiceView = (service: {
  id: string;
  name: string;
  description: string | null;
  price: number | null;
  priceBasis: PriceBasis;
  currency: string;
  isActive: boolean;
}): ProfessionalServiceView => ({
  // Required: each service row is individually bookable and the booking call
  // sends this id, not the name and price (2.4).
  id: service.id,
  name: service.name,
  description: service.description,
  price: money(service.price, service.currency),
  priceBasis: service.priceBasis,
  isActive: service.isActive,
});
