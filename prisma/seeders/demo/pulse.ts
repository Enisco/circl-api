import { Prisma } from '@prisma/client';
import { DemoSeedContext, putMedia, userId } from './seed-demo';
import { daysAgo, hoursAgo, reportToken, seedId } from './ids';

/**
 * What the four Pulse dashboards need before they will print a number (6.2).
 *
 * Pulse suppresses rather than rounds, and it does so twice: a section says nothing at all until
 * five different people are behind it, and each bucket inside it is dropped below its own floor —
 * three for buckets that count things, twenty for buckets that count people. The demo had the
 * content for none of that outside Manchester's community feed, so Manchester showed two bars and
 * London showed an empty shape with a date on it, which reads like a broken endpoint rather than
 * like a young city.
 *
 * Nothing here relaxes a floor. Every number comes from rows the dashboards already read, so what
 * the demo shows is what the arithmetic produces — and a city that genuinely has too little still
 * says so, which is the behaviour the client has to be able to draw.
 *
 * Deliberately no images on the shops and listings this adds: both fall back by design — a listing
 * with no photo shows the member's avatar, a shop with no cover keeps its gradient — and a hundred
 * more objects written to storage on every seed buys a dashboard nothing.
 */

const CITIES = ['MANCHESTER', 'LONDON'] as const;
type PulseCity = (typeof CITIES)[number];

// ─── The members behind the numbers ──────────────────────────────────────────

/**
 * Connect's buckets count people, so its floor is the full twenty — and it applies per connection
 * type within a city, not to the city's total. Twenty-one people looking for the same thing in one
 * city is the smallest honest shape that publishes anything at all, and neither city had it.
 *
 * They all join for friendship because that is what the largest group of arrivals actually comes
 * for, and because changing the types of the members already seeded would have rewritten a
 * discovery grid that has been reviewed.
 */
interface PulseMember {
  n: number;
  firstName: string;
  lastName: string;
  cityId: PulseCity;
  countryOfOrigin: string;
  heritageTag: string;
  birthYear: number;
  lookingFor: string;
}

const MEMBERS: PulseMember[] = [
  {
    n: 200,
    firstName: 'Amara',
    lastName: 'Nwosu',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'NG',
    heritageTag: 'WEST_AFRICAN',
    birthYear: 1994,
    lookingFor: 'Someone to walk around Heaton Park with on a Sunday.',
  },
  {
    n: 201,
    firstName: 'Deo',
    lastName: 'Kamanzi',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'RW',
    heritageTag: 'EAST_AFRICAN',
    birthYear: 1990,
    lookingFor: 'Five-a-side on weekday evenings, any standard.',
  },
  {
    n: 202,
    firstName: 'Sana',
    lastName: 'Qureshi',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'PK',
    heritageTag: 'SOUTH_ASIAN',
    birthYear: 1997,
    lookingFor: 'Friends who also moved here on their own this year.',
  },
  {
    n: 203,
    firstName: 'Marcus',
    lastName: 'Clarke',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'JM',
    heritageTag: 'CARIBBEAN',
    birthYear: 1988,
    lookingFor: 'Somebody to try the Caribbean places in Moss Side with.',
  },
  {
    n: 204,
    firstName: 'Yohannes',
    lastName: 'Tesfaye',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'ET',
    heritageTag: 'EAST_AFRICAN',
    birthYear: 1992,
    lookingFor: 'Coffee on Saturday mornings, properly made.',
  },
  {
    n: 205,
    firstName: 'Bilal',
    lastName: 'Haddou',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'MA',
    heritageTag: 'NORTH_AFRICAN',
    birthYear: 1986,
    lookingFor: 'People to break the fast with when I am away from family.',
  },
  {
    n: 206,
    firstName: 'Ifeoma',
    lastName: 'Okafor',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'NG',
    heritageTag: 'WEST_AFRICAN',
    birthYear: 1991,
    lookingFor: 'Other mums near Longsight with children the same age.',
  },
  {
    n: 207,
    firstName: 'Tran',
    lastName: 'Bui',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'VN',
    heritageTag: 'SOUTH_EAST_ASIAN',
    birthYear: 1995,
    lookingFor: 'Cooking swaps — I will teach pho for anything at all.',
  },
  {
    n: 208,
    firstName: 'Lerato',
    lastName: 'Mokoena',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'ZA',
    heritageTag: 'SOUTHERN_AFRICAN',
    birthYear: 1993,
    lookingFor: 'A running partner who does not mind rain, which is just as well.',
  },
  {
    n: 209,
    firstName: 'Karim',
    lastName: 'Shaaban',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'EG',
    heritageTag: 'NORTH_AFRICAN',
    birthYear: 1989,
    lookingFor: 'Chess, badly played, in a café.',
  },
  {
    n: 210,
    firstName: 'Nomvula',
    lastName: 'Sithole',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'ZW',
    heritageTag: 'SOUTHERN_AFRICAN',
    birthYear: 1996,
    lookingFor: 'Church on Sunday and someone to sit with afterwards.',
  },
  {
    n: 211,
    firstName: 'Reza',
    lastName: 'Mirzaei',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'IR',
    heritageTag: 'MIDDLE_EASTERN',
    birthYear: 1987,
    lookingFor: 'Walking groups in the Peak District at the weekend.',
  },
  {
    n: 212,
    firstName: 'Abena',
    lastName: 'Darko',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'GH',
    heritageTag: 'WEST_AFRICAN',
    birthYear: 1998,
    lookingFor: 'Study company in the evenings, library or kitchen table.',
  },
  {
    n: 213,
    firstName: 'Jun',
    lastName: 'Park',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'KR',
    heritageTag: 'EAST_ASIAN',
    birthYear: 1994,
    lookingFor: 'Board games, and anyone patient with my English.',
  },
  {
    n: 214,
    firstName: 'Camila',
    lastName: 'Rojas',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'CO',
    heritageTag: 'LATIN_AMERICAN',
    birthYear: 1992,
    lookingFor: 'Dancing on a Friday, no experience needed on either side.',
  },
  {
    n: 215,
    firstName: 'Olek',
    lastName: 'Zielinski',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'PL',
    heritageTag: 'EASTERN_EUROPEAN',
    birthYear: 1985,
    lookingFor: 'Fishing, early starts, long silences.',
  },

  {
    n: 216,
    firstName: 'Chidi',
    lastName: 'Anyanwu',
    cityId: 'LONDON',
    countryOfOrigin: 'NG',
    heritageTag: 'WEST_AFRICAN',
    birthYear: 1993,
    lookingFor: 'Somebody to explore the markets with on a day off.',
  },
  {
    n: 217,
    firstName: 'Halima',
    lastName: 'Osman',
    cityId: 'LONDON',
    countryOfOrigin: 'SO',
    heritageTag: 'EAST_AFRICAN',
    birthYear: 1990,
    lookingFor: 'Friends near Tower Hamlets who keep the same hours I do.',
  },
  {
    n: 218,
    firstName: 'Ravi',
    lastName: 'Chandran',
    cityId: 'LONDON',
    countryOfOrigin: 'LK',
    heritageTag: 'SOUTH_ASIAN',
    birthYear: 1988,
    lookingFor: 'Cricket in the summer and complaining about it in winter.',
  },
  {
    n: 219,
    firstName: 'Naomi',
    lastName: 'Bennett',
    cityId: 'LONDON',
    countryOfOrigin: 'TT',
    heritageTag: 'CARIBBEAN',
    birthYear: 1995,
    lookingFor: 'Gallery afternoons with somebody who also goes alone.',
  },
  {
    n: 220,
    firstName: 'Tesfa',
    lastName: 'Girma',
    cityId: 'LONDON',
    countryOfOrigin: 'ER',
    heritageTag: 'EAST_AFRICAN',
    birthYear: 1991,
    lookingFor: 'A quiet football crowd. I am new and I do not know anyone.',
  },
  {
    n: 221,
    firstName: 'Soraya',
    lastName: 'Belkacem',
    cityId: 'LONDON',
    countryOfOrigin: 'DZ',
    heritageTag: 'NORTH_AFRICAN',
    birthYear: 1994,
    lookingFor: 'Cooking together rather than eating out, which I cannot afford.',
  },
  {
    n: 222,
    firstName: 'Emeka',
    lastName: 'Udeh',
    cityId: 'LONDON',
    countryOfOrigin: 'NG',
    heritageTag: 'WEST_AFRICAN',
    birthYear: 1986,
    lookingFor: 'Anyone who will come to a Saturday car boot sale with me.',
  },
  {
    n: 223,
    firstName: 'Mai',
    lastName: 'Tanaka',
    cityId: 'LONDON',
    countryOfOrigin: 'JP',
    heritageTag: 'EAST_ASIAN',
    birthYear: 1997,
    lookingFor: 'Language swap, and company at lunch.',
  },
  {
    n: 224,
    firstName: 'Thuli',
    lastName: 'Mabaso',
    cityId: 'LONDON',
    countryOfOrigin: 'ZA',
    heritageTag: 'SOUTHERN_AFRICAN',
    birthYear: 1992,
    lookingFor: 'Swimming in the lido, even in October.',
  },
  {
    n: 225,
    firstName: 'Nadir',
    lastName: 'Chaudhry',
    cityId: 'LONDON',
    countryOfOrigin: 'PK',
    heritageTag: 'SOUTH_ASIAN',
    birthYear: 1989,
    lookingFor: 'Somebody to pray beside and talk to afterwards.',
  },
  {
    n: 226,
    firstName: 'Esther',
    lastName: 'Mbeki',
    cityId: 'LONDON',
    countryOfOrigin: 'ZM',
    heritageTag: 'SOUTHERN_AFRICAN',
    birthYear: 1996,
    lookingFor: 'Other nurses on nights who are awake when I am.',
  },
  {
    n: 227,
    firstName: 'Firas',
    lastName: 'Darwish',
    cityId: 'LONDON',
    countryOfOrigin: 'SY',
    heritageTag: 'MIDDLE_EASTERN',
    birthYear: 1987,
    lookingFor: 'Backgammon, and someone to practise English with properly.',
  },
  {
    n: 228,
    firstName: 'Akosua',
    lastName: 'Frimpong',
    cityId: 'LONDON',
    countryOfOrigin: 'GH',
    heritageTag: 'WEST_AFRICAN',
    birthYear: 1999,
    lookingFor: 'Friends my age who did not grow up here either.',
  },
  {
    n: 229,
    firstName: 'Linh',
    lastName: 'Pham',
    cityId: 'LONDON',
    countryOfOrigin: 'VN',
    heritageTag: 'SOUTH_EAST_ASIAN',
    birthYear: 1993,
    lookingFor: 'Cycling at the weekend, flat routes only.',
  },
  {
    n: 230,
    firstName: 'Diego',
    lastName: 'Morales',
    cityId: 'LONDON',
    countryOfOrigin: 'EC',
    heritageTag: 'LATIN_AMERICAN',
    birthYear: 1991,
    lookingFor: 'Five-a-side and somewhere to watch the match.',
  },
  {
    n: 231,
    firstName: 'Ana',
    lastName: 'Ilie',
    cityId: 'LONDON',
    countryOfOrigin: 'RO',
    heritageTag: 'EASTERN_EUROPEAN',
    birthYear: 1990,
    lookingFor: 'Walking a dog that is not mine, and conversation.',
  },
];

const membersOf = (cityId: PulseCity) => MEMBERS.filter(member => member.cityId === cityId);

/** So `resetDemo` deletes these too. A reset that leaves members behind is not a reset. */
export const PULSE_MEMBER_IDS = MEMBERS.map(member => member.n);

const seedMembers = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'user' } });

  for (const member of MEMBERS) {
    const id = userId(member.n);
    const joined = daysAgo(20 + (member.n % 60));

    await prisma.user.upsert({
      where: { id },
      update: { firstName: member.firstName, lastName: member.lastName, status: 'ACTIVE' },
      create: {
        id,
        firstName: member.firstName,
        lastName: member.lastName,
        username: `${member.firstName}${member.lastName}`.toLowerCase(),
        email: `seed${member.n}@circl.test`,
        status: 'ACTIVE',
        createdAt: joined,
        userRole: { create: { roleId: role.id } },
        userAuth: { create: { emailVerifiedAt: joined } },
      },
    });

    const profile = {
      cityId: member.cityId,
      countryOfOrigin: member.countryOfOrigin,
      heritageTag: member.heritageTag,
      dateOfBirth: new Date(`${member.birthYear}-06-11T00:00:00.000Z`),
      dateOfBirthSetAt: joined,
      onboardingCompleted: true,
      onboardingStep: 6,
      // INTEREST codes. A community category here cannot be saved back by the Connect form at all.
      interests: ['FOOD_COOKING', 'TRAVEL'] as Prisma.InputJsonValue,
      languages: ['ENGLISH'] as Prisma.InputJsonValue,
    };

    await prisma.userProfile.upsert({
      where: { userId: id },
      update: profile,
      create: { id: seedId(`profile:${member.n}`), userId: id, ...profile },
    });

    await prisma.connectProfile.upsert({
      where: { userId: id },
      update: { lookingFor: member.lookingFor },
      create: {
        id: seedId(`connect:${member.n}`),
        userId: id,
        typeCode: 'FRIENDSHIP',
        lookingFor: member.lookingFor,
        dmPolicy: 'REQUEST_FIRST',
        isVisible: true,
        lastActiveAt: hoursAgo(member.n % 7 === 0 ? 3 : 18 + (member.n % 23) * 7),
        createdAt: joined,
      },
    });

    // One photo each, because the discovery grid draws a tile per profile and these would all be
    // blank — the same floor the members seeded before them were given.
    const postId = seedId(`connect-post:${member.n}:0`);
    const postedAt = daysAgo(8 + (member.n % 11));
    const post = {
      profileId: seedId(`connect:${member.n}`),
      kind: 'PHOTO' as never,
      caption: null,
      position: 0,
      reportToken: reportToken(`connect-post:${member.n}:0`),
      postedAt,
    };

    await prisma.connectPost.upsert({
      where: { id: postId },
      update: post,
      create: { id: postId, ...post },
    });

    await putMedia(ctx, {
      label: `connect:${member.n}:0`,
      uploadedById: id,
      purpose: 'CONNECT',
      kind: 'portrait',
      ownerType: 'CONNECT_POST',
      ownerId: postId,
      position: 0,
      createdAt: postedAt,
    });
  }

  return MEMBERS.length;
};

// ─── Community: what people asked about, and what nobody answered ────────────

/**
 * `topRequests` and `unansweredRequests` are both grouped by category and both dropped below three,
 * so a city with two questions in each of six categories publishes nothing. Four per category is
 * the smallest shape that puts a bar on the screen with a little room above the floor.
 */
/**
 * One title per category carries the words the Pulse action row is about, and it is one of the
 * UNANSWERED ones. The row's button opens the section's own search already searching its subject,
 * and both searches here match on substrings — so a category with four questions in it and the
 * category's own words in none of their titles sends the member to an empty screen. The same is
 * true of the listing text further down.
 */
interface RequestSeed {
  cityId: PulseCity;
  categoryCode: string;
  titles: string[];
  /** How many of them somebody answered. The rest stay open with no reply, which is the gap. */
  answered: number;
}

const REQUESTS: RequestSeed[] = [
  {
    cityId: 'MANCHESTER',
    categoryCode: 'ACCOMMODATION',
    answered: 2,
    titles: [
      'Is a guarantor always needed if you can pay six months up front?',
      'Any landlords near Rusholme who take DSS?',
      'Accommodation in Fallowfield — is £520 a room reasonable?',
      'Moving out before the tenancy ends, what happens to the deposit?',
    ],
  },
  {
    cityId: 'MANCHESTER',
    categoryCode: 'MOVING_HELP',
    answered: 1,
    titles: [
      'Two of us and a sofa, Withington to Chorlton, Saturday',
      'Moving help on the 2nd — anyone with a van? Paying fuel and lunch',
      'Need one more pair of hands to shift a wardrobe upstairs',
      'Boxes going spare after a move? Happy to collect',
    ],
  },
  {
    cityId: 'MANCHESTER',
    categoryCode: 'AIRPORT_PICKUP',
    answered: 1,
    titles: [
      'Landing at Terminal 1 at 6am and the tram is not running',
      'Airport pickup Thursday — mum arrives with three cases and no English',
      'Sharing a taxi from the airport to Levenshulme?',
      'Is the 43 bus safe to take with luggage late at night?',
    ],
  },
  {
    cityId: 'MANCHESTER',
    categoryCode: 'VISA_DOCS',
    answered: 2,
    titles: [
      'BRP says my name is in the wrong order — does it matter?',
      'Share code expired before the landlord used it',
      'Visa docs — does my degree certificate need translating and stamping?',
      'Graduate route application while waiting on results',
    ],
  },
  {
    cityId: 'MANCHESTER',
    categoryCode: 'CHILDCARE',
    answered: 1,
    titles: [
      'Childminders near Longsight with a space after school',
      'Childcare for a night shift — how far ahead do the lists go?',
      'Anyone else doing a school run from Moss Side to Hulme?',
      'Is the 15 free hours available before the term starts?',
    ],
  },
  {
    cityId: 'MANCHESTER',
    categoryCode: 'NHS_HEALTHCARE',
    answered: 2,
    titles: [
      'GP refused to register me without a tenancy agreement',
      'Dentist taking NHS patients anywhere in south Manchester?',
      'NHS maternity booking — how long is the wait in Manchester?',
      'Prescription charges — is there help if you are a student?',
    ],
  },

  {
    cityId: 'MANCHESTER',
    categoryCode: 'BANK_ACCOUNT',
    answered: 1,
    titles: [
      'Which banks here accept a university letter as proof of address?',
      'Bank account before my BRP arrives — is that possible at all?',
      'Opened a joint account and the second name was refused',
      'Does a credit union count for a tenancy reference?',
    ],
  },
  {
    cityId: 'MANCHESTER',
    categoryCode: 'JOBS',
    answered: 1,
    titles: [
      'Warehouse shifts in Trafford Park that do not need a car',
      'Jobs that will take a graduate route visa without asking twice',
      'Is a trial shift supposed to be unpaid?',
      'Reference from an employer abroad — does anyone accept one?',
    ],
  },
  {
    cityId: 'LONDON',
    categoryCode: 'ACCOMMODATION',
    answered: 2,
    titles: [
      'Is it normal to pay a holding deposit before seeing the room?',
      'Agents in Peckham that do not want a UK guarantor',
      'Temporary accommodation — the council said I am not priority need',
      'Sharing with three strangers, how do you split the bills?',
    ],
  },
  {
    cityId: 'LONDON',
    categoryCode: 'JOBS',
    answered: 1,
    titles: [
      'Care work with no UK experience — who actually hires?',
      'Jobs through an agency — are they allowed a fee from my wages?',
      'Right to work check before or after the interview?',
      'Weekend shifts near Croydon, anything going?',
    ],
  },
  {
    cityId: 'LONDON',
    categoryCode: 'BANK_ACCOUNT',
    answered: 1,
    titles: [
      'Which bank opens an account on a share code alone?',
      'Bank account with no proof of address — who actually opens one?',
      'Can I use my brother’s address until my tenancy starts?',
      'Sending money home — what is actually cheapest?',
    ],
  },
  {
    cityId: 'LONDON',
    categoryCode: 'MOVING_HELP',
    answered: 1,
    titles: [
      'One van, north London, Saturday morning — splitting cost',
      'Moving help — two people and a mattress, Walthamstow to Leyton',
      'Anyone free to help carry a fridge up two flights?',
      'Storage for a month between tenancies, south of the river',
    ],
  },
  {
    cityId: 'LONDON',
    categoryCode: 'NHS_HEALTHCARE',
    answered: 2,
    titles: [
      'Registering with a GP while living in temporary housing',
      'Where do you go for a walk-in appointment on a Sunday?',
      'NHS interpreter at a hospital appointment — do you have to ask?',
      'Is the health surcharge refunded if the visa is refused?',
    ],
  },
  {
    cityId: 'LONDON',
    categoryCode: 'LANGUAGE_HELP',
    answered: 1,
    titles: [
      'Free ESOL classes with a creche anywhere in east London?',
      'Language help — who can certify a translation for the Home Office?',
      'Practising spoken English with someone patient',
      'Letter from the council I cannot read — help?',
    ],
  },
];

const seedRequests = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;
  let requests = 0;
  let replies = 0;

  for (const seed of REQUESTS) {
    const pool = membersOf(seed.cityId);

    for (const [index, title] of seed.titles.entries()) {
      const label = `pulse:${seed.cityId}:${seed.categoryCode}:${index}`;
      const id = seedId(`request:${label}`);
      const createdAt = daysAgo(2 + index * 3);
      // The first few are answered; the rest are the unanswered list, which is the one that asks
      // somebody to do something.
      const answered = index < seed.answered;
      const author = pool[index % pool.length];

      const data = {
        authorId: userId(author.n),
        categoryCode: seed.categoryCode,
        title,
        description: null,
        cityId: seed.cityId,
        visibility: 'PUBLIC' as const,
        status: 'OPEN' as const,
        // Written from the replies actually inserted below, never declared beside them.
        replyCount: answered ? 1 : 0,
        helperCount: answered ? 1 : 0,
        viewCount: 6 + index * 5,
        expiresAt: new Date(createdAt.getTime() + 30 * 86_400_000),
        reportToken: reportToken(`request:${label}`),
        createdAt,
      };

      await prisma.communityRequest.upsert({
        where: { id },
        update: data,
        create: { id, ...data },
      });
      requests += 1;

      if (!answered) continue;

      const replyId = seedId(`response:${label}`);
      const helper = pool[(index + 3) % pool.length];
      const reply = {
        requestId: id,
        authorId: userId(helper.n),
        content: 'I went through this a few months ago — happy to talk you through what worked.',
        isHelpOffer: true,
        createdAt: new Date(createdAt.getTime() + 7 * 3_600_000),
      };

      await prisma.requestResponse.upsert({
        where: { id: replyId },
        update: reply,
        create: { id: replyId, ...reply },
      });
      replies += 1;
    }
  }

  return { requests, replies };
};

// ─── Community: a group big enough to be counted ─────────────────────────────

/**
 * `activeGroups` counts people, so it takes the floor of twenty. Both cities had a group with a
 * handful of members and neither published, and London did not have twenty members at all until
 * the cohort above existed.
 */
const seedGroupMembers = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;
  let joined = 0;

  for (const cityId of CITIES) {
    const group = await prisma.group.findFirst({
      where: { deletedAt: null, cityId },
      orderBy: { memberCount: 'desc' },
      select: { id: true, createdById: true },
    });

    if (!group) continue;

    // Everyone in the city who is not already in it, which is how a city group fills up.
    const locals = await prisma.userProfile.findMany({
      where: { cityId, user: { status: 'ACTIVE' } },
      select: { userId: true },
    });

    for (const local of locals) {
      await prisma.groupMembership.upsert({
        where: { groupId_userId: { groupId: group.id, userId: local.userId } },
        update: {},
        create: {
          groupId: group.id,
          userId: local.userId,
          state: 'MEMBER',
          isAdmin: local.userId === group.createdById,
          joinedAt: daysAgo(5 + (local.userId.charCodeAt(0) % 20)),
          decidedAt: daysAgo(5 + (local.userId.charCodeAt(0) % 20)),
        },
      });
    }

    // Counted from the rows rather than incremented, so a reseed cannot drift it.
    const memberCount = await prisma.groupMembership.count({
      where: { groupId: group.id, state: 'MEMBER' },
    });

    await prisma.group.update({ where: { id: group.id }, data: { memberCount } });
    joined += memberCount;
  }

  return joined;
};

// ─── Professionals ───────────────────────────────────────────────────────────

/**
 * Three floors at once: five different professionals before the section says anything, three
 * listings sharing a profession code before that bar appears, and three listings with a price on
 * the same basis before an average may be published. Two codes clear the middle one in each city,
 * because a chart with a single bar is not a chart.
 */
interface ListingSeed {
  n: number;
  cityId: PulseCity;
  professionTitle: string;
  codes: string[];
  about: string;
  priceFrom: number;
  responseMinutes: number;
  years: number;
}

const LISTINGS: ListingSeed[] = [
  {
    n: 200,
    cityId: 'MANCHESTER',
    professionTitle: 'Immigration Adviser',
    codes: ['IMMIGRATION', 'LEGAL'],
    about:
      'Immigration advice on student and graduate route applications, and the paperwork around them.',
    priceFrom: 4500,
    responseMinutes: 90,
    years: 6,
  },
  {
    n: 201,
    cityId: 'MANCHESTER',
    professionTitle: 'Immigration Caseworker',
    codes: ['IMMIGRATION', 'TRANSLATION'],
    about:
      'Immigration advice on family visas and settlement. I will tell you plainly if you do not need me.',
    priceFrom: 4000,
    responseMinutes: 140,
    years: 4,
  },
  {
    n: 202,
    cityId: 'MANCHESTER',
    professionTitle: 'Interpreter, Urdu and Punjabi',
    codes: ['TRANSLATION', 'IMMIGRATION'],
    about:
      'Translation and interpreting for hospital and council appointments, in person or on the phone.',
    priceFrom: 3000,
    responseMinutes: 45,
    years: 8,
  },
  {
    n: 203,
    cityId: 'MANCHESTER',
    professionTitle: 'CV and Interview Coach',
    codes: ['CAREERS_CV', 'TRANSLATION'],
    about:
      'Careers help in two sessions, one on the CV and one on the questions you will be asked.',
    priceFrom: 2500,
    responseMinutes: 200,
    years: 3,
  },
  {
    n: 204,
    cityId: 'MANCHESTER',
    professionTitle: 'Bookkeeper for Small Shops',
    codes: ['FINANCE_ACCOUNTING'],
    about:
      'Finance and bookkeeping for people trading from home: self-assessment and the quarterly returns.',
    priceFrom: 3500,
    responseMinutes: 260,
    years: 7,
  },
  {
    n: 205,
    cityId: 'MANCHESTER',
    professionTitle: 'Handyman and Flat-pack',
    codes: ['TRADES_REPAIRS'],
    about: 'Trades and repairs around a new tenancy: shelves, beds, blinds.',
    priceFrom: 2000,
    responseMinutes: 70,
    years: 10,
  },

  {
    n: 216,
    cityId: 'LONDON',
    professionTitle: 'Immigration Solicitor',
    codes: ['IMMIGRATION', 'LEGAL'],
    about:
      'Immigration advice on appeals and refusals, and the legal side of a decision. Regulated, and Circl has not checked that — ask me for the number.',
    priceFrom: 6500,
    responseMinutes: 120,
    years: 11,
  },
  {
    n: 217,
    cityId: 'LONDON',
    professionTitle: 'Immigration Adviser',
    codes: ['IMMIGRATION', 'TRANSLATION'],
    about: 'Immigration advice on visa extensions and dependants, evenings and weekends.',
    priceFrom: 5000,
    responseMinutes: 95,
    years: 5,
  },
  {
    n: 218,
    cityId: 'LONDON',
    professionTitle: 'Housing Rights Adviser',
    codes: ['PROPERTY_LETTINGS', 'LEGAL'],
    about:
      'Property and lettings: disrepair, deposits and the legal notices that come with them. I read the letter before you reply to it.',
    priceFrom: 4000,
    responseMinutes: 160,
    years: 9,
  },
  {
    n: 219,
    cityId: 'LONDON',
    professionTitle: 'Translator, Tamil and Sinhala',
    codes: ['TRANSLATION'],
    about: 'Translation certified for the Home Office and for universities.',
    priceFrom: 3200,
    responseMinutes: 50,
    years: 6,
  },
  {
    n: 220,
    cityId: 'LONDON',
    professionTitle: 'Careers Adviser, Care Sector',
    codes: ['CAREERS_CV', 'RECRUITMENT', 'TRANSLATION'],
    about: 'Careers advice for care and NHS bank work, including the checks.',
    priceFrom: 2800,
    responseMinutes: 230,
    years: 4,
  },
  {
    n: 221,
    cityId: 'LONDON',
    professionTitle: 'Accountant for Sole Traders',
    codes: ['FINANCE_ACCOUNTING'],
    about:
      'Finance for sole traders: registering, invoicing, and keeping enough back for the tax bill.',
    priceFrom: 4200,
    responseMinutes: 300,
    years: 12,
  },
];

const seedListings = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;

  for (const seed of LISTINGS) {
    const id = seedId(`pulse-listing:${seed.n}`);
    const createdAt = daysAgo(14 + (seed.n % 9));
    const data = {
      userId: userId(seed.n),
      professionTitle: seed.professionTitle,
      experienceLevel: (seed.years >= 8 ? 'EXPERT' : 'MID_LEVEL') as never,
      yearsExperience: seed.years,
      about: seed.about,
      cityId: seed.cityId,
      deliveryMode: 'BOTH' as never,
      priceFrom: seed.priceFrom,
      // One basis across the set on purpose: an average price needs three listings that are
      // actually comparable, and mixing per-hour with per-job would publish a meaningless number.
      priceBasis: 'PER_HOUR' as never,
      isAcceptingWork: true,
      // D13: nothing here is verified, and the listing says so rather than implying otherwise.
      verificationStatus: 'UNVERIFIED' as never,
      consentAccepted: true,
      consentAcceptedAt: createdAt,
      consentVersion: '1.0',
      profileViews: 20 + (seed.n % 40),
      medianResponseMinutes: seed.responseMinutes,
      submittedAt: createdAt,
      createdAt,
    };

    await prisma.professionalListing.upsert({
      where: { userId: data.userId },
      update: data,
      create: { id, ...data },
    });

    const listing = await prisma.professionalListing.findUniqueOrThrow({
      where: { userId: data.userId },
      select: { id: true },
    });

    for (const [index, code] of seed.codes.entries()) {
      await prisma.professionalListingCategory.upsert({
        where: { listingId_code: { listingId: listing.id, code } },
        update: { isPrimary: index === 0 },
        create: { listingId: listing.id, code, isPrimary: index === 0 },
      });
    }
  }

  return LISTINGS.length;
};

// ─── Commerce ────────────────────────────────────────────────────────────────

/**
 * Five different shopkeepers before the section publishes, and then three shops sharing a category
 * and three items inside one before those bars appear. `storesByCategory` was empty everywhere,
 * because no seeded shop had ever been given the categories it trades in.
 */
interface StoreSeed {
  n: number;
  cityId: PulseCity;
  name: string;
  area: string;
  description: string;
  categories: string[];
  items: Array<[string, string, number, string]>;
}

const STORES: StoreSeed[] = [
  {
    n: 206,
    cityId: 'MANCHESTER',
    name: 'Longsight Market Foods',
    area: 'Longsight',
    description: 'Dry goods, spices and frozen fish, open six days.',
    categories: ['FOOD_GROCERIES', 'FRESH_FROZEN'],
    items: [
      ['Ground egusi, fresh', 'Ground weekly, not bagged months ago.', 550, 'FOOD_GROCERIES'],
      [
        'Red palm oil, one litre',
        'Unrefined, from the same supplier for years.',
        900,
        'FOOD_GROCERIES',
      ],
      ['Dried crayfish, ground', 'Sold by weight at the counter.', 700, 'FOOD_GROCERIES'],
      ['Frozen tilapia, whole', 'Cleaned and scaled if you ask.', 1200, 'FRESH_FROZEN'],
    ],
  },
  {
    n: 207,
    cityId: 'MANCHESTER',
    name: 'Hulme Halal Butchers',
    area: 'Hulme',
    description: 'Lamb, goat and chicken, cut to order.',
    categories: ['FRESH_FROZEN', 'FOOD_GROCERIES'],
    items: [
      ['Goat, cut for stew', 'Per kilo, bone in.', 1400, 'FRESH_FROZEN'],
      ['Lamb shoulder', 'Whole or halved.', 1600, 'FRESH_FROZEN'],
      ['Chicken, whole corn-fed', 'Collected same day.', 800, 'FRESH_FROZEN'],
      ['Suya spice blend', 'Made in the shop, hot or mild.', 450, 'FOOD_GROCERIES'],
    ],
  },
  {
    n: 208,
    cityId: 'MANCHESTER',
    name: 'Moss Side Beauty Room',
    area: 'Moss Side',
    description: 'Hair, skin and the things that are hard to find here.',
    categories: ['BEAUTY_HAIR', 'HEALTH'],
    items: [
      ['Shea butter, unrefined 500g', 'Raw, from Tamale.', 950, 'BEAUTY_HAIR'],
      ['Black soap bar', 'Cut from a block.', 400, 'BEAUTY_HAIR'],
      ['Braiding hair, pack of three', 'Colours 1, 1B and 2.', 1100, 'BEAUTY_HAIR'],
      ['Chebe powder', 'Small tins, restocked monthly.', 1300, 'HEALTH'],
    ],
  },
  {
    n: 209,
    cityId: 'MANCHESTER',
    name: 'Rusholme Fabric House',
    area: 'Rusholme',
    description: 'Wax print, lace and tailoring by the same family.',
    categories: ['CLOTHING'],
    items: [
      ['Wax print, six yards', 'Full piece cut from the roll.', 3200, 'CLOTHING'],
      ['Guipure lace, five yards', 'Heavy, for occasions.', 5500, 'CLOTHING'],
      ['Headtie, aso oke', 'Hand-woven, sold on its own.', 2400, 'CLOTHING'],
      ['Alterations, per garment', 'Two days, three in December.', 1500, 'CLOTHING'],
    ],
  },
  {
    n: 210,
    cityId: 'MANCHESTER',
    name: 'Cheetham Hill Home Store',
    area: 'Cheetham Hill',
    description: 'Pots, prayer mats and the rest of a first kitchen.',
    categories: ['HOME', 'OTHER'],
    items: [
      ['Cooking pot, 30cm aluminium', 'The size everyone asks for.', 2200, 'HOME'],
      ['Prayer mat, padded', 'Several colours.', 1800, 'HOME'],
      ['Mortar and pestle, wooden', 'Heavy enough to be useful.', 2600, 'HOME'],
      ['Flask, two litre', 'Keeps hot overnight.', 1400, 'OTHER'],
    ],
  },
  {
    n: 211,
    cityId: 'MANCHESTER',
    name: 'Levenshulme Phone Repair',
    area: 'Levenshulme',
    description: 'Screens, batteries and unlocking, while you wait.',
    categories: ['OTHER', 'HOME'],
    items: [
      ['Screen replacement, most models', 'Forty minutes, parts included.', 5500, 'OTHER'],
      ['Battery replacement', 'Same day.', 3500, 'OTHER'],
      ['Charger, braided cable', 'Lasts longer than the ones at the market.', 900, 'OTHER'],
      ['Phone case, clear', 'Fits what we sell.', 600, 'HOME'],
    ],
  },

  {
    n: 222,
    cityId: 'LONDON',
    name: 'Peckham Provisions',
    area: 'Peckham',
    description: 'West African groceries, five minutes from the station.',
    categories: ['FOOD_GROCERIES', 'FRESH_FROZEN'],
    items: [
      ['Puna yam, whole', 'Sweet and firm, good for pounding.', 1100, 'FRESH_FROZEN'],
      ['Ripe plantain, five', 'Ready to fry.', 450, 'FRESH_FROZEN'],
      ['Ogbono, ground', 'Ground to order.', 650, 'FOOD_GROCERIES'],
      ['Stockfish, dried', 'By weight.', 1500, 'FOOD_GROCERIES'],
    ],
  },
  {
    n: 223,
    cityId: 'LONDON',
    name: 'Dalston East Asian Grocer',
    area: 'Dalston',
    description: 'Noodles, sauces and fresh greens twice a week.',
    categories: ['FOOD_GROCERIES', 'FRESH_FROZEN'],
    items: [
      ['Rice noodles, 400g', 'Flat, for pho.', 300, 'FOOD_GROCERIES'],
      ['Fish sauce, 700ml', 'The one people come back for.', 550, 'FOOD_GROCERIES'],
      ['Morning glory, bunch', 'Delivered Tuesdays and Fridays.', 350, 'FRESH_FROZEN'],
      ['Frozen dumplings, 30', 'Pork or vegetable.', 800, 'FRESH_FROZEN'],
    ],
  },
  {
    n: 224,
    cityId: 'LONDON',
    name: 'Brixton Hair and Skin',
    area: 'Brixton',
    description: 'Wigs, braids and treatments, and advice given freely.',
    categories: ['BEAUTY_HAIR', 'HEALTH'],
    items: [
      ['Henna cones, pack of twelve', 'Fresh stock weekly.', 650, 'BEAUTY_HAIR'],
      ['Kohl liner', 'Several shades.', 500, 'BEAUTY_HAIR'],
      ['Wig cap, pack of two', 'Breathable.', 400, 'BEAUTY_HAIR'],
      ['Hair oil, 200ml', 'Castor and rosemary.', 750, 'HEALTH'],
    ],
  },
  {
    n: 225,
    cityId: 'LONDON',
    name: 'Whitechapel Textiles',
    area: 'Whitechapel',
    description: 'Fabric by the yard and a tailor at the back.',
    categories: ['CLOTHING'],
    items: [
      ['Ankara wax print, six yards', 'Cut from the roll.', 3000, 'CLOTHING'],
      ['Shalwar kameez, ready made', 'Sizes S to XXL on the rail.', 3800, 'CLOTHING'],
      ['Cotton lining, per metre', 'Several colours.', 500, 'CLOTHING'],
      ['Tailoring, made to measure', 'Two fittings.', 7500, 'CLOTHING'],
    ],
  },
  {
    n: 226,
    cityId: 'LONDON',
    name: 'Tottenham Home Essentials',
    area: 'Tottenham',
    description: 'What you need when the flat is empty and the budget is not big.',
    categories: ['HOME', 'OTHER'],
    items: [
      ['Pressure cooker, 6 litre', 'The one that gets borrowed.', 3400, 'HOME'],
      ['Bedding set, double', 'Plain cotton.', 2200, 'HOME'],
      ['Kettle, stainless', 'Two year guarantee.', 1600, 'HOME'],
      ['Extension lead, four socket', 'Surge protected.', 1200, 'OTHER'],
    ],
  },
  {
    n: 227,
    cityId: 'LONDON',
    name: 'Croydon Halal Meats',
    area: 'Croydon',
    description: 'Butcher and freezer, family run since the shop opened.',
    categories: ['FRESH_FROZEN', 'FOOD_GROCERIES'],
    items: [
      ['Mutton, cut for curry', 'Per kilo.', 1500, 'FRESH_FROZEN'],
      ['Chicken thighs, boneless', 'Two kilo bags.', 1300, 'FRESH_FROZEN'],
      ['Beef mince, lean', 'Minced in the shop.', 1100, 'FRESH_FROZEN'],
      ['Basmati rice, 10kg', 'Aged, the sack everyone buys.', 2800, 'FOOD_GROCERIES'],
    ],
  },
];

const seedStores = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;
  let items = 0;
  let enquiries = 0;

  for (const seed of STORES) {
    const id = seedId(`pulse-store:${seed.n}`);
    const ownerId = userId(seed.n);
    const createdAt = daysAgo(25 + (seed.n % 12));
    const data = {
      ownerId,
      name: seed.name,
      typeCode: 'LOCAL',
      description: seed.description,
      area: seed.area,
      cityId: seed.cityId,
      status: 'OPEN' as never,
      fulfilment: 'COLLECTION' as never,
      delivers: false,
      // Hidden, which is the common case for a shop run out of a home, and why there is no pin.
      hidesExactAddress: true,
      viewCount: 30 + (seed.n % 50),
      reportToken: reportToken(`pulse-store:${seed.n}`),
      createdAt,
    };

    await prisma.store.upsert({ where: { ownerId }, update: data, create: { id, ...data } });

    const store = await prisma.store.findUniqueOrThrow({
      where: { ownerId },
      select: { id: true },
    });

    for (const code of seed.categories) {
      await prisma.storeCategory.upsert({
        where: { storeId_code: { storeId: store.id, code } },
        update: {},
        create: { storeId: store.id, code },
      });
    }

    // A day left out is a day closed, which is how `isOpenNow` reads it (4.4.2).
    for (const day of ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']) {
      await prisma.storeOpeningHours.upsert({
        where: { storeId_day: { storeId: store.id, day: day as never } },
        update: { openMinutes: 540, closeMinutes: 1140 },
        create: { storeId: store.id, day: day as never, openMinutes: 540, closeMinutes: 1140 },
      });
    }

    const created: Array<{ id: string; name: string; price: number }> = [];

    for (const [index, [name, description, price, categoryCode]] of seed.items.entries()) {
      const itemId = seedId(`pulse-item:${seed.n}:${index}`);
      const itemData = {
        storeId: store.id,
        name,
        description,
        price,
        categoryCode,
        unitCode: 'EACH',
        availability: 'ON_SALE' as never,
        viewCount: 10 + index * 6,
        createdAt,
      };

      await prisma.storeItem.upsert({
        where: { id: itemId },
        update: itemData,
        create: { id: itemId, ...itemData },
      });
      created.push({ id: itemId, name, price });
      items += 1;
    }

    // `topProducts` sums quantities across enquiry lines and drops anything under three, so one
    // enquiry for one of something publishes nothing. Two lines, three and four deep.
    const buyers = membersOf(seed.cityId).filter(member => member.n !== seed.n);
    const buyer = buyers[seed.n % buyers.length];
    const enquiryId = seedId(`pulse-enquiry:${seed.n}`);
    const lines = created.slice(0, 2).map((item, index) => ({ item, quantity: 4 - index }));
    const enquiryData = {
      reference: `PLS-${String(seed.n)}`,
      buyerId: userId(buyer.n),
      storeId: store.id,
      sellerId: ownerId,
      fulfilment: 'COLLECTION' as never,
      note: 'Collecting Saturday morning if that suits.',
      estimatedTotal: lines.reduce((total, line) => total + line.item.price * line.quantity, 0),
      createdAt: daysAgo(4 + (seed.n % 8)),
    };

    await prisma.enquiry.upsert({
      where: { id: enquiryId },
      update: enquiryData,
      create: { id: enquiryId, ...enquiryData },
    });

    for (const [index, line] of lines.entries()) {
      const lineId = seedId(`pulse-line:${seed.n}:${index}`);
      const lineData = {
        enquiryId,
        itemId: line.item.id,
        name: line.item.name,
        quantity: line.quantity,
        unitPrice: line.item.price,
        unitCode: 'EACH',
      };

      await prisma.enquiryLine.upsert({
        where: { id: lineId },
        update: lineData,
        create: { id: lineId, ...lineData },
      });
    }

    await prisma.store.update({
      where: { id: store.id },
      data: { enquiryCount: 1 },
    });
    enquiries += 1;
  }

  return { stores: STORES.length, items, enquiries };
};

/**
 * `storesByCategory` was empty in every city, nationwide included, because no seeded shop had ever
 * been given the categories it trades in — the earlier seeders write heritage tags, which are a
 * different list. Derived from what each shop actually stocks rather than declared beside it, so a
 * shop cannot claim a category it sells nothing in.
 */
const backfillStoreCategories = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;
  const stores = await prisma.store.findMany({
    where: { deletedAt: null, cityId: { in: [...CITIES] } },
    select: { id: true, items: { where: { deletedAt: null }, select: { categoryCode: true } } },
  });

  let written = 0;

  for (const store of stores) {
    for (const code of new Set(store.items.map(item => item.categoryCode))) {
      await prisma.storeCategory.upsert({
        where: { storeId_code: { storeId: store.id, code } },
        update: {},
        create: { storeId: store.id, code },
      });
      written += 1;
    }
  }

  return written;
};

// ─── Professionals: jobs actually finished ───────────────────────────────────

/**
 * `jobsThisPeriod` counts completed bookings and is not floored, so it printed a truthful but
 * forlorn 2 beside twelve listings. One finished job per new listing, each with the service it was
 * booked for, because a booking whose subject does not exist renders with nothing to open (2.6.3).
 */
const seedCompletedJobs = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;
  let jobs = 0;

  for (const seed of LISTINGS) {
    const listing = await prisma.professionalListing.findUnique({
      where: { userId: userId(seed.n) },
      select: { id: true },
    });

    if (!listing) continue;

    const serviceId = seedId(`pulse-service:${seed.n}`);
    const service = {
      listingId: listing.id,
      name: `${seed.professionTitle}, first session`,
      description: 'One session, and a note afterwards of what was agreed.',
      price: seed.priceFrom,
      priceBasis: 'PER_HOUR' as never,
      isActive: true,
      sort: 0,
    };

    await prisma.professionalService.upsert({
      where: { id: serviceId },
      update: service,
      create: { id: serviceId, ...service },
    });

    const clients = membersOf(seed.cityId).filter(member => member.n !== seed.n);
    const client = clients[seed.n % clients.length];
    const id = seedId(`pulse-booking:${seed.n}`);
    const createdAt = daysAgo(11 + (seed.n % 7));
    const completedAt = daysAgo(4 + (seed.n % 5));
    const booking = {
      clientId: userId(client.n),
      professionalId: userId(seed.n),
      listingId: listing.id,
      serviceId,
      serviceName: service.name,
      serviceDescription: service.description,
      quotedAmount: seed.priceFrom,
      agreedAmount: seed.priceFrom,
      state: 'COMPLETED' as never,
      mode: 'ONLINE' as never,
      preferredDate: null,
      isFlexible: true,
      deliveredAt: daysAgo(5 + (seed.n % 5)),
      completedAt,
      firstClientMessageAt: createdAt,
      firstProReplyAt: new Date(createdAt.getTime() + seed.responseMinutes * 60_000),
      createdAt,
    };

    await prisma.booking.upsert({ where: { id }, update: booking, create: { id, ...booking } });

    // The timeline reads these, not the columns, so a booking without them opens blank.
    for (const [stage, reachedAt] of [
      ['REQUESTED', createdAt],
      ['ACCEPTED', new Date(createdAt.getTime() + 4 * 3_600_000)],
      ['DELIVERED', booking.deliveredAt],
      ['DONE', completedAt],
    ] as const) {
      await prisma.bookingEvent.upsert({
        where: { bookingId_stage: { bookingId: id, stage: stage as never } },
        update: { reachedAt },
        create: { bookingId: id, stage: stage as never, reachedAt },
      });
    }

    await prisma.professionalListing.update({
      where: { id: listing.id },
      data: { jobsCompleted: 1 },
    });

    jobs += 1;
  }

  return jobs;
};

export const seedPulse = async (ctx: DemoSeedContext) => {
  const members = await seedMembers(ctx);
  const community = await seedRequests(ctx);
  const grouped = await seedGroupMembers(ctx);
  const listings = await seedListings(ctx);
  const jobs = await seedCompletedJobs(ctx);
  const commerce = await seedStores(ctx);
  const categories = await backfillStoreCategories(ctx);

  return { members, ...community, grouped, listings, jobs, ...commerce, categories };
};
