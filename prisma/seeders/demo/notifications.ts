import { NotificationKind } from '@prisma/client';
import { DemoSeedContext, userId } from './seed-demo';
import { hoursAgo, seedId } from './ids';

/** Section 6 (B.4). */
const NOTIFICATIONS: Array<{
  label: string;
  user: number;
  actor?: number;
  kind: NotificationKind;
  categoryCode: string;
  title: string;
  body?: string;
  route?: string | null;
  hoursAgo: number;
  isRead?: boolean;
}> = [
  // ── Member 1, the demo account: the fullest, tidiest history (B.6) ─────────
  {
    label: 'n1',
    user: 1,
    kind: NotificationKind.VERIFICATION,
    categoryCode: 'COMPLIANCE',
    title: 'Confirm your email to finish setting up',
    body: 'It takes a minute and unlocks messaging.',
    route: '/settings/verification',
    // Deliberately old: it must still sort above everything newer (6.1.1).
    hoursAgo: 300,
  },
  {
    label: 'n2',
    user: 1,
    actor: 5,
    kind: NotificationKind.HELP_OFFER,
    categoryCode: 'OFFERS',
    title: 'Farida offered to help',
    body: 'Which banks actually accept a university letter?',
    route: '/community/request/banks',
    hoursAgo: 2,
  },
  {
    label: 'n3',
    user: 1,
    actor: 6,
    kind: NotificationKind.REPLY,
    categoryCode: 'REPLIES',
    title: 'Tendai replied to your request',
    body: 'Monzo and Starling both took mine on the letter alone.',
    route: '/community/request/banks',
    hoursAgo: 4,
  },
  {
    label: 'n4',
    user: 1,
    actor: 2,
    kind: NotificationKind.CONNECTION,
    categoryCode: 'CONNECTIONS',
    title: 'Someone wants to connect',
    route: '/connect/requests',
    hoursAgo: 18,
  },
  {
    label: 'n5',
    user: 1,
    actor: 9,
    kind: NotificationKind.REVIEW,
    categoryCode: 'BOOKINGS',
    title: 'You have a new review',
    body: 'Gave me a lift to the airport at 4am and would not take extra for it.',
    route: '/reviews/me',
    hoursAgo: 72,
  },
  {
    label: 'n6',
    user: 1,
    actor: 6,
    kind: NotificationKind.GROUP,
    categoryCode: 'GROUPS',
    title: 'New reply in your group post',
    body: 'I go most Saturdays, happy to show you where it is.',
    route: '/community/group-post/seed',
    hoursAgo: 100,
    isRead: true,
  },
  {
    label: 'n7',
    user: 1,
    kind: NotificationKind.ANNOUNCEMENT,
    categoryCode: 'ANNOUNCEMENTS',
    title: 'Circl is now in Leeds and Birmingham',
    body: 'Same people, more places. Nothing you need to do.',
    // A null route: an announcement has nowhere to go, and the row marks itself read on tap and does nothing else (6.1.1).
    route: null,
    hoursAgo: 400,
  },
  // ── Enough on the others that no member opens to an empty list ─────────────
  { label: 'n8', user: 2, actor: 6, kind: NotificationKind.REPLY, categoryCode: 'REPLIES', title: 'Tendai replied to your request', body: 'It is legal but it is not your only option.', route: '/community/request/landlord', hoursAgo: 10 },
  { label: 'n9', user: 2, actor: 1, kind: NotificationKind.HELP_OFFER, categoryCode: 'OFFERS', title: 'Amara offered to help', body: 'I used one of those services in my first year.', route: '/community/request/landlord', hoursAgo: 9 },
  { label: 'n10', user: 3, actor: 1, kind: NotificationKind.REVIEW, categoryCode: 'BOOKINGS', title: 'You have a new review', body: 'Good advice, though it took a couple of days to get the first reply.', route: '/reviews/me', hoursAgo: 190 },
  { label: 'n11', user: 5, actor: 10, kind: NotificationKind.REVIEW, categoryCode: 'BOOKINGS', title: 'You have a new review', body: 'The translation was accurate but it came back three days late.', route: '/reviews/me', hoursAgo: 240 },
  { label: 'n12', user: 6, actor: 1, kind: NotificationKind.REPLY, categoryCode: 'REPLIES', title: 'Amara replied to your guide', body: 'This is the clearest explanation of it I have read.', route: '/community/guide/bank', hoursAgo: 30 },
  { label: 'n13', user: 7, actor: 1, kind: NotificationKind.ANNOUNCEMENT, categoryCode: 'ANNOUNCEMENTS', title: 'You have a new enquiry', body: 'Two items, for delivery.', route: '/commerce/orders/e1', hoursAgo: 3 },
  { label: 'n14', user: 10, actor: 3, kind: NotificationKind.REPLY, categoryCode: 'REPLIES', title: 'Blessing replied to your request', body: 'You do not need proof of address to register.', route: '/community/request/gp', hoursAgo: 28 },
];

export const seedNotifications = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;

  for (const notification of NOTIFICATIONS) {
    const id = seedId(`notification:${notification.label}`);
    const data = {
      userId: userId(notification.user),
      actorId: notification.actor ? userId(notification.actor) : null,
      kind: notification.kind,
      categoryCode: notification.categoryCode,
      title: notification.title,
      body: notification.body ?? null,
      route: notification.route ?? null,
      isRead: notification.isRead ?? false,
      readAt: notification.isRead ? hoursAgo(notification.hoursAgo - 1) : null,
      createdAt: hoursAgo(notification.hoursAgo),
    };

    await prisma.notification.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  // One member with a preference actually changed, so the matrix is not eight untouched defaults everywhere (6.1.3).
  await prisma.notificationPreference.upsert({
    where: { userId_categoryCode: { userId: userId(1), categoryCode: 'GROUPS' } },
    update: { push: true, email: false },
    create: { userId: userId(1), categoryCode: 'GROUPS', push: true, email: false },
  });

  return { notifications: NOTIFICATIONS.length };
};

export { NOTIFICATIONS };
