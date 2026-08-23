import { TrustCheckStatus, TrustCheckType } from '@prisma/client';
import { CityView } from './city.serializer';

/**
 * The shared `author` object (spec 0.9).
 *
 * Authors appear on requests, offers, updates, guides, replies, group posts,
 * responses, reviews, messages and store profiles. It is one shape everywhere,
 * and no endpoint invents a variant of it.
 */
export interface AuthorView {
  /** Null when `isAnonymous` — the client must not be able to recover the author. */
  id: string | null;
  displayName: string;
  username: string | null;
  /** Null is normal, not an error. The client draws initials on a grey circle. */
  avatarUrl: string | null;
  city: CityView | null;
  isAnonymous: boolean;
  /** Empty array, never null. Holds ["EMAIL"] at most in this version (D13). */
  trustChecks: TrustCheckType[];
  isProfessional: boolean;
  professionalId: string | null;
}

/** The minimum a query must select to build an AuthorView. */
export const authorSelect = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  profileImageUrl: true,
  isAnonymised: true,
  profile: {
    select: {
      city: { select: { id: true, name: true, region: true } },
    },
  },
  trustChecks: {
    where: { status: TrustCheckStatus.VERIFIED },
    select: { check: true },
  },
  professionalListing: { select: { id: true } },
} as const;

export type AuthorSource = {
  id: string;
  firstName: string;
  lastName: string;
  username: string | null;
  profileImageUrl: string | null;
  isAnonymised?: boolean;
  profile?: { city: { id: string; name: string; region: string | null } | null } | null;
  trustChecks?: Array<{ check: TrustCheckType }>;
  professionalListing?: { id: string } | null;
};

const ANONYMOUS_NAME = 'Someone';
const DELETED_NAME = 'Deleted account';

/**
 * Anonymity rules (0.9): when a post is anonymous, `id`, `username` and
 * `avatarUrl` are all null and the display name names only the city. Reporting
 * still works, because anonymous content carries a `reportToken` on the post
 * itself rather than on the author. Circl's own tooling keeps the real link.
 */
export const toAuthorView = (
  author: AuthorSource | null | undefined,
  options: { isAnonymous?: boolean } = {},
): AuthorView => {
  const city = author?.profile?.city
    ? {
        id: author.profile.city.id,
        name: author.profile.city.name,
        region: author.profile.city.region,
      }
    : null;

  if (options.isAnonymous) {
    return {
      id: null,
      displayName: city ? `${ANONYMOUS_NAME} in ${city.name}` : ANONYMOUS_NAME,
      username: null,
      avatarUrl: null,
      // The city stays: it is the whole of what an anonymous post reveals, and it
      // is what makes "Someone in Manchester" mean anything.
      city,
      isAnonymous: true,
      trustChecks: [],
      isProfessional: false,
      professionalId: null,
    };
  }

  // A deleted member renders as a grey avatar with no initials and the name
  // "Deleted account", and their profile route returns 410 (0.15.3). No screen
  // needs special handling, because everything resolves through this object.
  if (!author || author.isAnonymised) {
    return {
      id: author?.id ?? null,
      displayName: DELETED_NAME,
      username: null,
      avatarUrl: null,
      city: null,
      isAnonymous: false,
      trustChecks: [],
      isProfessional: false,
      professionalId: null,
    };
  }

  const listingId = author.professionalListing?.id ?? null;

  return {
    id: author.id,
    displayName: `${author.firstName} ${author.lastName}`.trim(),
    username: author.username,
    avatarUrl: author.profileImageUrl,
    city,
    isAnonymous: false,
    trustChecks: (author.trustChecks ?? []).map(check => check.check),
    isProfessional: listingId !== null,
    professionalId: listingId,
  };
};
