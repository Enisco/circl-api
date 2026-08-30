import { ActivitySubject, ActivityVerb, ReportReason, ReportTargetType } from '@prisma/client';
import { DemoSeedContext, userId } from './seed-demo';
import { daysAgo, hoursAgo, seedId } from './ids';

/**
 * Blocks, reports and the search terms behind the demand card (G2, G15). Without these the
 * blocked-accounts screen and the moderation queue both open empty, and the demand card — one of
 * the more persuasive things in Commerce — never appears at all.
 */

/** A blocked pair each way, so the list has something in it and the symmetry is visible. */
const BLOCKS: Array<[number, number, number]> = [
  // Member 9 blocked member 2 after an exchange nobody needs to see.
  [9, 2, 20],
  [8, 4, 45],
];

/** Two already resolved, so the queue is not a wall of open work on first open. */
const REPORTS: Array<{
  label: string;
  reporter: number;
  targetType: ReportTargetType;
  target: string;
  reason: ReportReason;
  note: string;
  state: 'RECEIVED' | 'TRIAGED' | 'ACTIONED' | 'DISMISSED';
  daysAgo: number;
}> = [
  {
    label: 'r1',
    reporter: 6,
    targetType: ReportTargetType.UPDATE,
    target: 'update:landlord',
    reason: ReportReason.SPAM,
    note: 'Same message posted four times today.',
    state: 'ACTIONED',
    daysAgo: 9,
  },
  {
    label: 'r2',
    reporter: 1,
    targetType: ReportTargetType.STORE_ITEM,
    target: 'item:ifeoma:stockfish',
    reason: ReportReason.OTHER,
    note: 'Listed as in stock but the seller says it is not.',
    state: 'DISMISSED',
    daysAgo: 14,
  },
  {
    label: 'r3',
    reporter: 10,
    targetType: ReportTargetType.USER,
    target: 'user:2',
    reason: ReportReason.HARASSMENT,
    note: 'Kept messaging after I asked them to stop.',
    state: 'TRIAGED',
    daysAgo: 2,
  },
];

/**
 * What buyers in a city searched for and did not find. Three searches in a month is the floor the
 * endpoint applies, so each term is seeded above it — a fabricated signal that leads a seller to
 * stock something nobody wants is worse than no card at all.
 */
const SEARCHES: Array<[string, string, number]> = [
  ['whiting fish', 'LONDON', 7],
  ['ogbono', 'LONDON', 5],
  ['scotch bonnet', 'LONDON', 4],
  ['sukuma wiki', 'LEEDS', 6],
  ['maandazi', 'LEEDS', 4],
  ['matoke', 'LEEDS', 5],
];

// Only the cities the seeded stores trade in. Seeding a term in a city with no seeded store would
// put a demand hint on every OTHER store there, including ones a test just created.

export const seedModeration = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;

  for (const [blocker, blocked, days] of BLOCKS) {
    await prisma.block.upsert({
      where: { blockerId_blockedId: { blockerId: userId(blocker), blockedId: userId(blocked) } },
      update: {},
      create: {
        blockerId: userId(blocker),
        blockedId: userId(blocked),
        createdAt: daysAgo(days),
      },
    });
  }

  for (const report of REPORTS) {
    const id = seedId(`report:${report.label}`);
    const data = {
      reporterId: userId(report.reporter),
      targetType: report.targetType,
      targetId: report.target.startsWith('user:')
        ? userId(Number(report.target.split(':')[1]))
        : seedId(report.target),
      reasonCode: report.reason,
      note: report.note,
      state: report.state as never,
      createdAt: daysAgo(report.daysAgo),
    };

    await prisma.report.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  let searches = 0;

  for (const [term, cityId, count] of SEARCHES) {
    for (let index = 0; index < count; index += 1) {
      const id = seedId(`search:${cityId}:${term}:${index}`);

      await prisma.activityEvent.upsert({
        where: { id },
        update: {},
        create: {
          id,
          verb: ActivityVerb.SEARCH,
          subject: ActivitySubject.STORE_ITEM,
          cityId,
          term,
          // Inside the endpoint's thirty-day window, spread so it does not read as one burst.
          occurredAt: hoursAgo(6 + index * 37),
        },
      });

      searches += 1;
    }
  }

  return { blocks: BLOCKS.length, reports: REPORTS.length, searches };
};
