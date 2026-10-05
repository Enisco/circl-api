import { PrismaClient, Prisma } from '@prisma/client';
import { StorageProvider } from '../../../src/modules/platform/media/storage/storage.interface';
import { avatarPng, bannerPng } from './imagery';
import { daysAgo, daysAhead, hoursAgo, seedId, reportToken } from './ids';
import { connectExtras, PEOPLE, SeedPerson } from './people';

/** Everything the app shows before launch (Appendix B). */
export interface DemoSeedContext {
  prisma: PrismaClient;
  storage: StorageProvider;
}

/** Where the demo lives. Six of the ten, so one city clears the Pulse floor. */
const HOME_CITY = 'MANCHESTER';

/** Mirrors PREFIXES in MediaUploadService (0.11.1). */
const MEDIA_PREFIXES = {
  AVATAR: 'circl/avatars',
  COMMUNITY: 'circl/community',
  PROFESSIONAL: 'circl/professionals',
  COMMERCE: 'circl/commerce',
  MESSAGE: 'circl/messages',
  CONNECT: 'circl/connect',
} as const;

const emailOf = (n: number) => `seed${n}@circl.test`;
const userId = (n: number) => seedId(`user:${n}`);

// ─── Media ───────────────────────────────────────────────────────────────────

/**
 * Enough of an MP4 to be a file with the right type and a plausible length. Nothing in the demo
 * plays it, and generating a real clip would mean an encoder in the seeder — but a video post has
 * to exist, because it is the only thing that exercises the poster rule (3.2.2).
 */
const stubMp4 = (): Buffer =>
  Buffer.concat([
    // ftyp, declaring an ordinary MP4.
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypmp42'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('mp42isom'),
    // A short, deliberately inert payload. The duration is written onto the row instead.
    Buffer.alloc(512),
  ]);


/** Writes the object and the row together (B.2.2). */
const putMedia = async (
  ctx: DemoSeedContext,
  options: {
    label: string;
    uploadedById: string;
    purpose: 'AVATAR' | 'COMMUNITY' | 'PROFESSIONAL' | 'COMMERCE' | 'MESSAGE' | 'CONNECT';
    /** `portrait` is the shape Connect renders full-bleed: 900×1200 (3.2.1). */
    kind: 'avatar' | 'banner' | 'portrait' | 'video';
    ownerType?: string;
    ownerId?: string;
    position?: number;
    createdAt?: Date;
    /** For a seeded clip: the poster's own key, which becomes its `thumbnailUrl`. */
    thumbnailKey?: string;
    durationMs?: number;
  },
): Promise<string> => {
  const id = seedId(`media:${options.label}`);
  const isVideo = options.kind === 'video';
  // The same prefixes the app mints under (0.11.1).
  const key = `${MEDIA_PREFIXES[options.purpose]}/${options.uploadedById}/seed-${id.slice(0, 12)}.${isVideo ? 'mp4' : 'png'}`;
  const body = isVideo
    ? stubMp4()
    : options.kind === 'avatar'
      ? avatarPng(options.label)
      : options.kind === 'portrait'
        ? bannerPng(options.label, 900, 1200)
        : bannerPng(options.label);

  await ctx.storage.put(key, body, isVideo ? 'video/mp4' : 'image/png');

  const size =
    options.kind === 'avatar'
      ? { width: 240, height: 240 }
      : options.kind === 'portrait'
        ? { width: 900, height: 1200 }
        : isVideo
          ? { width: 1080, height: 1920 }
          : { width: 960, height: 540 };

  const data = {
    uploadedById: options.uploadedById,
    type: (isVideo ? 'VIDEO' : 'IMAGE') as 'VIDEO' | 'IMAGE',
    purpose: options.purpose,
    mimeType: isVideo ? 'video/mp4' : 'image/png',
    byteSize: body.length,
    storageKey: key,
    ...size,
    // Written here rather than derived: the stub clip has no readable header, and a VIDEO item
    // with a null duration is a shape the client would never see from a real upload.
    ...(options.durationMs ? { durationMs: options.durationMs } : {}),
    ...(options.thumbnailKey ? { thumbnailKey: options.thumbnailKey } : {}),
    // The scan is what gates attaching a key (0.11.4).
    scanStatus: 'CLEAN' as const,
    scannedAt: new Date(),
    status: (options.ownerType ? 'ATTACHED' : 'PENDING') as 'ATTACHED' | 'PENDING',
    ownerType: options.ownerType ?? null,
    ownerId: options.ownerId ?? null,
    position: options.position ?? 0,
    attachedAt: options.ownerType ? (options.createdAt ?? new Date()) : null,
    expiresAt: daysAhead(3650),
    createdAt: options.createdAt ?? new Date(),
  };

  await ctx.prisma.media.upsert({ where: { id }, update: data, create: { id, ...data } });

  return key;
};

// ─── People ──────────────────────────────────────────────────────────────────

const seedPeople = async (ctx: DemoSeedContext) => {
  const role = await ctx.prisma.role.findUniqueOrThrow({ where: { code: 'user' } });

  for (const person of PEOPLE) {
    const id = userId(person.n);
    const joined = daysAgo(person.joinedDaysAgo);

    // The user first, then the avatar: media carries a foreign key to its uploader, so writing the object before the person exists fails on insert.
    await ctx.prisma.user.upsert({
      where: { id },
      update: {
        firstName: person.firstName,
        lastName: person.lastName,
        username: person.username,
        status: 'ACTIVE',
      },
      create: {
        id,
        firstName: person.firstName,
        lastName: person.lastName,
        username: person.username,
        email: emailOf(person.n),
        status: 'ACTIVE',
        createdAt: joined,
        userRole: { create: { roleId: role.id } },
        // There is no password: sign-in is an email code (B.6).
        userAuth: { create: { emailVerifiedAt: joined } },
      },
    });

    if (person.hasAvatar) {
      const avatarKey = await putMedia(ctx, {
        label: `avatar:${person.n}`,
        uploadedById: id,
        purpose: 'AVATAR',
        kind: 'avatar',
        ownerType: 'USER_AVATAR',
        ownerId: id,
        createdAt: joined,
      });

      await ctx.prisma.user.update({ where: { id }, data: { avatarKey } });
    }

    // EMAIL and nothing else.
    await ctx.prisma.trustCheck.upsert({
      where: { id: seedId(`trust:${person.n}`) },
      update: {},
      create: {
        id: seedId(`trust:${person.n}`),
        userId: id,
        check: 'EMAIL',
        status: 'VERIFIED',
        verifiedAt: joined,
      },
    });

    const profile = {
      cityId: person.cityId,
      countryOfOrigin: person.countryOfOrigin,
      bio: person.bio,
      canHelpWith: person.canHelpWith,
      dateOfBirth: new Date(`${person.dateOfBirth}T00:00:00.000Z`),
      dateOfBirthSetAt: joined,
      heritageTag: person.heritageTag,
      journeyStage: person.journeyStage,
      interests: person.interests as Prisma.InputJsonValue,
      languages: person.languages as Prisma.InputJsonValue,
      openInbox: person.n !== 8,
      onboardingCompleted: true,
      onboardingStep: 6,
      phoneNumberDiallingCode: '+44',
      // 7700 900xxx is the Ofcom range reserved for drama. No number here dials.
      phoneNumber: `7700900${String(100 + person.n)}`,
    };

    await ctx.prisma.userProfile.upsert({
      where: { userId: id },
      update: profile,
      create: { id: seedId(`profile:${person.n}`), userId: id, ...profile },
    });
  }
};

/** The Connect-only members that carry the Manchester Connect dashboard over its floor of 20 (B.3). */
const seedConnectExtras = async (ctx: DemoSeedContext) => {
  const role = await ctx.prisma.role.findUniqueOrThrow({ where: { code: 'user' } });

  for (const extra of connectExtras()) {
    const id = userId(extra.n);
    const joined = daysAgo(30 + (extra.n % 90));

    await ctx.prisma.user.upsert({
      where: { id },
      update: { firstName: extra.firstName, lastName: extra.lastName },
      create: {
        id,
        firstName: extra.firstName,
        lastName: extra.lastName,
        username: `${extra.firstName}${extra.lastName}`.toLowerCase(),
        email: emailOf(extra.n),
        status: 'ACTIVE',
        createdAt: joined,
        userRole: { create: { roleId: role.id } },
        userAuth: { create: { emailVerifiedAt: joined } },
      },
    });

    await ctx.prisma.userProfile.upsert({
      where: { userId: id },
      update: {},
      create: {
        id: seedId(`profile:${extra.n}`),
        userId: id,
        cityId: extra.cityId,
        countryOfOrigin: extra.countryOfOrigin,
        dateOfBirth: new Date(`${extra.birthYear}-05-14T00:00:00.000Z`),
        dateOfBirthSetAt: joined,
        onboardingCompleted: true,
        // INTEREST codes, not community categories: MAKE_FRIENDS is a category, and a member
        // carrying it here cannot save a Connect profile at all — the setup form hands the value
        // back and the write refuses it, with nothing on screen they can change.
        interests: ['FOOD_COOKING', 'TRAVEL'] as Prisma.InputJsonValue,
        languages: ['ENGLISH'] as Prisma.InputJsonValue,
      },
    });

    await ctx.prisma.connectProfile.upsert({
      where: { userId: id },
      update: {},
      create: {
        id: seedId(`connect:${extra.n}`),
        userId: id,
        typeCode: extra.typeCode,
        // Written per member rather than assembled from the type code: this is the line the card
        // leads with, and eighteen variations on one sentence is a grid nobody can review.
        lookingFor: extra.lookingFor,
        dmPolicy: 'REQUEST_FIRST',
        isVisible: true,
        // A spread, so `lastActiveBucket` is not one value for everybody.
        lastActiveAt: hoursAgo(extra.n % 5 === 0 ? 2 : 24 + (extra.n % 17) * 9),
        createdAt: joined,
      },
    });

    await seedConnectMedia(ctx, extra);
  }
};

/**
 * A gallery per member, because a discovery grid draws one tile per profile and every one of these
 * had an empty one: the whole of what the Connect rebuild is for, invisible in the demo.
 *
 * One post each as the floor, a second for some, so the album shape appears outside the handful of
 * full members. Deliberately modest — each photo is a real object written to storage on every seed
 * run, and thirty-four members with five photos apiece is a slow boot for no extra review value.
 */
const seedConnectMedia = async (
  ctx: DemoSeedContext,
  extra: {
    n: number;
    posts: number[];
    prompts?: Array<[string, string]>;
    hasStory?: boolean;
  },
) => {
  const profileId = seedId(`connect:${extra.n}`);
  let photoIndex = 0;

  for (const [postIndex, count] of extra.posts.entries()) {
    const postId = seedId(`connect-post:${extra.n}:${postIndex}`);
    const postedAt = daysAgo(20 - postIndex * 4);
    const postData = {
      profileId,
      kind: 'PHOTO' as never,
      caption: null,
      position: postIndex,
      reportToken: reportToken(`connect-post:${extra.n}:${postIndex}`),
      postedAt,
    };

    await ctx.prisma.connectPost.upsert({
      where: { id: postId },
      update: postData,
      create: { id: postId, ...postData },
    });

    for (let position = 0; position < count; position += 1) {
      await putMedia(ctx, {
        label: `connect:${extra.n}:${photoIndex}`,
        uploadedById: userId(extra.n),
        purpose: 'CONNECT',
        kind: 'portrait',
        ownerType: 'CONNECT_POST',
        ownerId: postId,
        position,
        createdAt: postedAt,
      });

      photoIndex += 1;
    }
  }

  for (const [position, [code, answer]] of (extra.prompts ?? []).entries()) {
    await ctx.prisma.connectPromptAnswer.upsert({
      where: { profileId_code: { profileId, code } },
      update: { answer, position },
      create: { profileId, code, answer, position },
    });
  }

  if (!extra.hasStory) return;

  const storyId = seedId(`connect-story:${extra.n}`);
  const postedAt = hoursAgo(4);
  const storyData = {
    profileId,
    userId: userId(extra.n),
    reportToken: reportToken(`connect-story:${extra.n}`),
    postedAt,
    expiresAt: new Date(postedAt.getTime() + 24 * 60 * 60 * 1000),
    deletedAt: null,
  };

  await ctx.prisma.connectStory.upsert({
    where: { id: storyId },
    update: storyData,
    create: { id: storyId, ...storyData },
  });

  await putMedia(ctx, {
    label: `connect-story:${extra.n}`,
    uploadedById: userId(extra.n),
    purpose: 'CONNECT',
    kind: 'portrait',
    ownerType: 'CONNECT_STORY',
    ownerId: storyId,
    createdAt: postedAt,
  });
};

export const seedDemoPeople = async (ctx: DemoSeedContext) => {
  await seedPeople(ctx);
  await seedConnectExtras(ctx);

  return PEOPLE.length + connectExtras().length;
};

export { emailOf, HOME_CITY, putMedia, userId };
export type { SeedPerson };
