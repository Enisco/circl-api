import { TrustCheckStatus, TrustCheckType } from '@prisma/client';
import { CityView } from './city.serializer';
import { UrlSigner } from './media.serializer';

/** The shared `author` object (spec 0.9). */
export interface AuthorView {
  /** Null when `isAnonymous` — the client must not be able to recover the author. */
  id: string | null;
  displayName: string;
  username: string | null;
  /** Null is normal, not an error. The client draws initials on a grey circle. */
  avatarUrl: string | null;
  city: CityView | null;
  /** ISO 3166-1 alpha-2 for the flag. Null means draw nothing: unset, "Other", or anonymous. */
  countryCode: string | null;
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
  avatarKey: true,
  profileImageUrl: true,
  isAnonymised: true,
  profile: {
    select: {
      city: { select: { id: true, name: true, region: true } },
      countryOfOrigin: true,
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
  lastName: string | null;
  username: string | null;
  avatarKey?: string | null;
  profileImageUrl: string | null;
  isAnonymised?: boolean;
  profile?: {
    city: { id: string; name: string; region: string | null } | null;
    countryOfOrigin?: string | null;
  } | null;
  trustChecks?: Array<{ check: TrustCheckType }>;
  professionalListing?: { id: string } | null;
};

/** Joins the two name columns without inventing a space or the word "null". */
export const displayNameOf = (firstName: string, lastName?: string | null): string =>
  [firstName, lastName].filter(Boolean).join(' ').trim();

const ANONYMOUS_NAME = 'Someone';
const DELETED_NAME = 'Deleted account';

/** The one country term with no flag, so it is nulled rather than sent as an unfindable code. */
const NO_COUNTRY = 'OTHER';

/** The taxonomy already stores alpha-2, so this filters rather than translates. Exported because
 * the profile endpoints carry the same field without going through the author object. */
export const toCountryCode = (code: string | null | undefined): string | null =>
  code && code !== NO_COUNTRY ? code : null;

const countryCodeOf = (author: AuthorSource | null | undefined): string | null =>
  toCountryCode(author?.profile?.countryOfOrigin);

/** Anonymity rules (0.9): when a post is anonymous, `id`, `username` and `avatarUrl` are all null and the display name names only the city. */
export const toAuthorView = (
  author: AuthorSource | null | undefined,
  options: { sign: UrlSigner; isAnonymous?: boolean },
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
      // The city stays: it is the whole of what an anonymous post reveals, and it is what makes "Someone in Manchester" mean anything.
      city,
      // The flag does not. City is coarse enough to stay anonymous in; a nationality that is rare
      // in a given city is not, and two attributes narrow a person far faster than one.
      countryCode: null,
      isAnonymous: true,
      trustChecks: [],
      isProfessional: false,
      professionalId: null,
    };
  }

  // A deleted member renders as a grey avatar with no initials and the name "Deleted account", and their profile route returns 410 (0.15.3).
  if (!author || author.isAnonymised) {
    return {
      id: author?.id ?? null,
      displayName: DELETED_NAME,
      username: null,
      avatarUrl: null,
      city: null,
      countryCode: null,
      isAnonymous: false,
      trustChecks: [],
      isProfessional: false,
      professionalId: null,
    };
  }

  const listingId = author.professionalListing?.id ?? null;

  return {
    id: author.id,
    displayName: displayNameOf(author.firstName, author.lastName),
    username: author.username,
    // An uploaded avatar is Circl's own object and is signed.
    avatarUrl: author.avatarKey ? options.sign(author.avatarKey) : author.profileImageUrl,
    city,
    countryCode: countryCodeOf(author),
    isAnonymous: false,
    trustChecks: (author.trustChecks ?? []).map(check => check.check),
    isProfessional: listingId !== null,
    professionalId: listingId,
  };
};
