import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { S3Storage } from '../../../src/modules/platform/media/storage/s3.storage';
import { StorageProvider } from '../../../src/modules/platform/media/storage/storage.interface';
import { DemoSeedContext, emailOf, userId } from './seed-demo';
import { seedDemoPeople } from './seed-demo';
import { seedCommunity } from './community';
import { seedProfessionals } from './professionals';
import { seedCommerce } from './commerce';
import { seedSocial } from './social';
import { seedNotifications } from './notifications';
import { seedAccountSettings } from './account';
import { seedAvailability } from './availability';
import { seedModeration } from './moderation';
import { seedCityFeeds } from './cities';
import { seedSearchDemand } from './search-demand';
import { PULSE_MEMBER_IDS, seedPulse } from './pulse';
import { connectExtras, PEOPLE } from './people';
import { hoursAgo, seedId } from './ids';
import { MetricsService } from '../../../src/modules/platform/intelligence/services/metrics.service';
import { SearchDemandService } from '../../../src/modules/platform/intelligence/services/search-demand.service';
import { TaxonomyService } from '../../../src/modules/platform/shared/services/taxonomy.service';

/** The demo dataset (Appendix B). */

/** The same driver the application uses. */
const storageFor = (): StorageProvider => {
  const config = new ConfigService(process.env);

  if (!config.get<string>('MEDIA_BUCKET')) {
    throw new Error(
      'MEDIA_BUCKET is not set. The demo dataset writes real objects for every key it seeds, ' +
        'so it needs the bucket that the application reads from.',
    );
  }

  return new S3Storage(config);
};

/** The one thing this must never do. */
const assertNotProduction = () => {
  const environment = process.env.NODE_ENV ?? process.env.APP_ENV;

  if (environment === 'production') {
    throw new Error(
      'The demo dataset refuses to run in production. It is invented data and must never be ' +
        'mistaken for real. There is deliberately no flag to override this.',
    );
  }
};

/** A support thread on the demo account, with its opening SYSTEM message (6.3.1). */
const seedGuard = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;
  const conversationId = seedId('thread:support:1');
  const owner = userId(1);
  const staff = await prisma.user.findFirst({
    where: { isStaff: true },
    select: { id: true },
  });

  await prisma.conversation.upsert({
    where: { id: conversationId },
    update: {},
    create: {
      id: conversationId,
      kind: 'SUPPORT',
      contextType: 'SUPPORT',
      participantKey: [owner, ...(staff ? [staff.id] : [])].sort().join('|'),
      // Pinned so it is first for everyone: somebody who needed this channel should not have to scroll to find the reply.
      isPinned: true,
      messageCount: 2,
      lastMessageAt: hoursAgo(20),
      createdAt: hoursAgo(22),
    },
  });

  for (const participant of [owner, ...(staff ? [staff.id] : [])]) {
    await prisma.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId, userId: participant } },
      update: {},
      create: {
        conversationId,
        userId: participant,
        unreadCount: 0,
        hasSentMessage: participant === owner,
        joinedAt: hoursAgo(22),
      },
    });
  }

  await prisma.message.upsert({
    where: { id: seedId('message:support:0') },
    update: {},
    create: {
      id: seedId('message:support:0'),
      conversationId,
      senderId: null,
      kind: 'SYSTEM',
      systemType: 'SUPPORT_OPENED',
      clientId: 'seed-support-0',
      body:
        "This is a private thread with Circl's team. Nobody in the community can see it. " +
        'Someone will read it and reply here.',
      status: 'SENT',
      sentAt: hoursAgo(22),
    },
  });

  await prisma.message.upsert({
    where: { id: seedId('message:support:1') },
    update: {},
    create: {
      id: seedId('message:support:1'),
      conversationId,
      senderId: owner,
      kind: 'TEXT',
      body: 'My landlord has stopped responding and I am not sure what my options are.',
      clientId: 'seed-support-1',
      status: 'SENT',
      sentAt: hoursAgo(20),
    },
  });

  const threadId = seedId('guard:1');

  await prisma.guardThread.upsert({
    where: { id: threadId },
    update: {},
    create: {
      id: threadId,
      userId: owner,
      subject: 'Housing',
      categoryCode: 'HOUSING',
      conversationId,
      riskLevel: 'LOW',
      riskScore: 15,
      createdAt: hoursAgo(22),
    },
  });
};

export const seedDemo = async (prisma: PrismaClient) => {
  assertNotProduction();

  const ctx: DemoSeedContext = { prisma, storage: storageFor() };

  console.info('Seeding the demo dataset...');

  // Ordered: people, then content, then the things that hang off content, then notifications, which reference all of it (B.7).
  const people = await seedDemoPeople(ctx);
  console.info(
    `  ✅ ${people} members (${PEOPLE.length} full, ${connectExtras().length} Connect-only)`,
  );

  const community = await seedCommunity(ctx);
  console.info(
    `  ✅ ${community.requests} requests, ${community.offers} offers, ${community.guides} guides, ${community.groups} groups`,
  );

  const professionals = await seedProfessionals(ctx);
  console.info(
    `  ✅ ${professionals.listings} listings, ${professionals.bookings} bookings, ${professionals.reviews} reviews`,
  );

  const commerce = await seedCommerce(ctx);
  console.info(
    `  ✅ ${commerce.stores} stores, ${commerce.items} items, ${commerce.enquiries} enquiries`,
  );

  const social = await seedSocial(ctx);
  console.info(`  ✅ ${social.connect} Connect profiles, ${social.threads} conversations`);

  await seedGuard(ctx);
  console.info('  ✅ 1 support thread');

  // The rows behind the settings screens and the surfaces that were opening empty.
  const account = await seedAccountSettings(ctx);
  console.info(`  ✅ ${account.sessions} device sessions, ${account.privacy} privacy rows`);

  const availability = await seedAvailability(ctx);
  console.info(
    `  ✅ ${availability.days} working days across the professionals, ${availability.occupied} slots taken`,
  );

  // Every city in the picker gets a feed, so a member signing up in Sheffield does not open an
  // empty app. BRISTOL is deliberately left empty for the client's quiet state.
  const feeds = await seedCityFeeds(ctx);
  console.info(
    `  ✅ ${feeds.updates} posts, ${feeds.replies} replies, ${feeds.requests} requests, ` +
      `${feeds.offers} offers, ${feeds.guides} guides across ${feeds.cities} cities ` +
      `(${feeds.emptyCity} left empty on purpose)`,
  );

  // What the four Pulse dashboards need before they will print anything (6.2). Runs before the
  // metrics rebuild below, because that is what reads these rows.
  const pulse = await seedPulse(ctx);
  console.info(
    `  ✅ ${pulse.members} more members, ${pulse.requests} requests (${pulse.replies} answered), ` +
      `${pulse.listings} listings with ${pulse.jobs} finished jobs, ` +
      `${pulse.stores} shops with ${pulse.items} items in ${pulse.categories} categories, ` +
      `${pulse.grouped} group memberships`,
  );

  const moderation = await seedModeration(ctx);
  console.info(
    `  ✅ ${moderation.blocks} blocks, ${moderation.reports} reports, ${moderation.searches} searches behind the demand card`,
  );

  // The published search lists (6.3). Written as ordinary activity events and then rebuilt through
  // the real job, so every floor and every resolution rule applies to the demo exactly as it will
  // apply to the first real week.
  const demand = await seedSearchDemand(ctx);
  console.info(
    `  ✅ ${demand.events} searches on ${demand.terms} terms across ${demand.cities} cities` +
      (demand.withdrawn !== demand.events ? ` (${demand.withdrawn} withdrawn)` : ''),
  );

  const notifications = await seedNotifications(ctx);
  console.info(`  ✅ ${notifications.notifications} notifications`);

  // Pulse reads precomputed snapshots, so without this the dashboards stay empty until the nightly job runs and the demo looks like nothing happened (B.8).
  const metrics = new MetricsService(prisma as never, new TaxonomyService(prisma as never));

  await metrics.rebuild('MONTH');
  await metrics.rebuild('WEEK');

  const searchDemand = new SearchDemandService(
    prisma as never,
    new TaxonomyService(prisma as never),
  );
  const lists = await searchDemand.rebuild();

  console.info(`  ✅ Pulse snapshots rebuilt (${lists} search-demand lists)`);

  console.info('');
  console.info(`  Sign in as ${emailOf(1)} with the code 1111 (any seed1..seed10@circl.test).`);
};

/** Wipes everything this seeder owns (B.7, resettable). */
export const resetDemo = async (prisma: PrismaClient) => {
  assertNotProduction();

  const ids = [
    ...PEOPLE.map(p => p.n),
    ...connectExtras().map(p => p.n),
    ...PULSE_MEMBER_IDS,
  ].map(userId);
  const storage = storageFor();

  const media = await prisma.media.findMany({
    where: { uploadedById: { in: ids } },
    select: { storageKey: true },
  });

  for (const item of media) {
    await storage.delete(item.storageKey).catch(() => undefined);
  }

  // Map tiles are written straight to the bucket rather than through Media, so deleting the rows
  // would leave them behind.
  const maps = await prisma.store.findMany({
    where: { ownerId: { in: ids }, staticMapKey: { not: null } },
    select: { staticMapKey: true },
  });

  for (const store of maps) {
    await storage.delete(store.staticMapKey!).catch(() => undefined);
  }

  const { count } = await prisma.user.deleteMany({ where: { id: { in: ids } } });

  console.info(
    `  🧹 Removed ${count} seeded members, their content and ${media.length + maps.length} objects`,
  );
};
