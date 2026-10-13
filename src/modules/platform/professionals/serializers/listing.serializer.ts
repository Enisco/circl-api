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
  /**
   * The categories a reviewer has approved this professional for, with the provenance (v2 §2.5).
   *
   * **Approved records only, and never the documents.** A pending or declined verification is
   * private to its owner: a visitor learning that somebody was declined is a disclosure we have no
   * right to make, and one that would be read as a warning about the person.
   *
   * `verifiedAt` and `checkedBy` are not decoration — the chip opens a sheet saying what was
   * checked, by whom and when, and a chip without that provenance is not shippable.
   */
  verifiedCategories: VerifiedCategoryView[];
  /**
   * Whether somebody can reach them **now** (v2 §4.2), computed server-side.
   *
   * The manual switch first, then the hours against the clock **in the professional's own
   * timezone** — and the same function backs any `contactableNow` filter, so the badge and the
   * filter can never disagree. Computing it on the client would read the viewer's clock, which is
   * the wrong one for anybody in a different timezone from the professional.
   */
  isContactableNow: boolean;
}

/** One approved category, as a visitor sees it (v2 §2.5). */
export interface VerifiedCategoryView {
  categoryCode: string;
  label: string;
  verifiedAt: string | null;
  checkedBy: string | null;
  /** Nullable, and not surfaced yet — but a licence with a renewal date is the normal case. */
  expiresAt: string | null;
}

/** Contactable hours, the same shape a store's opening hours use (v2 §4.2). */
export interface ContactHoursView {
  day: string;
  openMinutes: number | null;
  closeMinutes: number | null;
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
  /** Coded skills, filterable and countable (v2 §4.1). */
  skills: TermView[];
  /** The member's own words for work the vocabulary has not caught up with. Never filterable. */
  customSkills: string[];
  contactHours: ContactHoursView[];
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
  skills: { orderBy: { sort: 'asc' } },
  contactHours: true,
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

/**
 * The approved categories, as a visitor sees them (v2 §2.5).
 *
 * Approved only — a pending or declined verification is private to its owner — and never the
 * documents. The provenance travels with it because the chip opens a sheet saying what was
 * checked, by whom and when, and a chip without that is decoration.
 */
export const toVerifiedCategories = (
  records: Array<{
    categoryCode: string;
    decidedAt: Date | null;
    checkedBy: string | null;
    expiresAt: Date | null;
  }>,
  labels: Map<string, string>,
): VerifiedCategoryView[] =>
  records.map(record => ({
    categoryCode: record.categoryCode,
    label: labels.get(record.categoryCode) ?? record.categoryCode,
    verifiedAt: record.decidedAt?.toISOString() ?? null,
    checkedBy: record.checkedBy ?? 'Circl Trust & Safety',
    expiresAt: record.expiresAt?.toISOString() ?? null,
  }));
