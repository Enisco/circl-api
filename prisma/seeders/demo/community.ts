import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { DemoSeedContext, HOME_CITY, putMedia, userId } from './seed-demo';
import { daysAgo, hoursAgo, seedId } from './ids';

/** Section 1 content (B.4). */
const reportToken = (label: string) => `rpt_${seedId(label).replace(/-/g, '').slice(0, 20)}`;

interface SeedRequest {
  label: string;
  author: number;
  categoryCode: string;
  title: string;
  description: string;
  cityId?: string;
  hoursAgo: number;
  visibility?: 'PUBLIC' | 'ANONYMOUS';
  status?: 'OPEN' | 'RESOLVED' | 'CLOSED' | 'EXPIRED';
  thankYouAmount?: number;
  hasPhoto?: boolean;
  replies?: Array<{
    author: number;
    content: string;
    isHelpOffer?: boolean;
    hoursAgo: number;
  }>;
}

/** The unhappy states are the point (B.4): a dataset where every request is answered and every rating is five stars tests nothing and demos worse. */
const REQUESTS: SeedRequest[] = [
  {
    label: 'banks',
    author: 1,
    categoryCode: 'BANK_ACCOUNT',
    title: 'Which banks actually accept a university letter?',
    description:
      'I have my acceptance letter but no utility bill yet, and two branches have turned me away. ' +
      'Has anyone opened an account on a student letter alone recently?',
    hoursAgo: 5,
    status: 'RESOLVED',
    thankYouAmount: 1000,
    replies: [
      {
        author: 6,
        content:
          'Monzo and Starling both took mine on the letter alone, all through the app. The high ' +
          'street ones were the problem, not the challengers.',
        hoursAgo: 4,
      },
      {
        author: 3,
        content: 'Same here. Take a screenshot of the letter, they ask for it at the end.',
        hoursAgo: 3,
      },
      {
        author: 5,
        content: 'Happy to come with you to a branch if you would rather not go alone.',
        isHelpOffer: true,
        hoursAgo: 2,
      },
    ],
  },
  {
    label: 'gp',
    author: 10,
    categoryCode: 'NHS_HEALTHCARE',
    title: 'Registering with a GP without proof of address',
    description:
      'I am in temporary accommodation in Leeds and the surgery asked for a bill I do not have. ' +
      'Is there a way round this or do I need to wait until I move?',
    cityId: 'LEEDS',
    hoursAgo: 30,
    status: 'OPEN',
    replies: [
      {
        author: 6,
        content:
          'You do not need proof of address to register. It is in the NHS guidance and the ' +
          'practice cannot refuse on that basis. Ask for the registration form in writing.',
        hoursAgo: 28,
      },
    ],
  },
  {
    label: 'landlord',
    author: 2,
    categoryCode: 'ACCOMMODATION',
    title: 'Is a landlord allowed to ask for six months up front?',
    description:
      'Found a place I can afford monthly but the agent wants six months in advance because I ' +
      'have no UK credit history. Is that normal or am I being taken advantage of?',
    hoursAgo: 12,
    status: 'OPEN',
    visibility: 'ANONYMOUS',
    replies: [
      {
        author: 6,
        content:
          'It is legal but it is not your only option. A guarantor service costs a lot less than ' +
          'six months rent, and plenty of agents accept them.',
        hoursAgo: 10,
      },
      {
        author: 1,
        content: 'I used one of those services in my first year. Happy to send you the details.',
        isHelpOffer: true,
        hoursAgo: 9,
      },
    ],
  },
  {
    label: 'airport',
    author: 9,
    categoryCode: 'AIRPORT_PICKUP',
    title: 'Anyone driving near Manchester Airport on the 14th?',
    description:
      'My sister lands at 6am and the trams do not run that early. Happy to cover fuel.',
    hoursAgo: 50,
    status: 'OPEN',
  },
  {
    label: 'nursery',
    author: 5,
    categoryCode: 'CHILDCARE',
    title: 'Nursery waiting lists — how far ahead did you have to apply?',
    description:
      'Every nursery near me says twelve months. Is that everywhere or have I just been unlucky ' +
      'with the ones I called?',
    hoursAgo: 200,
    status: 'CLOSED',
  },
  {
    label: 'cv',
    author: 2,
    categoryCode: 'JOBS',
    title: 'Does a UK CV really need to be two pages?',
    description:
      'Mine is four pages because that is how we do it at home. Two recruiters have not replied.',
    hoursAgo: 26,
    status: 'RESOLVED',
    replies: [
      {
        author: 1,
        content:
          'Two pages, no photo, no date of birth, no marital status. It felt wrong to me too but ' +
          'it is what gets read here.',
        hoursAgo: 24,
      },
      {
        author: 3,
        content: 'And put the most recent role first. Send it over, I will look at it properly.',
        isHelpOffer: true,
        hoursAgo: 22,
      },
    ],
  },
  {
    label: 'brp',
    author: 6,
    categoryCode: 'VISA_DOCS',
    title: 'BRP arrived with the wrong expiry date',
    description:
      'The card says a year earlier than my visa grant letter. Has anyone had this corrected and ' +
      'how long did it take?',
    hoursAgo: 400,
    status: 'RESOLVED',
    replies: [
      {
        author: 3,
        content:
          'You report it within ten days of receiving it, and the correction is free if you do. ' +
          'Mine took about three weeks to come back.',
        hoursAgo: 390,
      },
    ],
  },
  {
    label: 'movers',
    author: 8,
    categoryCode: 'MOVING_HELP',
    title: 'Two people and a van, north London, Saturday',
    description: 'One-bed flat, no lift, second floor. Paying properly, not asking for favours.',
    cityId: 'LONDON',
    hoursAgo: 70,
    status: 'OPEN',
    hasPhoto: true,
    replies: [
      { author: 4, content: 'I can do Saturday morning. Sent you a message.', isHelpOffer: true, hoursAgo: 66 },
    ],
  },
  // B.3: aggregate rows are suppressed below a floor of 3, so activity spread one-per-category
  // produces a Pulse dashboard with no bars at all. These cluster BANK_ACCOUNT above the floor,
  // which is also what gives Auto-Guides three distinct askers to cluster on.
  {
    label: 'banks-monzo',
    author: 2,
    categoryCode: 'BANK_ACCOUNT',
    title: 'Has anyone opened a Monzo account on a share code?',
    description:
      'I have my BRP share code but no paper letter yet. The app asked for proof of address and I ' +
      'do not have anything in my name yet.',
    hoursAgo: 20,
    status: 'OPEN',
  },
  {
    label: 'banks-joint',
    author: 10,
    categoryCode: 'BANK_ACCOUNT',
    title: 'Which bank is easiest for a joint account when one of us just arrived?',
    description:
      'My partner has been here four years and I arrived in June. Two branches have said no so far ' +
      'and I do not know whether it is me or the joint part that is the problem.',
    hoursAgo: 52,
    status: 'OPEN',
  },
  {
    label: 'banks-switch',
    author: 6,
    categoryCode: 'BANK_ACCOUNT',
    title: 'Is it worth switching from a digital bank to a high street one?',
    description:
      'Starling has been fine for two years but my landlord says he wants a "proper bank" on the ' +
      'reference. Is that a real requirement or is he making it up?',
    hoursAgo: 96,
    status: 'RESOLVED',
    replies: [
      {
        author: 3,
        content:
          'It is not a requirement. A reference needs statements, and a digital bank produces the ' +
          'same PDF a high street one does.',
        hoursAgo: 90,
      },
    ],
  },
];

interface SeedOffer {
  label: string;
  author: number;
  categoryCode: string;
  title: string;
  description: string;
  cityId?: string;
  priceFrom: number | null;
  priceBasis?: string;
  deliveryMode: string;
  hoursAgo: number;
}

const OFFERS: SeedOffer[] = [
  {
    label: 'airport-runs',
    author: 1,
    categoryCode: 'AIRPORT_PICKUP',
    title: 'Airport runs, Manchester Airport, any hour',
    description:
      'I do the airport run most weeks anyway. Boot fits three big cases. I will not leave you ' +
      'standing at arrivals at 5am.',
    priceFrom: 2500,
    priceBasis: 'PER_JOB',
    deliveryMode: 'IN_PERSON',
    hoursAgo: 100,
  },
  {
    label: 'cv-help',
    author: 6,
    categoryCode: 'JOBS',
    title: 'CV and cover letter, free, no catch',
    description:
      'I have read a few hundred of these by now. Send it over and I will mark it up. It costs ' +
      'nothing and it is not a route to selling you anything.',
    priceFrom: null,
    deliveryMode: 'ONLINE',
    hoursAgo: 140,
  },
  {
    label: 'translation',
    author: 5,
    categoryCode: 'LANGUAGE_HELP',
    title: 'Bengali and Hindi translation for official letters',
    description:
      'Council letters, tenancy agreements, NHS forms. I will tell you what it actually says ' +
      'rather than word for word.',
    priceFrom: 1500,
    priceBasis: 'PER_HOUR',
    deliveryMode: 'BOTH',
    hoursAgo: 220,
  },
  {
    label: 'hair',
    author: 7,
    categoryCode: 'BEAUTY_HAIR',
    title: 'Braids and locs at home, south London',
    description: 'Evenings and weekends. I come to you, bring my own chair.',
    cityId: 'LONDON',
    priceFrom: 4000,
    priceBasis: 'PER_JOB',
    deliveryMode: 'IN_PERSON',
    hoursAgo: 60,
  },
];

interface SeedGuide {
  label: string;
  author: number;
  topicCode: string;
  title: string;
  intro: string;
  steps: string[];
  readMinutes: number;
  views: number;
  likes: number;
  daysAgo: number;
}

const GUIDES: SeedGuide[] = [
  {
    label: 'bank',
    author: 6,
    topicCode: 'FINANCE',
    title: 'Opening a UK bank account in your first month',
    intro:
      'What the branches ask for, what they are allowed to ask for, and what to do when those two ' +
      'are not the same thing.',
    steps: [
      'Try a digital bank first. Monzo, Starling and Revolut open on a passport and a selfie, and ' +
        'none of them need proof of address.',
      'If you want a high street account, book an appointment rather than walking in. The branch ' +
        'staff who can open accounts are not always the ones at the desk.',
      'A university acceptance letter or an employer letter counts as proof of address at most ' +
        'banks. Ask for the bank letter template before you go.',
      'Once one account is open, the second is easy: your first statement is the proof everybody ' +
        'else wanted.',
    ],
    readMinutes: 4,
    views: 1240,
    likes: 86,
    daysAgo: 90,
  },
  {
    label: 'gp',
    author: 6,
    topicCode: 'HEALTH',
    title: 'Registering with a GP, and what to do when you are refused',
    intro:
      'You do not need proof of address, immigration status or an NHS number to register. This is ' +
      'the guidance to quote when a receptionist says otherwise.',
    steps: [
      'Find a practice taking patients on the NHS site and ask for the GMS1 registration form.',
      'If you are asked for documents you do not have, say that NHS England guidance does not ' +
        'require them for registration. Ask for the refusal in writing.',
      'Register anyone in your household at the same practice. It saves repeating this.',
      'If you are still refused, the local Integrated Care Board can register you directly.',
    ],
    readMinutes: 3,
    views: 860,
    likes: 61,
    daysAgo: 45,
  },
  {
    label: 'tenancy',
    author: 3,
    topicCode: 'HOUSING',
    title: 'Reading a tenancy agreement before you sign it',
    intro: 'The six clauses worth finding, and the two that should stop you signing at all.',
    steps: [
      'Check the deposit is protected in one of the three government schemes. It is a legal ' +
        'requirement and it is where most disputes end up.',
      'Find the break clause. If there is not one, you are committed for the full term.',
      'Check who is responsible for repairs. "Tenant responsible for all maintenance" is not ' +
        'normal and is often not enforceable.',
      'A clause letting the landlord enter without notice is not lawful. Do not sign around it.',
    ],
    readMinutes: 6,
    views: 430,
    likes: 29,
    daysAgo: 12,
  },
];

interface SeedGroup {
  label: string;
  name: string;
  description: string;
  cityId: string;
  joinPolicy: 'OPEN' | 'APPROVAL';
  createdBy: number;
  daysAgo: number;
  members: Array<{ user: number; isAdmin?: boolean; state?: 'MEMBER' | 'ADMIN' | 'PENDING'; daysAgo: number }>;
  posts: Array<{
    label: string;
    author: number;
    content: string;
    hoursAgo: number;
    replies: Array<{ author: number; content: string; hoursAgo: number }>;
  }>;
}

/** Groups, their posts and the memberships behind the "My groups" pills (B.4). */
const GROUPS: SeedGroup[] = [
  {
    label: 'manchester-nigerians',
    name: 'Manchester Nigerians',
    description:
      'Anything Manchester and anything home. Where to buy what, which schools take mid-year, ' +
      'who is driving to London at the weekend.',
    cityId: HOME_CITY,
    joinPolicy: 'OPEN',
    createdBy: 6,
    daysAgo: 500,
    // A pending member, so the APPROVAL path is not the only place a non-member state renders.
    members: [
      { user: 6, isAdmin: true, daysAgo: 500 },
      { user: 1, daysAgo: 230 },
      { user: 3, daysAgo: 380 },
      { user: 4, daysAgo: 15 },
      { user: 5, daysAgo: 280 },
    ],
    posts: [
      {
        label: 'market',
        author: 6,
        content:
          'The African market on Cheetham Hill is open Saturdays until four now, not two. Worth ' +
          'the trip if you have been going to the small one in town.',
        hoursAgo: 100,
        replies: [
          { author: 1, content: 'I go most Saturdays, happy to show you where it is.', hoursAgo: 98 },
          { author: 5, content: 'Parking is easier round the back.', hoursAgo: 90 },
        ],
      },
      {
        label: 'schools',
        author: 3,
        content: 'Has anyone applied mid-year for a Year 4 place? Trying to work out how long it takes.',
        hoursAgo: 26,
        replies: [],
      },
    ],
  },
  {
    label: 'manchester-newcomers',
    name: 'New in Manchester',
    description: 'Arrived in the last year or so. Ask the obvious questions here, nobody minds.',
    cityId: HOME_CITY,
    // The approval path, so a pending membership renders somewhere (1.6).
    joinPolicy: 'APPROVAL',
    createdBy: 1,
    daysAgo: 210,
    members: [
      { user: 1, isAdmin: true, daysAgo: 210 },
      { user: 2, daysAgo: 3 },
      { user: 4, daysAgo: 12 },
      { user: 9, state: 'PENDING', daysAgo: 1 },
    ],
    posts: [
      {
        label: 'buses',
        author: 2,
        content: 'Is there one app that actually works for the buses here, or is it different per company?',
        hoursAgo: 20,
        replies: [{ author: 1, content: 'Bee Network for the buses and trams. The rest you can ignore.', hoursAgo: 18 }],
      },
    ],
  },
  {
    label: 'london-west-african',
    name: 'West African London',
    description: 'South London mostly, but everyone is welcome. Food, church, and where to get your hair done.',
    cityId: 'LONDON',
    joinPolicy: 'OPEN',
    createdBy: 7,
    daysAgo: 160,
    members: [
      { user: 7, isAdmin: true, daysAgo: 160 },
      { user: 8, daysAgo: 90 },
    ],
    posts: [
      {
        label: 'plantain',
        author: 7,
        content: 'Fresh plantain in on Thursdays now. Ask for it before it goes on the shelf.',
        hoursAgo: 48,
        replies: [],
      },
    ],
  },
];

export const seedCommunity = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;

  for (const request of REQUESTS) {
    const id = seedId(`request:${request.label}`);
    const createdAt = hoursAgo(request.hoursAgo);
    const replies = request.replies ?? [];

    const data = {
      authorId: userId(request.author),
      categoryCode: request.categoryCode,
      title: request.title,
      description: request.description,
      cityId: request.cityId ?? HOME_CITY,
      visibility: request.visibility ?? ('PUBLIC' as const),
      status: request.status ?? ('OPEN' as const),
      thankYouAmount: request.thankYouAmount ?? null,
      // Denormalised, and written from the same list the reader counts.
      replyCount: replies.length,
      helperCount: replies.filter(reply => reply.isHelpOffer).length,
      viewCount: 8 + replies.length * 7,
      resolvedAt: request.status === 'RESOLVED' ? hoursAgo(request.hoursAgo - 1) : null,
      expiresAt: new Date(createdAt.getTime() + 30 * 86_400_000),
      reportToken: reportToken(`request:${request.label}`),
      createdAt,
    };

    await prisma.communityRequest.upsert({ where: { id }, update: data, create: { id, ...data } });

    if (request.hasPhoto) {
      await putMedia(ctx, {
        label: `request:${request.label}`,
        uploadedById: userId(request.author),
        purpose: 'COMMUNITY',
        kind: 'banner',
        ownerType: 'COMMUNITY_REQUEST',
        ownerId: id,
        createdAt,
      });
    }

    for (const [index, reply] of replies.entries()) {
      const replyId = seedId(`response:${request.label}:${index}`);
      const replyData = {
        requestId: id,
        authorId: userId(reply.author),
        content: reply.content,
        isHelpOffer: reply.isHelpOffer ?? false,
        createdAt: hoursAgo(reply.hoursAgo),
      };

      await prisma.requestResponse.upsert({
        where: { id: replyId },
        update: replyData,
        create: { id: replyId, ...replyData },
      });
    }
  }

  for (const offer of OFFERS) {
    const id = seedId(`offer:${offer.label}`);
    const data = {
      authorId: userId(offer.author),
      categoryCode: offer.categoryCode,
      title: offer.title,
      description: offer.description,
      cityId: offer.cityId ?? HOME_CITY,
      deliveryMode: offer.deliveryMode as never,
      priceFrom: offer.priceFrom,
      // A free offer has no basis to state, so it keeps the NEGOTIABLE default rather than writing a price basis for a price that does not exist (1.4).
      priceBasis: (offer.priceBasis ?? 'NEGOTIABLE') as never,
      viewCount: 20 + offer.hoursAgo,
      reportToken: reportToken(`offer:${offer.label}`),
      createdAt: hoursAgo(offer.hoursAgo),
    };

    await prisma.communityOffer.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  for (const guide of GUIDES) {
    const id = seedId(`guide:${guide.label}`);
    const blocks = guide.steps.map((text, index) => ({
      type: 'STEP',
      text,
      position: index,
    }));

    const data = {
      authorId: userId(guide.author),
      topicCode: guide.topicCode,
      title: guide.title,
      intro: guide.intro,
      blocks: blocks as unknown as Prisma.InputJsonValue,
      cityId: HOME_CITY,
      readTimeMinutes: guide.readMinutes,
      viewCount: guide.views,
      likeCount: guide.likes,
      isAutoGenerated: false,
      publishedAt: daysAgo(guide.daysAgo),
      createdAt: daysAgo(guide.daysAgo),
    };

    await prisma.guide.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  // A part-read guide, so the guides tab's CONTINUE_READING strip has something in it rather than rendering as an empty row (B.5, member 6).
  const partRead = seedId('guide:tenancy');

  await prisma.guideProgress.upsert({
    where: { guideId_userId: { guideId: partRead, userId: userId(1) } },
    update: { progress: 0.4 },
    create: { guideId: partRead, userId: userId(1), progress: 0.4, updatedAt: hoursAgo(20) },
  });

  for (const group of GROUPS) {
    const id = seedId(`group:${group.label}`);
    const posts = group.posts;
    const active = group.members.filter(member => (member.state ?? 'MEMBER') !== 'PENDING');
    const lastPostAt = posts.length
      ? hoursAgo(Math.min(...posts.map(post => post.hoursAgo)))
      : null;

    const data = {
      name: group.name,
      description: group.description,
      cityId: group.cityId,
      joinPolicy: group.joinPolicy as never,
      createdById: userId(group.createdBy),
      // Held on the row rather than counted per load, so the pill and the list agree.
      memberCount: active.length,
      postCount: posts.length,
      lastPostAt,
      reportToken: reportToken(`group:${group.label}`),
      createdAt: daysAgo(group.daysAgo),
    };

    await prisma.group.upsert({ where: { id }, update: data, create: { id, ...data } });

    for (const member of group.members) {
      const state = member.state ?? (member.isAdmin ? 'ADMIN' : 'MEMBER');
      const joinedAt = state === 'PENDING' ? null : daysAgo(member.daysAgo);

      await prisma.groupMembership.upsert({
        where: { groupId_userId: { groupId: id, userId: userId(member.user) } },
        update: { state: state as never, isAdmin: member.isAdmin ?? false },
        create: {
          groupId: id,
          userId: userId(member.user),
          state: state as never,
          isAdmin: member.isAdmin ?? false,
          requestedAt: daysAgo(member.daysAgo),
          joinedAt,
          decidedAt: joinedAt,
          // Behind the newest post on one member, so the unread dot on the pill has somewhere to show.
          lastReadAt: member.user === 1 && group.label === 'manchester-nigerians' ? daysAgo(2) : joinedAt,
        },
      });
    }

    for (const post of posts) {
      const postId = seedId(`group-post:${group.label}:${post.label}`);
      const postData = {
        groupId: id,
        authorId: userId(post.author),
        content: post.content,
        replyCount: post.replies.length,
        reportToken: reportToken(`group-post:${group.label}:${post.label}`),
        createdAt: hoursAgo(post.hoursAgo),
      };

      await prisma.groupPost.upsert({
        where: { id: postId },
        update: postData,
        create: { id: postId, ...postData },
      });

      for (const [index, reply] of post.replies.entries()) {
        const replyId = seedId(`group-reply:${group.label}:${post.label}:${index}`);
        const replyData = {
          postId,
          authorId: userId(reply.author),
          content: reply.content,
          createdAt: hoursAgo(reply.hoursAgo),
        };

        await prisma.groupPostReply.upsert({
          where: { id: replyId },
          update: replyData,
          create: { id: replyId, ...replyData },
        });
      }
    }
  }

  return {
    requests: REQUESTS.length,
    offers: OFFERS.length,
    guides: GUIDES.length,
    groups: GROUPS.length,
  };
};

export { REQUESTS, OFFERS, GUIDES, GROUPS, reportToken };
