import {
  CategoryVerificationStatus,
  ContentVisibilityState,
  ServiceOwnerState,
  ServicePricingKind,
} from '@prisma/client';
import { MediaView } from '@/modules/platform/shared';
import { VerificationState } from '../services/category-verification.service';

/**
 * What a service looks like to a client (v2 §5.1), and the one place its **status is decided**.
 *
 * The status is derived here on every read rather than stored on the row, which is §5.4's first
 * rule and the reason the whole feature hangs together: a professional with three services in one
 * pending category has one verification to keep in step rather than three flags, and approving the
 * category publishes all three without anything having to walk them.
 */

/** The six states a service can be in, as the client reads them. */
export type ServiceStatus =
  | 'DRAFT'
  | 'PENDING_VERIFICATION'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'SUSPENDED'
  | 'HIDDEN';

export interface BlockedByView {
  categoryCode: string;
  verificationStatus: VerificationState;
  note: string | null;
}

/** One named option, as a client reads it (SERVICE-PRICING §2.2). */
export interface ServicePackageView {
  id: string;
  name: string;
  description: string | null;
  /** Both spellings: the platform's `Money` shape, and the raw pence the write field uses. */
  price: { amount: number; currency: string };
  pricePence: number;
}

export interface ServiceView {
  id: string;
  listingId: string;
  name: string;
  description: string | null;
  category: { code: string; label: string } | null;
  subcategory: { code: string; label: string } | null;
  /**
   * The one number every surface quotes — the flat rate, or the **cheapest package**.
   *
   * Recomputed from the packages server-side on every write, so a card, a search row and a thread
   * subject never advertise a price the page does not offer.
   */
  price: { amount: number; currency: string } | null;
  priceLabel: string | null;
  pricingKind: ServicePricingKind;
  /** In the professional's own order. Empty on a `FLAT` service. */
  packages: ServicePackageView[];
  /** Carried separately so a list payload can drop the array and still say "3 packages". */
  packageCount: number;
  /** Null means not charged for, which is not the same as free. Never folded into `price`. */
  consultationFee: { amount: number; currency: string } | null;
  consultationFeePence: number | null;
  status: ServiceStatus;
  blockedBy: BlockedByView | null;
  isVerifiedCategory: boolean;
  media: MediaView[];
  mediaCounts: { images: number; videos: number };
  updates: Array<{ id: string; title: string | null; body: string; publishedAt: string }>;
  milestones: Array<{ id: string; label: string; year: number | null; issuer: string | null }>;
  professional?: ProfessionalRefView;
  viewer: { isOwner: boolean };
  createdAt: string;
  updatedAt: string;
}

/** The identity tile on a service page and a search row, so one screen is one request (§5.1). */
export interface ProfessionalRefView {
  id: string;
  listingId: string;
  displayName: string;
  avatarUrl: string | null;
  city: { id: string; name: string } | null;
  rating: { average: number; count: number } | null;
}

/**
 * The price in words — one wording, in one place (§5.2), and **it depends on the kind**.
 *
 * Sent as well as the amount so four clients cannot word it four ways, which is the same reason
 * `priceBasisLabel` exists. Whole pounds where the price is whole pounds, because "£250.00" is a
 * price written by a computer.
 *
 * | Kind | Reads | Why |
 * |---|---|---|
 * | `FLAT` | `£65` | It *is* the price. "Starts from £65" invites a buyer to expect it to climb. |
 * | `PACKAGES` | `Starts from £120` | The number is the cheapest of several, so a floor is honest. |
 *
 * Every service said "Starts from" until packages arrived, which was the wrong word for a flat
 * rate and the right one for nothing. The failure this guards against is the opposite: a service
 * with a £120 package still reading "Starts from £65" because the label was written while it was
 * flat (SERVICE-PRICING §3).
 */
export const toPriceLabel = (
  pence: number | null,
  currency = 'GBP',
  kind: ServicePricingKind = ServicePricingKind.FLAT,
): string | null => {
  if (pence === null || pence <= 0) return null;

  const symbol = currency === 'GBP' ? '£' : `${currency} `;
  const pounds = pence / 100;
  const amount = Number.isInteger(pounds)
    ? pounds.toLocaleString('en-GB')
    : pounds.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return kind === ServicePricingKind.PACKAGES
    ? `Starts from ${symbol}${amount}`
    : `${symbol}${amount}`;
};

/**
 * The status, from the owner's intent and the category's verification (§5.4).
 *
 * The order of these checks is the product rule, not an implementation detail:
 *
 *  - **The owner's own decisions win first.** A draft is a draft and a hidden service is hidden,
 *    whatever the verification says, because neither is waiting on us.
 *  - **Then moderation.** A service staff took down is `SUSPENDED`, with no `blockedBy` — the
 *    reason lives in the moderation record, not in the verification.
 *  - **Then the gate.** Approved or ungated work publishes; everything else is invisible, and the
 *    state says which kind of invisible it is so the member knows whether to wait or to act.
 */
export const statusOf = (service: {
  ownerState: ServiceOwnerState;
  visibilityState: ContentVisibilityState;
  gated: boolean;
  verification: VerificationState;
}): ServiceStatus => {
  if (service.ownerState === ServiceOwnerState.DRAFT) return 'DRAFT';
  if (service.ownerState === ServiceOwnerState.HIDDEN) return 'HIDDEN';
  if (service.visibilityState !== ContentVisibilityState.VISIBLE) return 'SUSPENDED';
  if (!service.gated) return 'PUBLISHED';

  switch (service.verification) {
    case CategoryVerificationStatus.APPROVED:
      return 'PUBLISHED';
    case CategoryVerificationStatus.REJECTED:
      return 'REJECTED';
    case CategoryVerificationStatus.REVOKED:
    case CategoryVerificationStatus.EXPIRED:
      return 'SUSPENDED';
    case CategoryVerificationStatus.PENDING:
      return 'PENDING_VERIFICATION';
    default:
      // Never submitted, or a status this build does not recognise. Not approved either way, and
      // reading an unknown state as permission is the dangerous direction to be wrong in (§2.2).
      return 'PENDING_VERIFICATION';
  }
};

/** Whether this status is one anybody but the owner may see. `PUBLISHED` and nothing else (§5.4). */
export const isPublic = (status: ServiceStatus): boolean => status === 'PUBLISHED';
