import { PrismaClient, Prisma } from '@prisma/client';
import { StorageProvider } from '../../../src/modules/platform/media/storage/storage.interface';
import { avatarPng, bannerPng } from './imagery';
import { daysAgo, daysAhead, hoursAgo, seedId } from './ids';
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
} as const;

const emailOf = (n: number) => `seed${n}@circl.test`;
const userId = (n: number) => seedId(`user:${n}`);

// ─── Media ───────────────────────────────────────────────────────────────────

/** Writes the object and the row together (B.2.2). */
const putMedia = async (
  ctx: DemoSeedContext,
  options: {
    label: string;
    uploadedById: string;
    purpose: 'AVATAR' | 'COMMUNITY' | 'PROFESSIONAL' | 'COMMERCE' | 'MESSAGE';
    kind: 'avatar' | 'banner';
    ownerType?: string;
    ownerId?: string;
    position?: number;
    createdAt?: Date;
  },
): Promise<string> => {
  const id = seedId(`media:${options.label}`);
  // The same prefixes the app mints under (0.11.1).
  const key = `${MEDIA_PREFIXES[options.purpose]}/${options.uploadedById}/seed-${id.slice(0, 12)}.png`;
  const body = options.kind === 'avatar' ? avatarPng(options.label) : bannerPng(options.label);

  await ctx.storage.put(key, body, 'image/png');

  const data = {
    uploadedById: options.uploadedById,
    type: 'IMAGE' as const,
    purpose: options.purpose,
    mimeType: 'image/png',
    byteSize: body.length,
    storageKey: key,
    width: options.kind === 'avatar' ? 240 : 960,
    height: options.kind === 'avatar' ? 240 : 540,
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
        username: extra.username,
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
        interests: ['MAKE_FRIENDS'] as Prisma.InputJsonValue,
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
        lookingFor: `New to Manchester and looking for ${extra.typeCode
          .toLowerCase()
          .replace(/_/g, ' ')}.`,
        dmPolicy: 'REQUEST_FIRST',
        isVisible: true,
        createdAt: joined,
      },
    });
  }
};

export const seedDemoPeople = async (ctx: DemoSeedContext) => {
  await seedPeople(ctx);
  await seedConnectExtras(ctx);

  return PEOPLE.length + connectExtras().length;
};

export { emailOf, HOME_CITY, putMedia, userId };
export type { SeedPerson };
