import { Injectable } from '@nestjs/common';
import {
  ConnectAccent,
  ConnectPostKind,
  ConnectProfile,
  ContentScanTrigger,
  MediaType,
  DmPolicy,
  Prisma,
  ReportTargetType,
  TaxonomyKind,
  TrustCheckType,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  ageFromDateOfBirth,
  ApiErrorCode,
  ApiException,
  daysAgo,
  toDateOnly,
  toJsonOrUndefined,
} from '@/common';
import {
  authorSelect,
  AuthorView,
  CityService,
  displayNameOf,
  MediaService,
  ContentSafetyService,
  SystemConfigService,
  TaxonomyService,
  TermView,
  toAuthorView,
  toCityView,
  toCountryView,
  toTermView,
} from '../../shared';
import {
  CONNECT_MINIMUM_AGE,
  TAXONOMY_LIMITS,
  configuredLimits,
} from '../../taxonomy/services/taxonomy-catalogue.service';
import { UpsertConnectProfileDto } from '../dtos/connect.dto';
import {
  ConnectMediaItemView,
  ConnectMediaService,
  ConnectPostView,
  ConnectPromptView,
} from './connect-media.service';

export interface ConnectProfileView {
  id: string;
  user: AuthorView;
  age: number | null;
  type: TermView | null;
  lookingFor: string;
  languages: TermView[];
  interests: TermView[];
  /**
   * What they are into. A different vocabulary from `interests`, which also shapes the feed —
   * both are served, and neither replaces the other.
   */
  hobbies: TermView[];
  /** Free text under the name, or null. Never a profession code. */
  occupation: string | null;
  heritageTag: TermView | null;
  journeyStage: TermView | null;
  /** On the USER record, not on the Connect profile (D15). */
  countryOfOrigin: TermView | null;
  city: ReturnType<typeof toCityView>;
  dmPolicy: DmPolicy;
  isVerified: boolean;
  isVisible: boolean;
  /**
   * The colour the member picked. Null falls back to the connection type's colour, which is what
   * every profile used before anybody could choose (3.6).
   */
  accentColour: ConnectAccent | null;
  /**
   * Bucketed, never exact: a precise timestamp on a surface where five of six types are not
   * dating is still a safety problem rather than a feature (3.7).
   */
  lastActiveBucket: 'TODAY' | 'THIS_WEEK' | 'THIS_MONTH' | 'EARLIER';
  /** So a card can draw the ring without loading the gallery. */
  hasStory: boolean;
  /**
   * What they are learning, for Language Exchange. Empty for everybody else (v2 §7).
   *
   * A separate list from `languages`, which is what they already speak: the two together are what
   * makes an exchange a match.
   */
  learningLanguages: TermView[];
  /**
   * The card, in swipe order, and `cardPhotos[0]` is the cover (v2 §1).
   *
   * Always populated: where the member has not picked any, this is the first `maxCardPhotos`
   * photos in post order, which is the rule the client was deriving for itself. So the card can be
   * drawn from this field alone, and a profile that predates the picker looks exactly as it did.
   *
   * Photos only. A video can be in the gallery and cannot be the face in Browse — a card that
   * autoplays in a grid of twenty is a different feature from a photograph.
   */
  cardPhotos: ConnectMediaItemView[];
  /** Up to nine, in the order the owner chose. Post 0's first item is what discovery shows. */
  posts: ConnectPostView[];
  /** Up to three, with the question travelling beside the answer. */
  prompts: ConnectPromptView[];
}

/**
 * The card, from the posts and the member's chosen ids (v2 §1).
 *
 * Pure, and exported, because it is the one piece of this with a rule in it rather than a column:
 * three ids in an order, resolved against what is actually on the profile right now.
 *
 *  - **Ids that no longer resolve are skipped**, not reported. A photo deleted after it was picked
 *    leaves the card shorter, which is recoverable and silent; the alternative is a profile read
 *    that fails because of a picture somebody removed last week.
 *  - **A held or limited photo is already absent** from `posts` (§6.5), so it cannot be the face in
 *    Browse — the same rule, reached through the same data, rather than a second check here.
 *  - **Empty falls back to post order**, capped at the same limit. That is what every client
 *    derived before the field existed, so a profile nobody has re-edited reads identically.
 */
export const cardPhotosFrom = (
  posts: ConnectPostView[],
  cardPhotoIds: string[] | null | undefined,
  limit: number,
): ConnectMediaItemView[] => {
  const photos = posts.flatMap(post => post.items).filter(item => item.kind === 'PHOTO');

  if (!cardPhotoIds?.length) return photos.slice(0, limit);

  const byId = new Map(photos.map(item => [item.id, item]));

  // De-duplicated here as well as refused on the write. The write is the rule; this is what makes
  // the function total over any column content — a duplicate reaching the column some other way
  // (a direct edit, a write path somebody adds later) would otherwise show the same face twice in
  // a three-card swipe, which is the one mistake the member cannot see while they are picking.
  return [...new Set(cardPhotoIds)]
    .map(id => byId.get(id))
    .filter((item): item is ConnectMediaItemView => !!item)
    .slice(0, limit);
};

/** Which bucket a timestamp falls in. Today means since midnight, not within 24 hours. */
const lastActiveBucketOf = (at: Date): ConnectProfileView['lastActiveBucket'] => {
  const startOfToday = new Date();

  startOfToday.setHours(0, 0, 0, 0);

  if (at >= startOfToday) return 'TODAY';
  if (at >= daysAgo(7)) return 'THIS_WEEK';
  if (at >= daysAgo(31)) return 'THIS_MONTH';

  return 'EARLIER';
};

const profileInclude = {
  user: {
    select: {
      ...authorSelect,
      profile: {
        select: {
          city: { select: { id: true, name: true, region: true } },
          dateOfBirth: true,
          interests: true,
          languages: true,
          heritageTag: true,
          journeyStage: true,
          countryOfOrigin: true,
        },
      },
    },
  },
  city: { select: { id: true, name: true, region: true } },
} satisfies Prisma.ConnectProfileInclude;

type ConnectProfileRow = Prisma.ConnectProfileGetPayload<{ include: typeof profileInclude }>;

@Injectable()
export class ConnectProfileService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly cities: CityService,
    private readonly media: MediaService,
    private readonly connectMedia: ConnectMediaService,
    private readonly safety: ContentSafetyService,
    private readonly config: SystemConfigService,
  ) {}

  // ─── 3.2.2 Setup prefill ───────────────────────────────────────────────────

  /** Everything the setup form should already know (3.1). */
  async setupPrefill(userId: string) {
    const [user, profile] = await Promise.all([
      this.database.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          firstName: true,
          lastName: true,
          avatarKey: true,
          profileImageUrl: true,
          profile: {
            select: {
              cityId: true,
              city: { select: { id: true, name: true, region: true } },
              dateOfBirth: true,
              interests: true,
              languages: true,
              heritageTag: true,
              journeyStage: true,
            },
          },
          trustChecks: { where: { status: 'VERIFIED', check: TrustCheckType.IDENTITY } },
        },
      }),
      // visibility: the caller's own profile, for the set-up screen.
      this.database.connectProfile.findUnique({ where: { userId }, include: profileInclude }),
    ]);

    const dateOfBirth = user.profile?.dateOfBirth ?? null;

    // The fields the form must collect.
    const asks = ['TYPE', 'LOOKING_FOR', 'DM_POLICY', 'VISIBILITY'];

    if (!dateOfBirth) asks.push('DATE_OF_BIRTH');

    // Only where there is no profile yet, because all three are create-time rules. A member who
    // joined Connect before them is never asked to satisfy them, and the server saying so here is
    // what keeps the setup screen from guessing which rules it is about to be held to.
    //
    // `HOBBIES` joined the list with its floor (v2 §2) — the setup screen reads `asks` to know
    // which rules this call will be held to, so a rule that is enforced and not announced is a
    // 422 the screen could have prevented.
    if (!profile) asks.push('PHOTOS', 'PROMPTS', 'HOBBIES');

    return {
      profile: profile ? await this.toView(profile) : null,
      prefill: {
        displayName: displayNameOf(user.firstName, user.lastName),
        avatarUrl: user.avatarKey ? this.media.sign(user.avatarKey) : user.profileImageUrl,
        cityId: user.profile?.cityId ?? null,
        cityName: user.profile?.city?.name ?? null,
        dateOfBirth: toDateOnly(dateOfBirth),
        age: ageFromDateOfBirth(dateOfBirth),
        dateOfBirthLocked: dateOfBirth !== null,
        interests: (user.profile?.interests as string[] | null) ?? [],
        languages: (user.profile?.languages as string[] | null) ?? [],
        heritageTag: user.profile?.heritageTag ?? null,
        journeyStage: user.profile?.journeyStage ?? null,
        isVerified: user.trustChecks.length > 0,
        // The visibility toggle's current state, so the setup screen renders it without a second
        // call. For a member with no profile yet this is what they will get if they never touch
        // the toggle, so the switch starts where the server will actually leave them.
        isVisible: profile?.isVisible ?? true,
      },
      asks,
      // Sent, not hardcoded, so the gate can change without a release.
      minimumAge: CONNECT_MINIMUM_AGE,
    };
  }

  // ─── 3.2.1 My profile ──────────────────────────────────────────────────────

  /** `hasProfile: false` with `profile: null` is a normal response, not a 404. */
  async me(userId: string) {
    // visibility: their own profile. A member whose bio is under review still manages it here —
    // this is the screen that will tell them so.
    const profile = await this.database.connectProfile.findUnique({
      where: { userId },
      include: profileInclude,
    });

    const pendingRequestCount = profile
      ? await this.database.connectionRequest.count({
          where: { toProfileId: profile.id, state: 'PENDING' },
        })
      : 0;

    return {
      hasProfile: profile !== null && profile.deletedAt === null,
      isVisible: profile?.isVisible ?? false,
      profile: profile && !profile.deletedAt ? await this.toView(profile) : null,
      // The banner count and the requests screen read the same number, so the two can never disagree (3.5.2).
      pendingRequestCount,
    };
  }

  // ─── 3.3.1 Upsert ──────────────────────────────────────────────────────────

  async upsert(userId: string, dto: UpsertConnectProfileDto) {
    await this.taxonomy.assertValid(TaxonomyKind.CONNECTION_TYPE, dto.typeCode, 'typeCode');

    // These three write through to the user record, and the setup form resends every field. A term
    // retired since the member chose it stays writable by them, or editing anything on this screen
    // is refused over a value the screen itself handed back.
    const held = await this.database.userProfile.findUnique({
      where: { userId },
      select: { interests: true, languages: true, heritageTag: true },
    });
    const heldList = (value: unknown): ReadonlySet<string> =>
      new Set(Array.isArray(value) ? (value as string[]) : []);

    if (dto.languages?.length) {
      await this.taxonomy.assertAllValid(
        TaxonomyKind.LANGUAGE,
        dto.languages,
        'languages',
        heldList(held?.languages),
      );
    }

    if (dto.interests?.length) {
      await this.taxonomy.assertAllValid(
        TaxonomyKind.INTEREST,
        dto.interests,
        'interests',
        heldList(held?.interests),
      );
    }

    if (dto.heritageTag) {
      await this.taxonomy.assertValid(
        TaxonomyKind.HERITAGE_TAG,
        dto.heritageTag,
        'heritageTag',
        new Set(held?.heritageTag ? [held.heritageTag] : []),
      );
    }

    const override = dto.cityIdOverride
      ? await this.cities.assertValid(dto.cityIdOverride, 'cityIdOverride')
      : null;

    const existingProfile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { dateOfBirth: true },
    });

    let dateOfBirth = existingProfile?.dateOfBirth ?? null;

    if (dto.dateOfBirth) {
      if (dateOfBirth) {
        throw ApiException.forbidden(
          ApiErrorCode.DOB_LOCKED,
          'Your date of birth is already set. Contact support if it needs to change.',
          {
            details: [
              { field: 'dateOfBirth', message: 'Already set. Contact support to change it.' },
            ],
          },
        );
      }

      dateOfBirth = new Date(`${dto.dateOfBirth.slice(0, 10)}T00:00:00.000Z`);
    }

    if (!dateOfBirth) {
      throw ApiException.unprocessable(
        ApiErrorCode.DOB_REQUIRED,
        'We need your date of birth before you can join Connect.',
        { details: [{ field: 'dateOfBirth', message: 'This is required.' }] },
      );
    }

    const age = ageFromDateOfBirth(dateOfBirth);

    // Enforced here, not only in the client: client-side enforcement is a courtesy, not a control (3.1.2).
    if (age === null || age < CONNECT_MINIMUM_AGE) {
      throw ApiException.unprocessable(
        ApiErrorCode.UNDER_MINIMUM_AGE,
        `You need to be at least ${CONNECT_MINIMUM_AGE} to use Connect.`,
        { details: [{ field: 'dateOfBirth', message: `Must be ${CONNECT_MINIMUM_AGE} or over.` }] },
      );
    }

    // Dating carries an extra confirm step.
    if (dto.typeCode === 'DATING' && !dto.datingConfirmed) {
      throw ApiException.unprocessable(
        ApiErrorCode.DATING_CONFIRMATION_REQUIRED,
        'Please confirm you have read the safety guidance for dating connections.',
        { details: [{ field: 'datingConfirmed', message: 'This is required for dating.' }] },
      );
    }

    // ── What a profile must have, after the gates on who may have one at all ──────────────────
    //
    // Deliberately below the age and date-of-birth checks rather than above them. A sixteen-year-old
    // who sends no photos has two problems and only one of them matters: being told to add a photo
    // and then, once they have, that they are too young is a worse screen than being told the truth
    // first. Eligibility, then completeness.

    // Whether this call is creating the profile or editing one. Three of the rules below turn on
    // it, and all three turn the same way: a profile that predates a rule keeps its place, and an
    // edit never asks a member for something the screen that made the profile never asked for.
    //
    // visibility: the caller's own profile. A soft-deleted one still counts as existing — its
    // posts and answers are still there, so asking for three photos again would be asking twice.
    const existing = await this.database.connectProfile.findUnique({
      where: { userId },
      select: { id: true, hobbies: true, learningLanguages: true, cardPhotoIds: true },
    });
    const isCreate = !existing;
    const limits = await configuredLimits(this.config);

    if (dto.hobbies?.length) {
      if (dto.hobbies.length > limits.maxHobbies) {
        throw ApiException.unprocessable(
          ApiErrorCode.TOO_MANY_HOBBIES,
          `Pick up to ${limits.maxHobbies} hobbies.`,
          {
            data: { limit: limits.maxHobbies, sent: dto.hobbies.length },
            details: [{ field: 'hobbies', message: `Up to ${limits.maxHobbies}.` }],
          },
        );
      }

      // Same courtesy as interests: a code retired since they chose it stays writable by them, or
      // editing anything on this screen is refused over a value the screen itself handed back.
      await this.taxonomy.assertAllValid(
        TaxonomyKind.HOBBY,
        dto.hobbies,
        'hobbies',
        heldList(existing?.hobbies),
      );
    }

    // And a floor, on create only (v2 §2). The card is the reason: hobbies are what a stranger
    // taps to start a conversation, so a profile with one hobby offers one way in, and one word is
    // not an opening.
    //
    // `minConnectPhotos` and the prompt rule turn on `isCreate` the same way and for the same
    // reason — a member who joined before the rule can still fix a typo in their occupation
    // without being made to pick two more hobbies first.
    if (isCreate && (dto.hobbies?.length ?? 0) < limits.minHobbies) {
      throw ApiException.unprocessable(
        ApiErrorCode.CONNECT_HOBBIES_REQUIRED,
        `Pick at least ${limits.minHobbies} things you are into.`,
        {
          data: { required: limits.minHobbies, sent: dto.hobbies?.length ?? 0 },
          details: [{ field: 'hobbies', message: `Pick at least ${limits.minHobbies}.` }],
        },
      );
    }

    if (dto.learningLanguages?.length) {
      if (dto.learningLanguages.length > TAXONOMY_LIMITS.maxLanguages) {
        throw ApiException.unprocessable(
          ApiErrorCode.VALIDATION_FAILED,
          `Pick up to ${TAXONOMY_LIMITS.maxLanguages} languages you are learning.`,
          {
            data: {
              limit: TAXONOMY_LIMITS.maxLanguages,
              sent: dto.learningLanguages.length,
            },
            details: [
              {
                field: 'learningLanguages',
                message: `Up to ${TAXONOMY_LIMITS.maxLanguages}.`,
              },
            ],
          },
        );
      }

      await this.taxonomy.assertAllValid(
        TaxonomyKind.LANGUAGE,
        dto.learningLanguages,
        'learningLanguages',
        heldList(existing?.learningLanguages),
      );
    }

    // Three photos before a profile can be created, because one photo reads as low effort and
    // leaves the card's swipe-through gesture with nothing to do.
    //
    // The keys arrive on this call rather than in a `POST /connect/me/posts` afterwards, and that
    // is the point: the profile and its first photos are one transaction, so there is no window in
    // which a profile exists with nothing on it. The app asked whether a post could be created
    // before a profile instead — it cannot, `ConnectPost.profileId` is required — and this is the
    // same guarantee from the other side.
    if (isCreate && (dto.photoKeys?.length ?? 0) < limits.minConnectPhotos) {
      throw ApiException.unprocessable(
        ApiErrorCode.CONNECT_PHOTOS_REQUIRED,
        `Add ${limits.minConnectPhotos} photos to join Connect.`,
        {
          data: { required: limits.minConnectPhotos, sent: dto.photoKeys?.length ?? 0 },
          details: [
            {
              field: 'photoKeys',
              message: `Send at least ${limits.minConnectPhotos} upload keys.`,
            },
          ],
        },
      );
    }

    if (isCreate && !dto.prompts?.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.CONNECT_PROMPT_REQUIRED,
        'Answer at least one question so people have something to open with.',
        {
          data: { required: 1 },
          details: [{ field: 'prompts', message: 'Answer at least one.' }],
        },
      );
    }

    if (dto.prompts) await this.connectMedia.assertPromptAnswers(dto.prompts);

    // The card (v2 §1). Checked here, before anything is written, for the same reason as the
    // photos and the prompt answers: everything that can refuse this call has refused by the time
    // the transaction opens.
    //
    // Only on an edit. On create the member has no posts yet — the first one is being written by
    // this very call — so there is no id they could have sent, and the keys they did send become
    // the card below.
    if (dto.cardPhotoIds?.length) {
      if (dto.cardPhotoIds.length > limits.maxCardPhotos) {
        throw ApiException.unprocessable(
          ApiErrorCode.VALIDATION_FAILED,
          `Pick up to ${limits.maxCardPhotos} card photos.`,
          {
            data: { limit: limits.maxCardPhotos, sent: dto.cardPhotoIds.length },
            details: [{ field: 'cardPhotoIds', message: `Up to ${limits.maxCardPhotos}.` }],
          },
        );
      }

      if (existing) await this.connectMedia.assertCardPhotos(existing.id, dto.cardPhotoIds);
    }

    // Prepared before anything is written, which is what makes the single transaction below
    // possible: everything that can refuse a photo — that the keys are this member's, that they
    // are ready, that there are not six of them — has already happened by the time the profile
    // row is created. Ignored on an edit, where `POST /connect/me/posts` is the way to add one.
    const preparedPost =
      isCreate && dto.photoKeys?.length
        ? await this.connectMedia.preparePost(null, userId, {
            keys: dto.photoKeys,
            kind: ConnectPostKind.PHOTO,
          })
        : null;

    const profile = await this.database.$transaction(async tx => {
      // Writes through to the USER record, not to a Connect-only copy, which is what stops the app holding two disagreeing lists of a member's interests (3.1.3, D15).
      await tx.userProfile.upsert({
        where: { userId },
        update: {
          ...(dto.dateOfBirth ? { dateOfBirth, dateOfBirthSetAt: new Date() } : {}),
          ...(dto.languages !== undefined ? { languages: toJsonOrUndefined(dto.languages) } : {}),
          ...(dto.interests !== undefined ? { interests: toJsonOrUndefined(dto.interests) } : {}),
          ...(dto.heritageTag !== undefined ? { heritageTag: dto.heritageTag } : {}),
        },
        create: {
          userId,
          dateOfBirth,
          dateOfBirthSetAt: new Date(),
          languages: toJsonOrUndefined(dto.languages),
          interests: toJsonOrUndefined(dto.interests),
          heritageTag: dto.heritageTag ?? null,
        },
      });

      const saved = await tx.connectProfile.upsert({
        where: { userId },
        update: {
          typeCode: dto.typeCode,
          lookingFor: dto.lookingFor,
          dmPolicy: dto.dmPolicy ?? undefined,
          ...(dto.isVisible !== undefined ? { isVisible: dto.isVisible } : {}),
          cityIdOverride: override?.id ?? null,
          // Absent leaves it alone; an explicit null clears it back to the type's colour.
          ...(dto.accentColour !== undefined ? { accentColour: dto.accentColour } : {}),
          ...(dto.hobbies !== undefined ? { hobbies: dto.hobbies } : {}),
          ...(dto.learningLanguages !== undefined
            ? { learningLanguages: dto.learningLanguages }
            : {}),
          // Absent leaves the card alone; an empty array restores post order, which is what the
          // field falling back to means — so "clear my choices" and "I never made any" are one
          // state rather than two that read differently.
          ...(dto.cardPhotoIds !== undefined ? { cardPhotoIds: dto.cardPhotoIds } : {}),
          // Absent leaves it alone; an empty string or null clears it.
          ...(dto.occupation !== undefined ? { occupation: dto.occupation || null } : {}),
          ...(dto.typeCode === 'DATING' ? { datingConfirmedAt: new Date() } : {}),
          deletedAt: null,
          lastActiveAt: new Date(),
        },
        create: {
          userId,
          typeCode: dto.typeCode,
          lookingFor: dto.lookingFor,
          dmPolicy: dto.dmPolicy ?? DmPolicy.REQUEST_FIRST,
          // Discoverable unless they say otherwise. Creating the profile IS the deliberate act:
          // nobody picks a connection type and writes ten characters about what they are looking
          // for in order not to be found. A profile that exists but cannot be seen is a member
          // waiting for connections that can never arrive, with nothing on screen to say why.
          isVisible: dto.isVisible ?? true,
          cityIdOverride: override?.id ?? null,
          accentColour: dto.accentColour ?? null,
          hobbies: toJsonOrUndefined(dto.hobbies),
          learningLanguages: toJsonOrUndefined(dto.learningLanguages),
          // The photographs they just sent, in the order they sent them (v2 §1). Somebody who
          // uploads three pictures to join Connect has chosen their card, and asking them to pick
          // it again on the next screen would be asking the same question twice.
          //
          // Photos only and capped, so a video among the keys does not take a card slot.
          cardPhotoIds: preparedPost
            ? preparedPost.items
                .filter(item => item.type === MediaType.IMAGE)
                .map(item => item.id)
                .slice(0, limits.maxCardPhotos)
            : [],
          occupation: dto.occupation || null,
          datingConfirmedAt: dto.typeCode === 'DATING' ? new Date() : null,
        },
        include: profileInclude,
      });

      // Before the scan below, deliberately: it reads the answers back out of this transaction,
      // so writing them first is what gets a new profile's prompts scanned with its own words
      // rather than on a second trip through the queue a moment later.
      if (dto.prompts) await this.connectMedia.writePrompts(tx, saved.id, dto.prompts);

      if (preparedPost) await this.connectMedia.writePost(tx, saved.id, preparedPost);

      // §6.1 scans a Connect profile's own words — what they are looking for, and the prompt
      // answers, which have no state of their own (§4.5 gives the column to the profile, not to
      // each answer). So a held answer holds the profile, which is right: the profile is the post.
      await this.safety.assess(tx, {
        targetType: ReportTargetType.CONNECT_PROFILE,
        targetId: saved.id,
        authorId: userId,
        fields: {
          lookingFor: saved.lookingFor,
          ...Object.fromEntries(
            (
              await tx.connectPromptAnswer.findMany({
                where: { profileId: saved.id },
                select: { code: true, answer: true },
              })
            ).map(row => [`prompt ${row.code}`, row.answer]),
          ),
        },
        trigger: ContentScanTrigger.EDIT,
        summary: saved.lookingFor,
      });

      return saved;
    });

    // Once it has committed, because discovery renders these full-bleed and a card without the
    // ratio jumps as the image decodes.
    if (preparedPost) await this.connectMedia.derivePost(preparedPost);

    return this.toView(profile);
  }

  // ─── 3.3.2 Leave Connect ───────────────────────────────────────────────────

  /** Removes the profile and all pending requests in both directions. */
  async remove(userId: string): Promise<void> {
    // visibility: their own profile, on the way out of Connect.
    const profile = await this.database.connectProfile.findUnique({ where: { userId } });

    if (!profile) return;

    await this.database.$transaction(async tx => {
      await tx.connectionRequest.deleteMany({
        where: {
          state: 'PENDING',
          OR: [{ fromProfileId: profile.id }, { toProfileId: profile.id }],
        },
      });

      await tx.connectProfile.delete({ where: { id: profile.id } });
    });
  }

  // ─── Serialisation ─────────────────────────────────────────────────────────

  /**
   * `extras` is passed by a caller that has already loaded them for a page of profiles. Without
   * it this loads its own, which is right for one profile and wrong for twenty — so the list
   * endpoints batch and the single-profile ones do not.
   */
  async toView(
    profile: ConnectProfileRow,
    extras?: {
      posts: ConnectPostView[];
      prompts: ConnectPromptView[];
      hasStory: boolean;
    },
  ): Promise<ConnectProfileView> {
    const [
      typeLabels,
      languageLabels,
      interestLabels,
      hobbyLabels,
      heritageLabels,
      stageLabels,
      limits,
    ] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.CONNECTION_TYPE),
      this.taxonomy.labels(TaxonomyKind.LANGUAGE),
      this.taxonomy.labels(TaxonomyKind.INTEREST),
      this.taxonomy.labels(TaxonomyKind.HOBBY),
      this.taxonomy.labels(TaxonomyKind.HERITAGE_TAG),
      this.taxonomy.labels(TaxonomyKind.JOURNEY_STAGE),
      // Cached, like the labels above: this is a read of a configuration value the whole platform
      // shares, not a query per profile in a grid of twenty.
      configuredLimits(this.config),
    ]);

    const resolved =
      extras ??
      (await Promise.all([
        this.connectMedia.postsFor([profile.id]),
        this.connectMedia.promptsFor([profile.id]),
        this.connectMedia.hasStoryFor([profile.id]),
      ]).then(([posts, prompts, stories]) => ({
        posts: posts.get(profile.id) ?? [],
        prompts: prompts.get(profile.id) ?? [],
        hasStory: stories.has(profile.id),
      })));

    const userProfile = profile.user.profile;
    const languages = ((userProfile?.languages as string[] | null) ?? []).map(code =>
      toTermView(code, languageLabels),
    );
    const interests = ((userProfile?.interests as string[] | null) ?? []).map(code =>
      toTermView(code, interestLabels),
    );
    // On the Connect profile, not written through to the user record like the three above (D15):
    // the lists are not the same list, which is the whole reason this vocabulary exists.
    const hobbies = ((profile.hobbies as string[] | null) ?? []).map(code =>
      toTermView(code, hobbyLabels),
    );
    const learning = ((profile.learningLanguages as string[] | null) ?? []).map(code =>
      toTermView(code, languageLabels),
    );

    return {
      id: profile.id,
      user: toAuthorView(profile.user, { sign: this.media.sign }),
      // Derived from the single date of birth, never stored as a number (3.1.2).
      age: ageFromDateOfBirth(userProfile?.dateOfBirth ?? null),
      type: toTermView(profile.typeCode, typeLabels),
      lookingFor: profile.lookingFor,
      languages: languages.filter(Boolean) as TermView[],
      interests: interests.filter(Boolean) as TermView[],
      hobbies: hobbies.filter(Boolean) as TermView[],
      learningLanguages: learning.filter(Boolean) as TermView[],
      occupation: profile.occupation,
      heritageTag: toTermView(userProfile?.heritageTag ?? null, heritageLabels),
      journeyStage: toTermView(userProfile?.journeyStage ?? null, stageLabels),
      countryOfOrigin: toCountryView(userProfile?.countryOfOrigin ?? null),
      // The override reads as intent ("looking to connect in London") rather than a claim about where they are (D18).
      city: toCityView(profile.city ?? userProfile?.city ?? null),
      dmPolicy: profile.dmPolicy,
      // D13: nothing holds an identity check this version, so no card shows a badge.
      isVerified: (profile.user.trustChecks ?? []).some(
        check => check.check === TrustCheckType.IDENTITY,
      ),
      isVisible: profile.isVisible,
      accentColour: profile.accentColour,
      lastActiveBucket: lastActiveBucketOf(profile.lastActiveAt),
      hasStory: resolved.hasStory,
      cardPhotos: cardPhotosFrom(resolved.posts, profile.cardPhotoIds, limits.maxCardPhotos),
      posts: resolved.posts,
      prompts: resolved.prompts,
    };
  }

  /** Loads a profile by its own id or by the member's user id (3.2.3). */
  async findByIdOrUserId(idOrUserId: string): Promise<ConnectProfileRow | null> {
    // visibility: the loader behind "another member's profile". The decision is `connectVisibility`,
    // which reads `visibilityState` along with hidden, deleted and blocked — one rule, one place,
    // so a held profile answers with the same 404 as a hidden one.
    return this.database.connectProfile.findFirst({
      where: { OR: [{ id: idOrUserId }, { userId: idOrUserId }], deletedAt: null },
      include: profileInclude,
    });
  }

  async requireOwn(userId: string): Promise<ConnectProfile> {
    // visibility: the reciprocity gate, about the caller's own profile.
    const profile = await this.database.connectProfile.findUnique({ where: { userId } });

    if (!profile || profile.deletedAt) {
      // The reciprocity gate.
      throw ApiException.forbidden(
        ApiErrorCode.CONNECT_PROFILE_REQUIRED,
        'Set up your Connect profile to browse other members.',
      );
    }

    return profile;
  }
}
