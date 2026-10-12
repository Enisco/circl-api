import { DevicePlatform, Gender, SignupMethod, UserAccountStatus } from '@prisma/client';
import { UrlSigner, toCountryView } from '@/modules/platform/shared';
import { maskEmail, maskPhone } from './pii.serializer';

export interface CodeView {
  code: string;
  label: string;
}

export interface CityRefView {
  id: string;
  name: string;
  region: string | null;
}

/** The member reference every admin payload uses where it names somebody (§5.0). */
export interface MemberRefView {
  id: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  avatarUrl: string | null;
  status: UserAccountStatus;
  isAnonymised: boolean;
}

export const AGE_BAND_UNKNOWN = null;

/** One row of the member list (§5.4). Contact details masked, for every role (S8.1). */
export interface AdminMemberRowView {
  id: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  avatarUrl: string | null;
  emailMasked: string;
  status: UserAccountStatus;
  suspendedUntil: string | null;
  city: CityRefView | null;
  gender: Gender | null;
  ageBand: string | null;
  countryOfOrigin: CodeView | null;
  journeyStage: CodeView | null;
  signupMethod: SignupMethod | null;
  platform: DevicePlatform | null;
  appVersion: string | null;
  onboardingCompleted: boolean;
  activeStrikes: number;
  reportsReceived: number;
  sections: { professional: boolean; connect: boolean; store: boolean };
  createdAt: string;
  lastActiveAt: string | null;
}

/** What a query must select for the row above. Spelled out, in the house style of `authorSelect`. */
export interface AdminMemberSource {
  id: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  avatarKey: string | null;
  profileImageUrl: string | null;
  email: string;
  status: UserAccountStatus;
  suspendedUntil: Date | null;
  signupMethod: SignupMethod | null;
  lastPlatform: DevicePlatform | null;
  lastAppVersion: string | null;
  isAnonymised: boolean;
  createdAt: Date;
  lastActiveAt: Date | null;
  profile: {
    gender: Gender | null;
    dateOfBirth: Date | null;
    countryOfOriginCode: string | null;
    journeyStage: string | null;
    onboardingCompleted: boolean;
    phoneNumberDiallingCode: string | null;
    phoneNumber: string | null;
    headline: string | null;
    city: { id: string; name: string; region: string | null } | null;
  } | null;
  professionalListing: { id: string } | null;
  connectProfile: { id: string } | null;
  store: { id: string } | null;
}

/**
 * The two aggregates a row shows, counted by the list query itself.
 *
 * Not a Prisma `_count`, because "active strikes" is `revoked_at IS NULL AND expires_at > now()`
 * and a relation count cannot be filtered while also being sortable — and the list sorts by it.
 * The one query that pages the list therefore counts them, and the same numbers are both the
 * column and the sort key.
 */
export interface AdminMemberCounts {
  activeStrikes: number;
  reportsReceived: number;
}

/** The age bands, as the `CONNECT_AGE_BAND` taxonomy defines them — never restated here. */
export interface AgeBand {
  code: string;
  minAge: number;
  maxAge: number | null;
}

/** What a serialiser needs that is not on the row: the signer, and the vocabularies. */
export interface AdminMemberContext {
  sign: UrlSigner;
  ageBands: AgeBand[];
  journeyStageLabels: Map<string, string>;
  /** The date ages are judged at. The end of the filter range on a list, so a page is stable. */
  at?: Date;
}

/**
 * Which band somebody's age falls in, or null.
 *
 * Null covers two different things — no date of birth, and a date of birth outside every band —
 * and that is deliberate: a band the taxonomy does not define is not one the portal can draw a
 * column for, and inventing an "other" bucket would hide a gap in the vocabulary.
 */
export const ageBandOf = (
  dateOfBirth: Date | null,
  bands: AgeBand[],
  at: Date = new Date(),
): string | null => {
  if (!dateOfBirth) return AGE_BAND_UNKNOWN;

  let age = at.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const months = at.getUTCMonth() - dateOfBirth.getUTCMonth();

  if (months < 0 || (months === 0 && at.getUTCDate() < dateOfBirth.getUTCDate())) age -= 1;

  return (
    bands.find(band => age >= band.minAge && (band.maxAge === null || age <= band.maxAge))?.code ??
    AGE_BAND_UNKNOWN
  );
};

/** A signed avatar, or the social provider's URL, or nothing — never a guess. */
export const avatarUrlOf = (
  source: { avatarKey: string | null; profileImageUrl: string | null },
  sign: UrlSigner,
): string | null => (source.avatarKey ? sign(source.avatarKey) : source.profileImageUrl);

export const toMemberRef = (
  source: {
    id: string;
    firstName: string;
    lastName: string | null;
    username: string | null;
    avatarKey: string | null;
    profileImageUrl: string | null;
    status: UserAccountStatus;
    isAnonymised: boolean;
  },
  sign: UrlSigner,
): MemberRefView => ({
  id: source.id,
  firstName: source.firstName,
  lastName: source.lastName,
  username: source.username,
  avatarUrl: avatarUrlOf(source, sign),
  status: source.status,
  isAnonymised: source.isAnonymised,
});

const codeView = (code: string | null, labels: Map<string, string>): CodeView | null =>
  code ? { code, label: labels.get(code) ?? code } : null;

/**
 * The member list row, masked (S8.4: masking happens here and only here).
 *
 * A serialiser rather than a `select` that simply omits the contact columns, because the detail
 * page, the reveal endpoint and the export all need the real values from the same query — and
 * three queries that each decide for themselves what to select is how one of them ends up
 * returning an email address nobody asked for.
 */
export const toAdminMemberView = (
  source: AdminMemberSource,
  counts: AdminMemberCounts,
  context: AdminMemberContext,
): AdminMemberRowView => ({
  id: source.id,
  firstName: source.firstName,
  lastName: source.lastName,
  username: source.username,
  avatarUrl: avatarUrlOf(source, context.sign),
  emailMasked: maskEmail(source.email),
  status: source.status,
  suspendedUntil: source.suspendedUntil?.toISOString() ?? null,
  city: source.profile?.city ?? null,
  gender: source.profile?.gender ?? null,
  ageBand: ageBandOf(source.profile?.dateOfBirth ?? null, context.ageBands, context.at),
  countryOfOrigin: toCountryView(source.profile?.countryOfOriginCode),
  journeyStage: codeView(source.profile?.journeyStage ?? null, context.journeyStageLabels),
  signupMethod: source.signupMethod,
  platform: source.lastPlatform,
  appVersion: source.lastAppVersion,
  onboardingCompleted: source.profile?.onboardingCompleted ?? false,
  activeStrikes: counts.activeStrikes,
  reportsReceived: counts.reportsReceived,
  sections: {
    professional: !!source.professionalListing,
    connect: !!source.connectProfile,
    store: !!source.store,
  },
  createdAt: source.createdAt.toISOString(),
  lastActiveAt: source.lastActiveAt?.toISOString() ?? null,
});

/** The masked phone, which only the detail payload carries. */
export const maskedPhoneOf = (source: AdminMemberSource): string | null =>
  maskPhone(source.profile?.phoneNumberDiallingCode, source.profile?.phoneNumber);

/**
 * The phone number as dialled, for the two places allowed to see it: `POST members/:id/reveal`
 * and a MEMBERS export whose columns include it. One definition, so the number in a CSV is the
 * number the reveal panel showed — a dialling code joined one way here and another way there is a
 * phone call to the wrong person.
 */
export const phoneOf = (source: AdminMemberSource): string | null =>
  source.profile?.phoneNumber
    ? `${source.profile.phoneNumberDiallingCode ?? ''}${source.profile.phoneNumber}`
    : null;
