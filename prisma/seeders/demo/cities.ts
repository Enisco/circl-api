import { PostVisibility } from '@prisma/client';
import { DemoSeedContext, putMedia, userId } from './seed-demo';
import { hoursAgo, seedId } from './ids';
import { reportToken } from './community';
import { connectExtras, PEOPLE } from './people';

/**
 * Feed content for every city in the picker (BACKEND-FEED-ACTIONS §2).
 *
 * Two problems this fixes. There were no `UPDATE` items anywhere, so the post card the home
 * screen is built around never rendered. And content sat in three cities, so a member signing up
 * in Sheffield opened an empty app, which reads as broken rather than quiet.
 */

/** The twelve in the picker. BRISTOL is deliberately absent: see EMPTY_CITY. */
const CITIES = [
  'MANCHESTER', 'LONDON', 'BIRMINGHAM', 'LEEDS', 'NOTTINGHAM', 'SHEFFIELD',
  'LIVERPOOL', 'EDINBURGH', 'GLASGOW', 'CARDIFF', 'NEWCASTLE',
] as const;

/**
 * One city stays empty so the client's "It is quiet here today" state is reachable without
 * pointing at a broken API. Nothing else about it is special: a member there can still post, and
 * the moment they do it stops being empty.
 */
export const EMPTY_CITY = 'BRISTOL';

/** Everyone who can author city content: the ten, plus the Connect-only members. */
const AUTHORS = [...PEOPLE.map(p => p.n), ...connectExtras().map(p => p.n)];

/**
 * Post bodies, deliberately uneven. Some are one line, some a paragraph. Written per city where
 * the detail is local, so switching city in the picker visibly changes the feed rather than
 * showing the same ten rows with the name swapped.
 */
const POSTS: Record<string, string[]> = {
  MANCHESTER: [
    'Six months today since I landed. Still cannot get used to how early it gets dark.',
    'The Curry Mile on a Friday night is the closest thing to home I have found here. Went with two people from this app and we stayed until it closed.',
    'PSA: the Arndale post office does the passport check-and-send and there was no queue at 9am.',
    'Does anyone else find the trams stop running much earlier than you would expect on a Sunday? Missed one by four minutes and it was the last.',
    'Started volunteering at a food bank in Longsight on Saturdays. If anyone wants to come along, they always need people who speak more than one language.',
    'Got my NIN letter after nine weeks. Nine. For anyone waiting: it does come.',
    'Small win. Cooked jollof for my flatmates and they finished the pot.',
  ],
  LONDON: [
    'Two years in London this week. The rent is criminal and I would not leave.',
    'If you are new: get the Oyster before the contactless. I know everyone says otherwise but the weekly cap saved me a fortune while I was between jobs.',
    'Peckham on a Saturday morning is the only place I have found plantain that is actually ripe.',
    'Anyone know a barber in south London who has cut afro hair before? I have had two bad experiences and I am losing patience.',
    'The free museums are genuinely free. I did not believe it for the first month.',
    'Moved from Zone 4 to Zone 2 and my commute went from 70 minutes to 20. Worth every extra pound.',
  ],
  BIRMINGHAM: [
    'The library here is enormous and nobody told me. Four floors and a roof garden.',
    'Been here eight months. Birmingham gets talked about like a smaller London and it really is not, it is its own thing and I like it more for that.',
    'Balti Triangle recommendations? Been to two and want to try more.',
    'Bus into the city centre took 15 minutes and cost £2. After three years in London I nearly fell over.',
    'Anyone doing the Cannon Hill parkrun on Saturdays? Slow runner, friendly, would like company.',
    'Found a shop on Ladypool Road that stocks proper egusi. Been looking since March.',
  ],
  LEEDS: [
    'Kirkgate Market is underrated. Fresh fish, and the man on the corner stall will tell you how to cook it.',
    'Six weeks in Leeds. It is greener than I expected and the hills are worse than I expected.',
    'Night bus survival tip from a nurse: the 16 runs all night and the drivers are kind about it.',
    'Anyone else here on shift work? Trying to find people who are free on a Tuesday afternoon.',
    'Roundhay Park on a clear day is the reason I stopped complaining about the weather.',
    'The council tax exemption for students is real but you have to claim it. Nobody tells you.',
  ],
  NOTTINGHAM: [
    'Nottingham is the first city here where I have not felt like a visitor.',
    'The tram is genuinely good. Say what you like about the rest of it.',
    'Looking for a study group for accountancy exams. I am the only one in my office doing them.',
    'Went to the Caribbean carnival in August and it was the first time since I moved that I heard music I grew up with in the street.',
    'Rent here is half what I was paying in London for twice the flat. Still adjusting.',
    'Anyone know where to get hair braided in Hyson Green? Asking for the third time this month.',
  ],
  SHEFFIELD: [
    'Seven hills and I walk up four of them daily. My legs have never been better.',
    'The Peak District is 25 minutes on a bus. Twenty five minutes.',
    'New here and looking for a church with an African congregation. Any pointers welcome.',
    'Sheffield people say hello to strangers on the street and it took me a full month to stop being suspicious of it.',
    'Student city so the summer is very quiet, which nobody warned me about. It is nice actually.',
    'Found a Somali cafe near London Road that does proper tea. I am there most Sundays.',
  ],
  LIVERPOOL: [
    'Liverpool accents defeated me for six weeks. I am about 70 percent there now.',
    'The waterfront on a clear evening is worth the whole move.',
    'Anyone here work nights at the hospital? Trying to find people on the same schedule.',
    'Got a bike off Marketplace for £40 and my life has completely changed. Everything is 12 minutes away.',
    'Toxteth has the best food in this city and I will not be arguing about it.',
    'Six months in and someone called me "lad" without irony. I have arrived.',
  ],
  EDINBURGH: [
    'Nobody warned me the Festival makes the whole city unrecognisable for a month.',
    'Arthur\'s Seat before work. Cold, steep, absolutely worth it.',
    'Looking for other people doing a masters here who are not 22. Feeling my age in seminars.',
    'The rent jumps in August because of the Festival and comes back down in September. Learned that the expensive way.',
    'Found a Nigerian shop in Leith. Small, but it has everything that matters.',
    'It is beautiful and it is cold and both of those are more true than I expected.',
  ],
  GLASGOW: [
    'Glasgow is the friendliest city I have lived in and that includes home.',
    'The subway is one circle. That is the whole system. I find it charming.',
    'Anyone playing five-a-side on weekday evenings? I am not good but I am reliable.',
    'Rain here is not an event, it is a background condition, and once you accept that it is fine.',
    'Got my first UK job offer this week after eleven months of applying. Do not give up.',
    'The West End on a Sunday afternoon with the markets on is my favourite thing here.',
  ],
  CARDIFF: [
    'Everything is bilingual and I have started picking up Welsh by accident.',
    'Cardiff is small enough to walk across and I did not know how much I wanted that.',
    'Match day turns the whole city into one thing. Even if you do not follow rugby, go once.',
    'Looking for other parents with primary-age kids. School gate conversation is hard when you are new.',
    'The bay in summer is genuinely lovely and I did not expect to say that about a regenerated dock.',
    'Found a halal butcher on City Road who will cut things properly if you ask.',
  ],
  NEWCASTLE: [
    'Newcastle in January is a test and I passed it.',
    'The bridges at night are the reason I moved here rather than Sunderland, if I am honest.',
    'People here go out in shirtsleeves in December. I have stopped trying to understand it.',
    'Anyone else from West Africa in the north east? It can feel thin sometimes and I would like to know people.',
    'Rent is the lowest of anywhere I have looked and the city still has everything.',
    'Grainger Market for vegetables, every time. Half the supermarket price.',
  ],
};

/** Requests per city. Two OPEN each at minimum, so "Near you" is never empty. */
const REQUEST_TEMPLATES: Array<[string, string, string]> = [
  ['BANK_ACCOUNT', 'Which bank actually opens an account without a utility bill in {city}?', 'I have my BRP and a tenancy agreement but no bill in my name. Two branches have turned me away already.'],
  ['NHS_HEALTHCARE', 'Which GP surgeries in {city} are taking new patients?', 'I have been refused at two because of the catchment area and I am not sure what proof they actually need.'],
  ['ACCOMMODATION', 'Is this rent normal for a one bed in {city}?', 'Been quoted a figure that seems high for the area and I have nobody local to sanity-check it against.'],
  ['JOBS', 'Anyone hiring part time around {city}?', 'Available evenings and weekends, right to work in order, happy to start with anything.'],
  ['MOVING_HELP', 'Need a hand moving a small flat in {city} on Saturday', 'Two suitcases, a mattress and some boxes. I can pay for petrol and lunch.'],
];

/** Offers per city. */
const OFFER_TEMPLATES: Array<[string, string, string, number | null]> = [
  ['AIRPORT_PICKUP', 'Airport runs from {city}, any hour', 'I drive nights anyway. If your flight lands at 4am I would rather you were not waiting for the first bus.', null],
  ['CV_REVIEW', 'Free CV read for anyone job hunting in {city}', 'I hire for a living. Send it over and I will tell you what a UK recruiter sees in the first ten seconds.', null],
  ['TRANSLATION', 'Help with official letters in {city}', 'Council, NHS, landlord. I will tell you what it actually means rather than translating word for word.', 2500],
  ['MOVING_HELP', 'Van and a spare pair of hands, {city} area', 'Weekends mostly. Cheaper than a removal firm and I will not break your things.', 4000],
];

/** Guides per city, on top of the national ones. */
const GUIDE_TEMPLATES: Array<[string, string, string, string[]]> = [
  ['HOUSING', 'Renting in {city} without a UK guarantor', 'Most agents will ask for a guarantor who owns UK property. Here is what to do when you do not have one.', [
    'Ask directly whether they accept six months rent up front, and get the answer in writing before you pay anything.',
    'A guarantor service costs roughly one week of rent and most agents accept them. Compare two before you commit.',
    'An employer reference letter on headed paper does more work than people expect. Ask HR for one.',
    'If an agent refuses every option and keeps the holding deposit, that is a complaint to the redress scheme they are legally required to belong to.',
  ]],
  ['HEALTH', 'Registering with a GP in {city}', 'You do not need proof of address or immigration status to register. Surgeries get this wrong regularly.', [
    'Find your nearest surgeries on the NHS website and check which are accepting patients.',
    'Fill in form GMS1. The address section is for their records, not an eligibility test.',
    'If you are refused, ask for the refusal in writing. Most refusals stop at that point.',
    'Register before you are ill. Getting an appointment as a new patient during an emergency is the worst time to be doing paperwork.',
  ]],
  ['MONEY', 'Council tax in {city}: who pays and who does not', 'Full time students are exempt, but only if they claim it. It does not happen automatically.', [
    'Get a council tax certificate from your university. Most issue them from the student portal.',
    'Upload it on the council website under student exemption.',
    'If everyone in the property is a full time student the bill goes to zero. One non-student and it drops by 25 percent instead.',
    'Bills already issued get cancelled and refunded once the exemption is applied, so do not panic about a demand letter.',
  ]],
];

/** Not round. 47 and 12 read as real; 50 and 10 do not. */
const messy = (seedValue: string, min: number, max: number): number => {
  let hash = 0;

  for (const character of seedValue) hash = (hash * 31 + character.charCodeAt(0)) % 100_000;

  return min + (hash % (max - min + 1));
};

export const seedCityFeeds = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;
  const counts = { updates: 0, requests: 0, offers: 0, guides: 0, replies: 0 };

  for (const [cityIndex, cityId] of CITIES.entries()) {
    const city = cityId.charAt(0) + cityId.slice(1).toLowerCase();
    const bodies = POSTS[cityId];

    // ── Posts ────────────────────────────────────────────────────────────────
    for (const [index, content] of bodies.entries()) {
      const label = `${cityId}:${index}`;
      const id = seedId(`update:${label}`);
      const author = AUTHORS[(cityIndex * 7 + index * 3) % AUTHORS.length];
      // Every fifth post is anonymous, every seventh has comments off, so both paths are
      // reachable without hunting for them.
      const isAnonymous = index % 5 === 4;
      const commentsOff = index % 7 === 6;

      const data = {
        authorId: userId(author),
        content,
        cityId,
        visibility: isAnonymous ? PostVisibility.ANONYMOUS : PostVisibility.PUBLIC,
        commentsEnabled: !commentsOff,
        reactionCount: messy(label, 3, 61),
        replyCount: 0,
        viewCount: messy(`v${label}`, 40, 400),
        reportToken: reportToken(`update:${label}`),
        // Spread over weeks rather than all at once.
        createdAt: hoursAgo(6 + index * 29 + cityIndex * 11),
      };

      await prisma.communityUpdate.upsert({ where: { id }, update: data, create: { id, ...data } });
      counts.updates += 1;

      // One image in each of the first two cities. Most posts have none.
      if (index === 1 && cityIndex < 2) {
        await putMedia(ctx, {
          label: `update:${label}`,
          uploadedById: userId(author),
          purpose: 'COMMUNITY',
          kind: 'banner',
          ownerType: 'COMMUNITY_UPDATE',
          ownerId: id,
          createdAt: data.createdAt,
        });
      }

      // The first two posts in every city carry a thread, so the detail screen is never empty.
      if (index < 2) {
        const replies = [
          'This is exactly what I needed to read today, thank you for posting it.',
          'Same here. Took me about three months before it stopped feeling temporary.',
          'Saving this. I am moving over in January and half of what I know is guesswork.',
        ].slice(0, 2 + (index % 2));

        for (const [replyIndex, replyContent] of replies.entries()) {
          const replyId = seedId(`update-reply:${label}:${replyIndex}`);
          const replyAuthor = AUTHORS[(cityIndex * 5 + replyIndex * 9 + 3) % AUTHORS.length];
          const replyData = {
            updateId: id,
            authorId: userId(replyAuthor),
            content: replyContent,
            createdAt: hoursAgo(Math.max(1, 6 + index * 29 + cityIndex * 11 - replyIndex - 1)),
          };

          await prisma.updateReply.upsert({
            where: { id: replyId },
            update: replyData,
            create: { id: replyId, ...replyData },
          });
          counts.replies += 1;
        }

        await prisma.communityUpdate.update({
          where: { id },
          data: { replyCount: replies.length },
        });
      }
    }

    // ── Requests ─────────────────────────────────────────────────────────────
    for (const [index, [categoryCode, title, description]] of REQUEST_TEMPLATES.entries()) {
      const label = `${cityId}:${index}`;
      const id = seedId(`city-request:${label}`);
      const author = AUTHORS[(cityIndex * 3 + index * 5 + 1) % AUTHORS.length];
      // The first two stay OPEN in every city, so "Near you" always has something.
      const status = index < 2 ? 'OPEN' : index === 2 ? 'RESOLVED' : 'OPEN';
      const data = {
        authorId: userId(author),
        categoryCode,
        title: title.replace('{city}', city),
        description,
        cityId,
        status: status as never,
        viewCount: messy(`r${label}`, 9, 130),
        reportToken: reportToken(`city-request:${label}`),
        createdAt: hoursAgo(9 + index * 41 + cityIndex * 7),
        ...(status === 'RESOLVED' ? { resolvedAt: hoursAgo(4 + index * 41) } : {}),
      };

      await prisma.communityRequest.upsert({ where: { id }, update: data, create: { id, ...data } });
      counts.requests += 1;
    }

    // ── Offers ───────────────────────────────────────────────────────────────
    for (const [index, [categoryCode, title, description, priceFrom]] of OFFER_TEMPLATES.entries()) {
      const label = `${cityId}:${index}`;
      const id = seedId(`city-offer:${label}`);
      const author = AUTHORS[(cityIndex * 4 + index * 6 + 2) % AUTHORS.length];
      const data = {
        authorId: userId(author),
        categoryCode,
        title: title.replace('{city}', city),
        description,
        cityId,
        deliveryMode: 'IN_PERSON' as never,
        priceFrom,
        priceBasis: (priceFrom ? 'PER_JOB' : 'NEGOTIABLE') as never,
        viewCount: messy(`o${label}`, 7, 95),
        reportToken: reportToken(`city-offer:${label}`),
        createdAt: hoursAgo(14 + index * 53 + cityIndex * 9),
      };

      await prisma.communityOffer.upsert({ where: { id }, update: data, create: { id, ...data } });
      counts.offers += 1;
    }

    // ── Guides ───────────────────────────────────────────────────────────────
    for (const [index, [topicCode, title, intro, steps]] of GUIDE_TEMPLATES.entries()) {
      const label = `${cityId}:${index}`;
      const id = seedId(`city-guide:${label}`);
      const author = AUTHORS[(cityIndex * 6 + index * 4 + 5) % AUTHORS.length];
      const data = {
        authorId: userId(author),
        topicCode,
        title: title.replace('{city}', city),
        intro,
        blocks: steps.map((text, position) => ({ type: 'STEP', text, position })) as never,
        cityId,
        readTimeMinutes: 2 + index,
        viewCount: messy(`g${label}`, 30, 480),
        likeCount: messy(`gl${label}`, 2, 43),
        isAutoGenerated: false,
        publishedAt: hoursAgo(48 + index * 71 + cityIndex * 13),
        createdAt: hoursAgo(50 + index * 71 + cityIndex * 13),
      };

      await prisma.guide.upsert({ where: { id }, update: data, create: { id, ...data } });
      counts.guides += 1;
    }
  }

  return { ...counts, cities: CITIES.length, emptyCity: EMPTY_CITY };
};
