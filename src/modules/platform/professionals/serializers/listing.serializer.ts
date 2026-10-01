import {
  DeliveryMode,
  ExperienceLevel,
  ListingVerificationStatus,
  PriceBasis,
  Prisma,
} from '@prisma/client';
import { money } from '@/common';
import { AuthorView, CityView, TermView, toPriceBasisLabel } from '../../shared';

export interface ProfessionalSummaryView {
  /** The discriminator that lets `listingType=BOTH` mix listings and offers (D14). */
  type: 'PROFESSIONAL';
  id: string;
  user: AuthorView;
  professionTitle: string;
  /**
   * The listing's own picture, null when it has none — which is normal rather than a gap: the
   * client falls back to `user.avatarUrl`, so a member who touches nothing sees what they saw
   * before the field existed.
   */
  photoUrl: string | null;
  /** Null keeps the gradient the header has always had. */
  coverUrl: string | null;
  category: TermView | null;
  categories: TermView[];
  city: CityView | null;
  /** Null unless `nearMe` was set. Never a city-centre estimate (D25). */
  distanceMiles: number | null;
  /** True when the searched city ran out and this row was pulled in to fill the page. */
  isNearbyCity?: boolean;
  /** City centre to city centre, for the "12 miles away" line. Null for an in-city row. */
  milesFromSearchedCity?: number | null;
  rating: { average: number; count: number; excludedCount: number };
  medianResponseMinutes: number | null;
  priceFrom: { amount: number; currency: string } | null;
  priceBasis: PriceBasis;
  /** The same value in words, so the client renders one rather than keeping its own map. */
  priceBasisLabel: string;
  isAcceptingWork: boolean;
  trustChecks: string[];
  isImmigrantFriendly: boolean;
  /** D13: with nothing verified, a regulated profile must say so. */
  isRegulated: boolean;
  verificationStatus: ListingVerificationStatus;
}

export interface ProfessionalServiceView {
  id: string;
  name: string;
  description: string | null;
  price: { amount: number; currency: string } | null;
  priceBasis: PriceBasis;
  /** The same value in words, so the client renders one rather than keeping its own map. */
  priceBasisLabel: string;
  isActive: boolean;
}

export interface ProfessionalProfileView extends Omit<
  ProfessionalSummaryView,
  'type' | 'category'
> {
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

/**
 * A listing's own two pictures, signed. One helper rather than six copies: a listing that shows its
 * logo on the profile and the account photo on the card is worse than one that shows neither, so
 * every shape that renders a listing has to answer this the same way.
 */
export const toListingPictures = (
  listing: { photoKey: string | null; coverKey: string | null },
  sign: (key: string) => string,
): { photoUrl: string | null; coverUrl: string | null } => ({
  photoUrl: listing.photoKey ? sign(listing.photoKey) : null,
  coverUrl: listing.coverKey ? sign(listing.coverKey) : null,
});

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
  // Required: each service row is individually bookable and the booking call sends this id, not the name and price (2.4).
  id: service.id,
  name: service.name,
  description: service.description,
  price: money(service.price, service.currency),
  priceBasis: service.priceBasis,
  priceBasisLabel: toPriceBasisLabel(service.priceBasis),
  isActive: service.isActive,
});
