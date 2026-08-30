import { DemoSeedContext, HOME_CITY, putMedia, userId } from './seed-demo';
import { daysAgo, hoursAgo, seedId } from './ids';
import { reportToken } from './community';

/** Connect, messaging and notifications (B.4). */

/** Each connection type used at least once, and ages spread so the filters bite. */
const CONNECT_PROFILES: Array<{
  user: number;
  typeCode: string;
  lookingFor: string;
  dmPolicy: 'OPEN' | 'REQUEST_FIRST';
  isVisible?: boolean;
  cityIdOverride?: string;
}> = [
  {
    user: 1,
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Practising English after work, happy to help with Yoruba in return.',
    dmPolicy: 'OPEN',
  },
  {
    user: 2,
    typeCode: 'STUDY_PARTNER',
    lookingFor: 'First year, looking for someone to revise with who is also new to all this.',
    dmPolicy: 'REQUEST_FIRST',
  },
  {
    user: 6,
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Sunday walks and somebody to complain about the weather with.',
    dmPolicy: 'OPEN',
  },
  {
    user: 8,
    typeCode: 'NETWORKING',
    lookingFor: 'Working in logistics, would like to meet people doing the same thing here.',
    dmPolicy: 'REQUEST_FIRST',
    // D18: the override reads as intent, not as a claim about where they are.
    cityIdOverride: 'MANCHESTER',
  },
  {
    user: 9,
    typeCode: 'FLATMATE',
    lookingFor: 'Looking for a quiet flatshare from September, non-smoker.',
    dmPolicy: 'REQUEST_FIRST',
    // A hidden profile, so that state exists in the data (B.4).
    isVisible: false,
  },
  {
    user: 10,
    typeCode: 'DATING',
    lookingFor: 'New to Leeds, would like to meet someone properly rather than online.',
    dmPolicy: 'REQUEST_FIRST',
  },
];

interface SeedThread {
  label: string;
  kind: 'DIRECT' | 'CONNECT' | 'PROFESSIONAL' | 'COMMERCE' | 'SUPPORT';
  participants: number[];
  contextType?: string;
  contextLabel?: string;
  isArchived?: number;
  messages: Array<{ from: number; body: string; hoursAgo: number; unreadFor?: number[]; attachment?: boolean }>;
}

/**
 * Six to twenty messages each, spread over days rather than minutes, with a couple left unread
 * (G14 15.2). A thread of two lines sent an hour apart reads as a fixture; the inbox is the
 * screen where that shows most.
 */
const THREADS: SeedThread[] = [
  {
    label: 'amara-tendai',
    kind: 'DIRECT',
    participants: [1, 6],
    messages: [
      { from: 1, body: 'Hello. You answered my bank question last week and I wanted to say it worked.', hoursAgo: 196 },
      { from: 6, body: 'Which one did you go with in the end?', hoursAgo: 194 },
      { from: 1, body: 'Starling. They took the university letter on its own, no bill needed.', hoursAgo: 193 },
      { from: 6, body: 'Good. Tell the next person who asks, that is how this works here.', hoursAgo: 190 },
      { from: 1, body: 'I will. Can I ask you something else while I have you?', hoursAgo: 96 },
      { from: 6, body: 'Go on.', hoursAgo: 94 },
      { from: 1, body: 'Council tax. I am a full-time student but the letter still came addressed to me.', hoursAgo: 93 },
      { from: 6, body: 'You are exempt, but you have to claim it. It does not happen on its own.', hoursAgo: 90 },
      { from: 6, body: 'Your university does a council tax letter. Take that to the council website and upload it.', hoursAgo: 89 },
      { from: 1, body: 'That is the bit nobody tells you. Thank you.', hoursAgo: 30 },
      { from: 1, body: 'Uploaded it and the bill has already gone to zero.', hoursAgo: 4, unreadFor: [6] },
    ],
  },
  {
    label: 'amara-blessing',
    kind: 'PROFESSIONAL',
    participants: [1, 3],
    contextType: 'PROFESSIONAL',
    contextLabel: 'Immigration Adviser',
    messages: [
      { from: 1, body: 'Hello, I booked the consultation for Thursday. Is there anything I should send over first?', hoursAgo: 150 },
      { from: 3, body: 'Your grant letter and the BRP if you have it. A photo of each is fine.', hoursAgo: 148 },
      { from: 1, body: 'Sent, here is the letter.', hoursAgo: 147, attachment: true },
      { from: 3, body: 'Got it. That is the right one.', hoursAgo: 145 },
      { from: 1, body: 'Do I need my parents\' documents as well? Someone told me I would.', hoursAgo: 100 },
      { from: 3, body: 'Not for this route. That is the dependant application, which is a different form.', hoursAgo: 98 },
      { from: 1, body: 'That is a relief. They are not in the country.', hoursAgo: 97 },
      { from: 3, body: 'Understood. We will only cover your own route on Thursday.', hoursAgo: 96 },
      { from: 1, body: 'One more thing, sorry. Is an hour enough?', hoursAgo: 30 },
      { from: 3, body: 'For this, yes. If it turns into a full application I will tell you before we run over.', hoursAgo: 28 },
      { from: 3, body: 'See you Thursday.', hoursAgo: 4, unreadFor: [1] },
    ],
  },
  {
    label: 'amara-ifeoma',
    kind: 'COMMERCE',
    participants: [1, 7],
    contextType: 'ORDER',
    contextLabel: 'Mama Ife African Foods',
    messages: [
      { from: 1, body: 'Is the yam still available for delivery this week?', hoursAgo: 120 },
      { from: 7, body: 'Yes, two left. I can drop them Thursday evening if that suits.', hoursAgo: 118 },
      { from: 1, body: 'Thursday is good. How much for two?', hoursAgo: 117 },
      { from: 7, body: 'Seventeen ninety-eight for the pair, and delivery is free over fifteen.', hoursAgo: 115 },
      { from: 1, body: 'Perfect. Can you add ground egusi to that?', hoursAgo: 74 },
      { from: 7, body: 'I can. It was ground on Monday so it is fresh.', hoursAgo: 72 },
      { from: 1, body: 'Lovely. Same address as last time.', hoursAgo: 70 },
      { from: 7, body: 'Got it. I will message when I set off.', hoursAgo: 26 },
      { from: 7, body: 'Setting off now, about twenty minutes.', hoursAgo: 2, unreadFor: [1] },
    ],
  },
  {
    label: 'marek-tendai',
    kind: 'CONNECT',
    participants: [8, 6],
    contextType: 'CONNECT_PROFILE',
    contextLabel: 'Friendship · Manchester',
    messages: [
      { from: 8, body: 'Saw you run as well. Do you ever do the Sunday one at Heaton Park?', hoursAgo: 210 },
      { from: 6, body: 'Most weeks. Come along, it is a slow crowd and nobody minds.', hoursAgo: 208 },
      { from: 8, body: 'What time does it start? I am still working out the trams on a Sunday.', hoursAgo: 205 },
      { from: 6, body: 'Nine, but people turn up from half eight. The tram is fine, it is the walk after that is long.', hoursAgo: 200 },
      { from: 8, body: 'I will find it. Is it a proper club or just people who show up?', hoursAgo: 150 },
      { from: 6, body: 'The second one. No fees, no sign-up, somebody usually brings a flask.', hoursAgo: 148 },
      { from: 8, body: 'That is more my speed. See you Sunday then.', hoursAgo: 50 },
      { from: 6, body: 'I will look out for you.', hoursAgo: 48 },
    ],
  },
  {
    label: 'grace-farida',
    kind: 'DIRECT',
    participants: [10, 5],
    // An archived thread, so that state renders (B.4).
    isArchived: 10,
    messages: [
      { from: 10, body: 'Hello, I was given your name for translating a tenancy letter.', hoursAgo: 300 },
      { from: 5, body: 'Of course. Send it over and tell me which parts worry you.', hoursAgo: 298 },
      { from: 10, body: 'It is the section about the deposit. I do not understand what they can keep.', hoursAgo: 296 },
      { from: 5, body: 'That clause is standard, and it is narrower than it reads. I will write it out plainly.', hoursAgo: 290 },
      { from: 5, body: 'Done. The short version: they can only deduct for damage beyond normal wear, and they have to itemise it.', hoursAgo: 250 },
      { from: 10, body: 'Thank you for translating the tenancy letter. That is much clearer.', hoursAgo: 246 },
      { from: 5, body: 'Any time. Come back if the agent replies with anything strange.', hoursAgo: 244 },
    ],
  },
];


export const seedSocial = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;

  // ── Connect ────────────────────────────────────────────────────────────────
  for (const profile of CONNECT_PROFILES) {
    const id = seedId(`connect:${profile.user}`);
    const data = {
      userId: userId(profile.user),
      typeCode: profile.typeCode,
      lookingFor: profile.lookingFor,
      dmPolicy: profile.dmPolicy as never,
      isVisible: profile.isVisible ?? true,
      cityIdOverride: profile.cityIdOverride ?? null,
      // DATING requires the member to have confirmed it, so a seeded dating profile that had not would be a state the app cannot produce (3.1).
      datingConfirmedAt: profile.typeCode === 'DATING' ? daysAgo(30) : null,
      reportToken: reportToken(`connect:${profile.user}`),
      lastActiveAt: hoursAgo(profile.user * 3),
      createdAt: daysAgo(40 + profile.user),
    };

    await prisma.connectProfile.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  // A pending connection request, so the requests tab and its badge have a row.
  const requestId = seedId('connect-request:1');

  await prisma.connectionRequest.upsert({
    where: { id: requestId },
    update: {},
    create: {
      id: requestId,
      fromProfileId: seedId('connect:2'),
      toProfileId: seedId('connect:1'),
      fromUserId: userId(2),
      toUserId: userId(1),
      note: 'Saw you are on the same course. Fancy revising together?',
      createdAt: hoursAgo(18),
    },
  });

  // A blocked pair.
  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId: userId(9), blockedId: userId(4) } },
    update: {},
    create: { blockerId: userId(9), blockedId: userId(4), createdAt: daysAgo(20) },
  });

  // ── Conversations ──────────────────────────────────────────────────────────
  for (const thread of THREADS) {
    const id = seedId(`thread:${thread.label}`);
    const participantKey = thread.participants
      .map(n => userId(n))
      .sort()
      .join('|');
    const last = thread.messages[thread.messages.length - 1];

    await prisma.conversation.upsert({
      where: { id },
      update: { lastMessageAt: hoursAgo(last.hoursAgo), messageCount: thread.messages.length },
      create: {
        id,
        kind: thread.kind as never,
        contextType: (thread.contextType ?? null) as never,
        contextId: thread.contextType ? seedId(`context:${thread.label}`) : null,
        contextSnapshot: thread.contextLabel
          ? { title: thread.contextLabel, route: null }
          : undefined,
        participantKey,
        lastMessageAt: hoursAgo(last.hoursAgo),
        messageCount: thread.messages.length,
        createdAt: hoursAgo(thread.messages[0].hoursAgo),
      },
    });

    for (const n of thread.participants) {
      const unread = thread.messages.filter(message => message.unreadFor?.includes(n)).length;

      await prisma.conversationParticipant.upsert({
        where: { conversationId_userId: { conversationId: id, userId: userId(n) } },
        update: { unreadCount: unread },
        create: {
          conversationId: id,
          userId: userId(n),
          unreadCount: unread,
          hasSentMessage: thread.messages.some(message => message.from === n),
          isArchived: thread.isArchived === n,
          lastReadAt: unread ? hoursAgo(last.hoursAgo + 1) : hoursAgo(last.hoursAgo - 1),
          joinedAt: hoursAgo(thread.messages[0].hoursAgo),
        },
      });
    }

    for (const [index, message] of thread.messages.entries()) {
      const messageId = seedId(`message:${thread.label}:${index}`);
      const sentAt = hoursAgo(message.hoursAgo);

      await prisma.message.upsert({
        where: { id: messageId },
        update: { body: message.body },
        create: {
          id: messageId,
          conversationId: id,
          senderId: userId(message.from),
          kind: message.attachment ? 'IMAGE' : 'TEXT',
          body: message.body,
          clientId: `seed-${thread.label}-${index}`,
          status: 'SENT',
          sentAt,
        },
      });

      if (message.attachment) {
        await putMedia(ctx, {
          label: `message:${thread.label}:${index}`,
          uploadedById: userId(message.from),
          purpose: 'MESSAGE',
          kind: 'banner',
          createdAt: sentAt,
        }).then(async key => {
          const media = await prisma.media.findFirst({ where: { storageKey: key } });

          if (!media) return;

          await prisma.messageAttachment.upsert({
            where: { messageId_mediaId: { messageId, mediaId: media.id } },
            update: {},
            create: { messageId, mediaId: media.id, position: 0 },
          });
        });
      }
    }
  }

  return { connect: CONNECT_PROFILES.length, threads: THREADS.length };
};

export { CONNECT_PROFILES, THREADS };
