import { DemoSeedContext, userId } from './seed-demo';
import { daysAgo, hoursAgo, seedId } from './ids';
import { PEOPLE } from './people';

/**
 * The rows behind the settings screens (BACKEND-DATA-GAPS G3, G6, G7, G4). Each of these backs a
 * screen that was rendering invented data or a switch that controlled nothing.
 */

/** Two or three devices each, at least one stale by weeks, so the screen shows why it exists. */
const DEVICES: Array<{
  label: string;
  userAgent: string;
  deviceType: string;
  browserName: string;
  operatingSystem: string;
  ipAddress: string;
  daysSinceSeen: number;
}> = [
  {
    label: 'iphone',
    userAgent: 'Circl/1.0 (iPhone; iOS 18.2)',
    deviceType: 'mobile',
    browserName: 'Circl',
    operatingSystem: 'iOS 18.2',
    ipAddress: '81.2.69.142',
    daysSinceSeen: 0,
  },
  {
    label: 'pixel',
    userAgent: 'Circl/1.0 (Pixel 8; Android 15)',
    deviceType: 'mobile',
    browserName: 'Circl',
    operatingSystem: 'Android 15',
    ipAddress: '81.2.69.201',
    daysSinceSeen: 2,
  },
  {
    // The one the screen exists for: a browser nobody has touched in a month.
    label: 'laptop',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0',
    deviceType: 'desktop',
    browserName: 'Chrome',
    operatingSystem: 'Windows',
    ipAddress: '92.40.12.7',
    daysSinceSeen: 31,
  },
];

export const seedAccountSettings = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;
  let sessions = 0;

  for (const person of PEOPLE) {
    const owner = userId(person.n);
    // Three for the demo account, two for everyone else.
    const devices = person.n === 1 ? DEVICES : DEVICES.slice(0, 2).concat(DEVICES.slice(2));
    const mine = person.n === 1 ? devices : devices.slice(person.n % 2, (person.n % 2) + 2);

    for (const device of mine) {
      const fingerprint = `seed-${person.n}-${device.label}`;

      await prisma.userSession.upsert({
        where: { userId_deviceFingerprint: { userId: owner, deviceFingerprint: fingerprint } },
        update: { lastActiveAt: daysAgo(device.daysSinceSeen), isActive: true, revokedAt: null },
        create: {
          id: seedId(`session:${person.n}:${device.label}`),
          userId: owner,
          userAgent: device.userAgent,
          deviceType: device.deviceType,
          browserName: device.browserName,
          operatingSystem: device.operatingSystem,
          ipAddress: device.ipAddress,
          isActive: true,
          deviceFingerprint: fingerprint,
          createdAt: daysAgo(Math.min(person.joinedDaysAgo, device.daysSinceSeen + 60)),
          lastActiveAt: daysAgo(device.daysSinceSeen),
        },
      });

      sessions += 1;
    }

    // One row each, so the Privacy screen reads a stored answer rather than a widget default.
    // Member 9 has personalisation off, which is the only way to see the switch actually work.
    await prisma.privacyPreference.upsert({
      where: { userId: owner },
      update: {},
      create: {
        userId: owner,
        personalisedFeed: person.n !== 9,
        useActivityForRecommendations: person.n !== 9,
        showInConnectDiscovery: true,
      },
    });
  }

  // D13 allows one check to sit IN_REVIEW so the state is demonstrable. It must never resolve to
  // VERIFIED: that would demo a badge no member can earn until 2.7 ships.
  const inReview = userId(3);
  const existing = await prisma.trustCheck.findFirst({
    where: { userId: inReview, check: 'RIGHT_TO_WORK' },
    select: { id: true },
  });

  if (!existing) {
    await prisma.trustCheck.create({
      data: {
        userId: inReview,
        check: 'RIGHT_TO_WORK',
        status: 'IN_REVIEW',
        submittedAt: hoursAgo(60),
      },
    });
  }

  return { sessions, privacy: PEOPLE.length };
};
