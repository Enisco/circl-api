import { TaxonomyKind } from '@prisma/client';

export interface TaxonomySeed {
  kind: TaxonomyKind;
  code: string;
  label: string;
  description?: string;
  sort: number;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

/** D1 and D22: seed the full vocabulary, activate the subset the app ships. */

// ─── Community categories (spec 0.7, D1) ──────────────────────────────────────
// The 15 the app ships, then the 8 the v2 product spec names and the app does not yet render.
const communityCategories: Array<[string, string, boolean, string[]]> = [
  ['UNIVERSITY_STUDY', 'University / Study', true, ['EDUCATION_TUTORING']],
  ['AIRPORT_PICKUP', 'Airport Pickup', true, ['LOGISTICS']],
  ['NHS_HEALTHCARE', 'NHS / Healthcare', true, ['HEALTHCARE']],
  ['BANK_ACCOUNT', 'Bank Account', true, ['FINANCE_ACCOUNTING']],
  ['ACCOMMODATION', 'Accommodation', true, ['PROPERTY_LETTINGS']],
  ['VISA_DOCS', 'Visa / COS / Docs', true, ['IMMIGRATION', 'LEGAL']],
  ['JOBS', 'Jobs', true, ['CAREERS_CV', 'RECRUITMENT']],
  ['MOVING_HELP', 'Moving Help', true, ['LOGISTICS']],
  ['MAKE_FRIENDS', 'Make Friends', true, []],
  ['LANGUAGE_HELP', 'Language Help', true, ['TRANSLATION', 'EDUCATION_TUTORING']],
  ['SHOPPING_ERRANDS', 'Shopping / Errands', true, ['LOGISTICS']],
  ['CHILDCARE', 'Childcare', true, ['CHILDCARE_SERVICES']],
  ['BEAUTY_HAIR', 'Beauty / Hair', true, ['BEAUTY_HAIR_SERVICES']],
  ['REPAIRS_HANDY', 'Repairs / Handy', true, ['TRADES_REPAIRS']],
  ['OTHER', 'Other', true, []],
  ['SETTLING_IN', 'Settling In', false, []],
  ['TRANSPORT', 'Transport', false, ['LOGISTICS']],
  ['LEGAL_RIGHTS', 'Legal Rights', false, ['LEGAL']],
  ['BENEFITS_SUPPORT', 'Benefits & Support', false, ['FINANCE_ACCOUNTING']],
  ['MENTAL_HEALTH', 'Mental Health', false, ['HEALTHCARE', 'THERAPY_COACHING']],
  ['CHILDREN_FAMILY', 'Children & Family', false, ['CHILDCARE_SERVICES']],
  ['BUSINESS_SETUP', 'Business Setup', false, ['BUSINESS_CONSULTING', 'FINANCE_ACCOUNTING']],
  ['JOB_SEARCH', 'Job Search', false, ['CAREERS_CV', 'RECRUITMENT']],
];

// ─── Professions (D8) ─────────────────────────────────────────────────────────
// `isRegulated` and `credentialBodies` drive the credential step's field labels without a hardcoded map in the client (2.7.4), and — more importantly this release — let a regulated profile print the visible line saying Circl has not verified it (D13).
//
// `requiresReview` is a **different** question and the two are deliberately not the same column
// (§2.9). `isRegulated` asks "is there a regulator"; `requiresReview` asks "may this person offer
// this service at all, and should somebody read the listing before anybody can find it". They
// overlap heavily and are still not the same flag: `TRANSLATION` has professional bodies in
// `credentialBodies` and is not gated, because a bad translation is a bad service rather than a
// legal or safeguarding event.
//
// The seven gated here are the **default**, not the rule. Trust & Safety, managers and super admins
// change the set from the portal (`PUT admin/professional-reviews/categories`, permission
// `professions:gate`), which rewrites this flag and applies the consequences to listings already
// in the profession. This file is only what a fresh database starts with — so a seed run must not
// undo a decision somebody made in the portal, which is why `seedTaxonomy` preserves the live
// value of this one key. See `prisma/seeders/taxonomy.seeder.ts`.
//
// Three professions were considered and left **off** by default, recorded here because the
// reasoning is the useful part if anybody turns them on later:
//
//   - `TRADES_REPAIRS` — gas work without Gas Safe registration is a criminal offence, but the
//     category is mostly flat-pack and shelves, and gating all of it to catch the gas is a wide net.
//   - `EDUCATION_TUTORING` — unsupervised contact with children, but most of it is adult English
//     conversation practice.
//   - `RECRUITMENT` — "a job with visa sponsorship" is a common fraud against this community.
//
const professions: Array<[string, string, boolean, string[], boolean]> = [
  // Giving immigration advice in the UK without IAA (ex-OISC) regulation or an exemption is a
  // criminal offence, and this audience is overwhelmingly people who need that advice. If one
  // profession justified the whole feature it is this one.
  ['IMMIGRATION', 'Immigration Advice', true, ['IAA'], true],
  ['LEGAL', 'Legal', true, ['SRA', 'BSB', 'CILEx'], true],
  // Unauthorised investment, mortgage and debt advice is a criminal offence; tax agents act on
  // somebody else's behalf with HMRC.
  ['FINANCE_ACCOUNTING', 'Finance & Accounting', true, ['ACCA', 'ICAEW', 'CIMA', 'FCA'], true],
  ['HEALTHCARE', 'Healthcare', true, ['GMC', 'NMC', 'HCPC', 'GPhC'], true],
  // "Coach" is unregulated, which is precisely why the wording has to be read by somebody: the
  // risk here is a vulnerable person being treated by an untrained one.
  ['THERAPY_COACHING', 'Therapy & Coaching', true, ['BACP', 'UKCP', 'HCPC'], true],
  ['CHILDCARE_SERVICES', 'Childcare', true, ['Ofsted'], true],
  // Client money and mandatory redress-scheme membership; deposit fraud against new arrivals is
  // the oldest scam on this platform's beat.
  ['PROPERTY_LETTINGS', 'Property & Lettings', true, ['ARLA', 'RICS', 'NAEA'], true],
  // Not gated by default; see the three bullets above. The flag is what the portal changes.
  ['TRADES_REPAIRS', 'Trades & Repairs', false, ['Gas Safe', 'NICEIC'], false],
  ['EDUCATION_TUTORING', 'Education & Tutoring', false, [], false],
  ['RECRUITMENT', 'Recruitment', false, [], false],
  ['CAREERS_CV', 'Careers & CV', false, [], false],
  ['TRANSLATION', 'Translation & Interpreting', false, ['CIOL', 'ITI'], false],
  ['DESIGN_CREATIVE', 'Design & Creative', false, [], false],
  ['TECH_SOFTWARE', 'Tech & Software', false, [], false],
  ['MARKETING', 'Marketing & Social Media', false, [], false],
  ['BUSINESS_CONSULTING', 'Business Consulting', false, [], false],
  ['BEAUTY_HAIR_SERVICES', 'Beauty & Hair', false, [], false],
  ['LOGISTICS', 'Driving & Logistics', false, [], false],
  ['EVENTS_CATERING', 'Events & Catering', false, [], false],
  ['PHOTOGRAPHY_VIDEO', 'Photography & Video', false, [], false],
  ['CLEANING', 'Cleaning', false, [], false],
  ['OTHER', 'Other', false, [], false],
];

// ─── Guide topics (spec 0.7) ──────────────────────────────────────────────────
const guideTopics: Array<[string, string]> = [
  ['FINANCE', 'Finance'],
  ['HEALTH', 'Health'],
  ['HOUSING', 'Housing'],
  ['VISA_DOCS', 'Visa & Docs'],
  ['JOBS', 'Jobs'],
  ['TRANSPORT', 'Transport'],
  ['EDUCATION', 'Education'],
  ['CULTURE', 'Culture'],
];

// ─── Heritage (3.1.4) ─────────────────────────────────────────────────────────
// One list used by three things: a member's heritage in Connect, a store's community tags in Commerce, and discovery filters in both.
const heritageTags: Array<[string, string]> = [
  ['WEST_AFRICAN', 'West African'],
  ['EAST_AFRICAN', 'East African'],
  ['NORTH_AFRICAN', 'North African'],
  ['SOUTHERN_AFRICAN', 'Southern African'],
  ['CENTRAL_AFRICAN', 'Central African'],
  ['CARIBBEAN', 'Caribbean'],
  ['SOUTH_ASIAN', 'South Asian'],
  ['EAST_ASIAN', 'East Asian'],
  ['SOUTH_EAST_ASIAN', 'South East Asian'],
  ['MIDDLE_EASTERN', 'Middle Eastern'],
  ['LATIN_AMERICAN', 'Latin American'],
  ['EASTERN_EUROPEAN', 'Eastern European'],
  ['SOUTHERN_EUROPEAN', 'Southern European'],
  ['BRITISH', 'British'],
  ['OTHER', 'Other'],
];

// ─── Journey stage ────────────────────────────────────────────────────────────
// `isNewToUk` is what the Connect `newToUk` filter reads, defined once here so the chip and the query cannot drift (3.4).
const journeyStages: Array<[string, string, boolean]> = [
  ['PLANNING', 'Planning to move', true],
  ['JUST_ARRIVED', 'Just arrived (0-3 months)', true],
  ['SETTLING_IN', 'Settling in (3-12 months)', false],
  ['ESTABLISHED', 'Established (1 year+)', false],
  ['CITIZEN_SETTLED', 'Settled or a citizen', false],
];

/**
 * What a member picks in onboarding, and the only thing the feed ranker can act on: it scores an
 * item when `viewer.interests` contains the item's `categoryCode`. So an interest that is not also
 * a community category can never move the feed, which is why the first fifteen here share their
 * codes with `communityCategories` exactly.
 *
 * The rest are the lifestyle topics, which have no category to match and earn their place in
 * Connect instead, where interests are what two people have in common.
 *
 * The four deactivated ones each say the same thing as a category above it — Study against
 * University / Study, Parenting against Children & Family — and one picker should not offer the
 * same idea twice. Deactivated rather than removed, so a member who already holds one still reads
 * a label rather than a raw code.
 */
const interests: Array<[string, string, boolean]> = [
  ['UNIVERSITY_STUDY', 'University / Study', true],
  ['AIRPORT_PICKUP', 'Airport Pickup', true],
  ['NHS_HEALTHCARE', 'NHS / Healthcare', true],
  ['BANK_ACCOUNT', 'Bank Account', true],
  ['ACCOMMODATION', 'Accommodation', true],
  ['VISA_DOCS', 'Visa / COS / Docs', true],
  ['JOB_SEARCH', 'Job Search', true],
  ['MAKE_FRIENDS', 'Make Friends', true],
  ['LANGUAGE_HELP', 'Language Help', true],
  ['TRANSPORT', 'Transport', true],
  ['CHILDREN_FAMILY', 'Children & Family', true],
  ['LEGAL_RIGHTS', 'Legal Rights', true],
  ['BENEFITS_SUPPORT', 'Benefits & Support', true],
  ['MENTAL_HEALTH', 'Mental Health', true],
  ['BUSINESS_SETUP', 'Business Setup', true],
  ['FOOD_COOKING', 'Food & Cooking', true],
  ['SPORT_FITNESS', 'Sport & Fitness', true],
  ['MUSIC', 'Music', true],
  ['FAITH_COMMUNITY', 'Faith & Community', true],
  ['TECH', 'Tech', true],
  ['TRAVEL', 'Travel', true],
  ['FASHION_BEAUTY', 'Fashion & Beauty', true],
  ['FILM_TV', 'Film & TV', true],
  ['ART_CULTURE', 'Art & Culture', true],
  ['VOLUNTEERING', 'Volunteering', true],
  ['GAMING', 'Gaming', true],
  ['READING', 'Reading', true],
  ['OUTDOORS', 'Outdoors', true],
  ['STUDY', 'Study', false],
  ['PARENTING', 'Parenting', false],
  ['LANGUAGES', 'Languages', false],
  ['BUSINESS', 'Business', false],
];

/**
 * The third value is ISO 639-1 (639-3 where no two-letter code exists), served as `iso` so
 * the client can key on a standard identifier. `code` stays as it is because it is already
 * stored on member profiles and is stable against a label change on its own.
 */
const languages: Array<[string, string, string]> = [
  ['ENGLISH', 'English', 'en'],
  ['YORUBA', 'Yoruba', 'yo'],
  ['IGBO', 'Igbo', 'ig'],
  ['HAUSA', 'Hausa', 'ha'],
  ['NIGERIAN_PIDGIN', 'Nigerian Pidgin', 'pcm'],
  ['TWI', 'Twi', 'tw'],
  ['SWAHILI', 'Swahili', 'sw'],
  ['SOMALI', 'Somali', 'so'],
  ['AMHARIC', 'Amharic', 'am'],
  ['TIGRINYA', 'Tigrinya', 'ti'],
  ['ARABIC', 'Arabic', 'ar'],
  ['FRENCH', 'French', 'fr'],
  ['PORTUGUESE', 'Portuguese', 'pt'],
  ['SPANISH', 'Spanish', 'es'],
  ['URDU', 'Urdu', 'ur'],
  ['HINDI', 'Hindi', 'hi'],
  ['PUNJABI', 'Punjabi', 'pa'],
  ['BENGALI', 'Bengali', 'bn'],
  ['TAMIL', 'Tamil', 'ta'],
  ['GUJARATI', 'Gujarati', 'gu'],
  ['MANDARIN', 'Mandarin', 'zh'],
  ['CANTONESE', 'Cantonese', 'yue'],
  ['TAGALOG', 'Tagalog', 'tl'],
  ['POLISH', 'Polish', 'pl'],
  ['ROMANIAN', 'Romanian', 'ro'],
  ['RUSSIAN', 'Russian', 'ru'],
  ['UKRAINIAN', 'Ukrainian', 'uk'],
  ['TURKISH', 'Turkish', 'tr'],
  ['FARSI', 'Farsi', 'fa'],
  ['PASHTO', 'Pashto', 'ps'],
  ['KRIO', 'Krio', 'kri'],
  ['LINGALA', 'Lingala', 'ln'],
];

/** Why somebody is on Connect, and the sentence under each one on the setup screen (3.1). */
const connectionTypes: Array<[string, string, string]> = [
  ['FRIENDSHIP', 'Friendship', 'Meet people and build a circle where you live.'],
  ['NETWORKING', 'Networking', 'Meet people in your field or industry.'],
  ['LANGUAGE_EXCHANGE', 'Language Exchange', 'Practise a language, help with yours.'],
  ['STUDY_PARTNER', 'Study Partner', 'Revise, prepare and keep each other going.'],
  ['FLATMATE', 'Flatmate', 'Find someone to share a place with.'],
  ['DATING', 'Dating', 'Meet someone. 18+ only.'],
];

/**
 * The questions a Connect profile answers (3.3). Served rather than shipped so they can be
 * reworded without a release — and the question travels with the answer on read, so a rewording
 * never silently changes what somebody already said.
 *
 * Sixteen, open rather than yes/no, and none of them about dating: five of the six connection
 * types are not, and a prompt that only makes sense on a dating profile is dead on the other five.
 * The label IS the question, because that is what a profile renders.
 */
const connectPrompts: Array<[string, string]> = [
  ['FIRST_THING', "The first thing I'd show you in this city…"],
  ['MISS_MOST', 'What I miss most from home…'],
  ['ASK_ME_ABOUT', 'Ask me about…'],
  ['WEEKEND', 'A good weekend looks like…'],
  ['MOVED_HERE', 'What brought me here…'],
  ['GOOD_AT', "Something I'm unreasonably good at…"],
  ['LEARNING', "Something I'm learning…"],
  ['FOOD', 'The meal I cook when somebody comes over…'],
  ['SUNDAY', 'Where to find me on a Sunday…'],
  ['WISH_KNOWN', 'Something I wish I had known when I arrived…'],
  ['HELP_WITH', 'I can help somebody with…'],
  ['LOOKING_FOR_HELP', "I'd like help with…"],
  ['LANGUAGE', 'The language I switch to at home…'],
  ['PROUD_OF', 'Something I am proud of…'],
  ['UNPOPULAR', 'An opinion nobody here agrees with…'],
  ['NEXT_YEAR', 'Where I would like to be in a year…'],
];

// ─── Commerce (4.2, D22) ──────────────────────────────────────────────────────
// The app renders 8; the v2 spec lists 12. Same rule as D1.
const itemCategories: Array<[string, string, boolean]> = [
  ['FOOD_GROCERIES', 'Food & groceries', true],
  ['FRESH_FROZEN', 'Fresh & frozen', true],
  ['DRINKS', 'Drinks', true],
  ['BEAUTY_HAIR', 'Beauty & hair', true],
  ['CLOTHING', 'Clothing', true],
  ['HOME', 'Home', true],
  ['HEALTH', 'Health', true],
  ['OTHER', 'Other', true],
  ['BABY_KIDS', 'Baby & kids', false],
  ['ELECTRONICS', 'Electronics & accessories', false],
  ['JEWELLERY', 'Jewellery & accessories', false],
  ['RELIGIOUS_CULTURAL', 'Religious & cultural', false],
];

const itemUnits: Array<[string, string]> = [
  ['EACH', 'each'],
  ['PER_KG', 'per kg'],
  ['PER_500G', 'per 500g'],
  ['PER_PACK', 'per pack'],
  ['PER_LITRE', 'per litre'],
  ['PER_HOUR', 'per hour'],
];

// Bands carry their pence bounds rather than being parsed from a label.
const priceBands: Array<[string, string, number, number | null]> = [
  ['UNDER_5', 'Under £5', 0, 499],
  ['FROM_5_TO_10', '£5 – £10', 500, 1000],
  ['FROM_10_TO_20', '£10 – £20', 1001, 2000],
  ['OVER_20', 'Over £20', 2001, null],
];

const storeTypes: Array<[string, string, string]> = [
  [
    'LOCAL',
    'Local Store',
    'Native and cultural items — African groceries, Caribbean products, South Asian goods.',
  ],
  [
    'GENERAL',
    'General Store',
    'Everyday items — perfume, phone accessories, jewellery, clothing, home goods.',
  ],
];

const contactChannels: Array<[string, string]> = [
  ['PHONE', 'Phone'],
  ['WHATSAPP', 'WhatsApp'],
  ['INSTAGRAM', 'Instagram'],
  ['TIKTOK', 'TikTok'],
  ['WEBSITE', 'Website'],
];

const storeHelpAreas: Array<[string, string]> = [
  ['LISTINGS', 'Writing and photographing listings'],
  ['ADVERTISING', 'Advertising and reach'],
  ['SEO', 'Search and discovery'],
  ['DELIVERY', 'Delivery and collection'],
  ['PRICING', 'Pricing and stock'],
  // The honest answer from a seller who does not know where to start, and the one the app already
  // offered. Last, because it is the fallback rather than the first thing to reach for.
  ['EVERYTHING', 'All of it — I do not know where to start'],
];

// The tags a reviewer can attach (2.5.2, max 5).
const helpTags: Array<[string, string]> = [
  ['VISA_ADVICE', 'Visa advice'],
  ['HOUSING_HELP', 'Housing help'],
  ['JOB_HELP', 'Job help'],
  ['AIRPORT_PICKUP', 'Airport pickup'],
  ['TRANSLATION', 'Translation'],
  ['PAPERWORK', 'Paperwork'],
  ['MOVING', 'Moving'],
  ['CHILDCARE', 'Childcare'],
  ['NHS_HELP', 'NHS and GP help'],
  ['LOCAL_KNOWLEDGE', 'Local knowledge'],
  ['JUST_KIND', 'Just being kind'],
  ['WENT_ABOVE_AND_BEYOND', 'Went above and beyond'],
  ['QUICK_TO_REPLY', 'Quick to reply'],
  ['CLEAR_EXPLANATION', 'Clear explanation'],
  ['FAIR_PRICE', 'Fair price'],
  ['ON_TIME', 'On time'],
  ['GOOD_QUALITY', 'Good quality'],
];

// ─── Notification categories (spec 6.1.4, D38) ────────────────────────────────
// The rows of the preference matrix.
const notificationCategories: Array<[string, string, boolean, boolean, boolean]> = [
  // code, label, default push, default email, locked
  ['REPLIES', 'Replies to my posts', true, false, false],
  ['OFFERS', 'Offers of help', true, true, false],
  ['MESSAGES', 'Messages', true, false, false],
  ['GROUPS', 'Group activity', false, false, false],
  ['CONNECTIONS', 'Connection requests', true, false, false],
  ['BOOKINGS', 'Bookings & orders', true, true, false],
  ['COMPLIANCE', 'Verification & payments', true, true, true],
  ['ANNOUNCEMENTS', 'News from Circl', true, false, false],
  // Warnings, removals, suspensions and the appeal route (§7.3). Locked, like COMPLIANCE: a member
  // who has turned everything off still has to be told what was done to their account and how to
  // dispute it. A notice somebody can switch off is not a notice.
  ['ACCOUNT', 'Your account', true, true, true],
  // Likes and saves. The most mutable notification on the platform, so it is never locked, and
  // email defaults off because an email per like is how people turn off email entirely.
  ['REACTIONS', 'Likes and saves', true, false, false],
];

// ─── Guard categories (spec 6.3.1) ────────────────────────────────────────────
// What a private request to Circl is about.
const guardCategories: Array<[string, string]> = [
  ['HOUSING', 'Housing'],
  ['IMMIGRATION', 'Immigration'],
  ['SAFETY', 'Safety'],
  ['MONEY', 'Money'],
  ['HEALTH', 'Health'],
  ['WORK', 'Work'],
  ['OTHER', 'Something else'],
];

// ─── Vocabularies that were Dart constants until now (BACKEND-DATA-GAPS G1) ───
// Every one of them is content, not chrome: the wording is member-visible and the value is
// stored against a record, so it could not change without an app release.

const genders: Array<[string, string]> = [
  ['MALE', 'Male'],
  ['FEMALE', 'Female'],
  ['NON_BINARY', 'Non-binary'],
  ['OTHER', 'Other'],
];

/** Step 0 of the managed request flow. */
const managedCategories: Array<[string, string]> = [
  ['LEGAL_HELP', 'Legal help'],
  ['HEALTH_NHS', 'Health / NHS'],
  ['TAX_FINANCE', 'Tax / Finance'],
  ['IMMIGRATION', 'Immigration'],
  ['TRANSLATION', 'Translation'],
  ['CAREER_CV', 'Career / CV'],
  ['TECH_SUPPORT', 'Tech support'],
  ['LOGISTICS', 'Logistics'],
];

/** Matches the ExperienceLevel enum exactly: the label moves, the code does not. */
const experienceLevels: Array<[string, string]> = [
  ['BEGINNER', 'Beginner'],
  ['MID_LEVEL', 'Mid-level'],
  ['EXPERT', 'Expert'],
];

/** Matches BriefUrgency. */
const urgencyOptions: Array<[string, string]> = [
  ['ASAP', 'ASAP'],
  ['THIS_WEEK', 'This week'],
  ['THIS_MONTH', 'This month'],
  ['FLEXIBLE', 'Flexible'],
];

/**
 * Bounds rather than a label the client parses back into a range, which is the drift the price
 * bands were given minPence/maxPence to avoid. A null maxAge is open-ended, as in "45+".
 */
const connectAgeBands: Array<[string, string, number, number | null]> = [
  ['AGE_18_24', '18–24', 18, 24],
  ['AGE_25_34', '25–34', 25, 34],
  ['AGE_35_44', '35–44', 35, 44],
  ['AGE_45_PLUS', '45+', 45, null],
];

/** The keys the browse endpoint already accepts. Only the wording moves server-side. */
const professionalSortOptions: Array<[string, string]> = [
  ['RECOMMENDED', 'Recommended'],
  ['RATING', 'Highest rated'],
  ['REVIEWS', 'Most reviewed'],
  ['NEAREST', 'Nearest'],
  ['PRICE', 'Lowest price'],
  ['RESPONSE', 'Fastest to reply'],
];

/**
 * The feed filter row. The client used to pick these by array index, so a reorder filtered for
 * whatever happened to be third. "All" is the absence of `types`; there is no ALL member of
 * FeedItemType and sending one would be a 422.
 *
 * GUIDE is deliberately not here. It is a real FeedItemType, but the feed drops guides whether or
 * not they are asked for — they have their own tab — so a Guides chip would be a filter that can
 * only ever come back empty.
 */
const feedTypes: Array<[string, string]> = [
  ['UPDATE', 'Posts'],
  ['REQUEST', 'Requests'],
  ['OFFER', 'Services'],
];

/** What `GET /commerce/stores?sort=` and `GET /commerce/items?sort=` accept. */
const commerceSortOptions: Array<[string, string]> = [
  ['RECOMMENDED', 'Recommended'],
  ['NEAREST', 'Nearest'],
  ['RATING', 'Highest rated'],
  ['NEWEST', 'Newest'],
  ['PRICE_LOW', 'Price: low to high'],
  ['PRICE_HIGH', 'Price: high to low'],
];

/** What `GET /community/requests?status=` accepts. CLOSED covers resolved, closed and expired. */
const requestStatuses: Array<[string, string]> = [
  ['ALL', 'All'],
  ['OPEN', 'Open'],
  ['CLOSED', 'Closed'],
];

const pair = (kind: TaxonomyKind, rows: Array<[string, string]>): TaxonomySeed[] =>
  rows.map(([code, label], index) => ({ kind, code, label, sort: index + 1 }));

export const taxonomySeeds: TaxonomySeed[] = [
  ...communityCategories.map(([code, label, isActive, suggested], index) => ({
    kind: TaxonomyKind.COMMUNITY_CATEGORY,
    code,
    label,
    sort: index + 1,
    isActive,
    // The bridge that lets offer promotion prefill a profession (D8), so the member confirms rather than choosing from scratch.
    metadata: { suggestedProfessionCodes: suggested },
  })),
  ...professions.map(([code, label, isRegulated, credentialBodies, requiresReview], index) => ({
    kind: TaxonomyKind.PROFESSION,
    code,
    label,
    sort: index + 1,
    metadata: { isRegulated, credentialBodies, requiresReview },
  })),
  ...pair(TaxonomyKind.GUIDE_TOPIC, guideTopics),
  ...pair(TaxonomyKind.HERITAGE_TAG, heritageTags),
  ...journeyStages.map(([code, label, isNewToUk], index) => ({
    kind: TaxonomyKind.JOURNEY_STAGE,
    code,
    label,
    sort: index + 1,
    metadata: { isNewToUk },
  })),
  ...interests.map(([code, label, isActive], index) => ({
    kind: TaxonomyKind.INTEREST,
    code,
    label,
    sort: index + 1,
    isActive,
  })),
  ...languages.map(([code, label, isoCode], index) => ({
    kind: TaxonomyKind.LANGUAGE,
    code,
    label,
    sort: index + 1,
    metadata: { iso: isoCode },
  })),
  ...connectionTypes.map(([code, label, description], index) => ({
    kind: TaxonomyKind.CONNECTION_TYPE,
    code,
    label,
    description,
    sort: index + 1,
  })),
  ...connectPrompts.map(([code, question], index) => ({
    kind: TaxonomyKind.CONNECT_PROMPT,
    code,
    // The label is the question: a profile renders this string, not a name for it.
    label: question,
    sort: index + 1,
  })),
  ...itemCategories.map(([code, label, isActive], index) => ({
    kind: TaxonomyKind.ITEM_CATEGORY,
    code,
    label,
    sort: index + 1,
    isActive,
  })),
  ...pair(TaxonomyKind.ITEM_UNIT, itemUnits),
  ...priceBands.map(([code, label, minPence, maxPence], index) => ({
    kind: TaxonomyKind.ITEM_PRICE_BAND,
    code,
    label,
    sort: index + 1,
    metadata: { minPence, maxPence },
  })),
  ...storeTypes.map(([code, label, blurb], index) => ({
    kind: TaxonomyKind.STORE_TYPE,
    code,
    label,
    sort: index + 1,
    metadata: { blurb },
  })),
  ...pair(TaxonomyKind.STORE_CONTACT_CHANNEL, contactChannels),
  ...pair(TaxonomyKind.STORE_HELP_AREA, storeHelpAreas),
  ...pair(TaxonomyKind.HELP_TAG, helpTags),
  ...notificationCategories.map(([code, label, push, email, isLocked], index) => ({
    kind: TaxonomyKind.NOTIFICATION_CATEGORY,
    code,
    label,
    sort: index + 1,
    metadata: { defaultPush: push, defaultEmail: email, isLocked },
  })),
  ...pair(TaxonomyKind.GUARD_CATEGORY, guardCategories),
  ...pair(TaxonomyKind.GENDER, genders),
  ...pair(TaxonomyKind.MANAGED_CATEGORY, managedCategories),
  ...pair(TaxonomyKind.EXPERIENCE_LEVEL, experienceLevels),
  ...pair(TaxonomyKind.URGENCY, urgencyOptions),
  ...connectAgeBands.map(([code, label, minAge, maxAge], index) => ({
    kind: TaxonomyKind.CONNECT_AGE_BAND,
    code,
    label,
    sort: index + 1,
    metadata: { minAge, maxAge },
  })),
  ...pair(TaxonomyKind.PROFESSIONAL_SORT_OPTION, professionalSortOptions),
  ...pair(TaxonomyKind.FEED_TYPE, feedTypes),
  ...pair(TaxonomyKind.REQUEST_STATUS, requestStatuses),
  ...pair(TaxonomyKind.COMMERCE_SORT_OPTION, commerceSortOptions),
];
