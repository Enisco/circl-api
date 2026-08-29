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
const professions: Array<[string, string, boolean, string[]]> = [
  ['LEGAL', 'Legal', true, ['SRA', 'BSB', 'CILEx']],
  ['IMMIGRATION', 'Immigration Advice', true, ['IAA']],
  ['HEALTHCARE', 'Healthcare', true, ['GMC', 'NMC', 'HCPC', 'GPhC']],
  ['THERAPY_COACHING', 'Therapy & Coaching', true, ['BACP', 'UKCP', 'HCPC']],
  ['FINANCE_ACCOUNTING', 'Finance & Accounting', true, ['ACCA', 'ICAEW', 'CIMA', 'FCA']],
  ['PROPERTY_LETTINGS', 'Property & Lettings', true, ['ARLA', 'RICS', 'NAEA']],
  ['CHILDCARE_SERVICES', 'Childcare', true, ['Ofsted']],
  ['EDUCATION_TUTORING', 'Education & Tutoring', false, []],
  ['CAREERS_CV', 'Careers & CV', false, []],
  ['RECRUITMENT', 'Recruitment', false, []],
  ['TRANSLATION', 'Translation & Interpreting', false, ['CIOL', 'ITI']],
  ['DESIGN_CREATIVE', 'Design & Creative', false, []],
  ['TECH_SOFTWARE', 'Tech & Software', false, []],
  ['MARKETING', 'Marketing & Social Media', false, []],
  ['BUSINESS_CONSULTING', 'Business Consulting', false, []],
  ['BEAUTY_HAIR_SERVICES', 'Beauty & Hair', false, []],
  ['TRADES_REPAIRS', 'Trades & Repairs', false, ['Gas Safe', 'NICEIC']],
  ['LOGISTICS', 'Driving & Logistics', false, []],
  ['EVENTS_CATERING', 'Events & Catering', false, []],
  ['PHOTOGRAPHY_VIDEO', 'Photography & Video', false, []],
  ['CLEANING', 'Cleaning', false, []],
  ['OTHER', 'Other', false, []],
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

const interests: Array<[string, string]> = [
  ['JOB_SEARCH', 'Job Search'],
  ['FOOD_COOKING', 'Food & Cooking'],
  ['SPORT_FITNESS', 'Sport & Fitness'],
  ['MUSIC', 'Music'],
  ['FAITH_COMMUNITY', 'Faith & Community'],
  ['TECH', 'Tech'],
  ['STUDY', 'Study'],
  ['TRAVEL', 'Travel'],
  ['FASHION_BEAUTY', 'Fashion & Beauty'],
  ['FILM_TV', 'Film & TV'],
  ['ART_CULTURE', 'Art & Culture'],
  ['VOLUNTEERING', 'Volunteering'],
  ['BUSINESS', 'Business'],
  ['PARENTING', 'Parenting'],
  ['LANGUAGES', 'Languages'],
  ['GAMING', 'Gaming'],
  ['READING', 'Reading'],
  ['OUTDOORS', 'Outdoors'],
];

const languages: Array<[string, string]> = [
  ['ENGLISH', 'English'],
  ['YORUBA', 'Yoruba'],
  ['IGBO', 'Igbo'],
  ['HAUSA', 'Hausa'],
  ['NIGERIAN_PIDGIN', 'Nigerian Pidgin'],
  ['TWI', 'Twi'],
  ['SWAHILI', 'Swahili'],
  ['SOMALI', 'Somali'],
  ['AMHARIC', 'Amharic'],
  ['TIGRINYA', 'Tigrinya'],
  ['ARABIC', 'Arabic'],
  ['FRENCH', 'French'],
  ['PORTUGUESE', 'Portuguese'],
  ['SPANISH', 'Spanish'],
  ['URDU', 'Urdu'],
  ['HINDI', 'Hindi'],
  ['PUNJABI', 'Punjabi'],
  ['BENGALI', 'Bengali'],
  ['TAMIL', 'Tamil'],
  ['GUJARATI', 'Gujarati'],
  ['MANDARIN', 'Mandarin'],
  ['CANTONESE', 'Cantonese'],
  ['TAGALOG', 'Tagalog'],
  ['POLISH', 'Polish'],
  ['ROMANIAN', 'Romanian'],
  ['RUSSIAN', 'Russian'],
  ['UKRAINIAN', 'Ukrainian'],
  ['TURKISH', 'Turkish'],
  ['FARSI', 'Farsi'],
  ['PASHTO', 'Pashto'],
  ['KRIO', 'Krio'],
  ['LINGALA', 'Lingala'],
];

// ─── Countries of origin ──────────────────────────────────────────────────────
// ISO 3166-1 alpha-2.
const countries: Array<[string, string]> = [
  ['NG', 'Nigeria'], ['GH', 'Ghana'], ['KE', 'Kenya'], ['ZA', 'South Africa'],
  ['ZW', 'Zimbabwe'], ['UG', 'Uganda'], ['TZ', 'Tanzania'], ['CM', 'Cameroon'],
  ['CI', "Côte d'Ivoire"], ['SN', 'Senegal'], ['SL', 'Sierra Leone'], ['LR', 'Liberia'],
  ['GM', 'Gambia'], ['CD', 'DR Congo'], ['AO', 'Angola'], ['MZ', 'Mozambique'],
  ['ET', 'Ethiopia'], ['ER', 'Eritrea'], ['SO', 'Somalia'], ['SD', 'Sudan'],
  ['EG', 'Egypt'], ['MA', 'Morocco'], ['DZ', 'Algeria'], ['TN', 'Tunisia'],
  ['JM', 'Jamaica'], ['TT', 'Trinidad and Tobago'], ['BB', 'Barbados'], ['GY', 'Guyana'],
  ['IN', 'India'], ['PK', 'Pakistan'], ['BD', 'Bangladesh'], ['LK', 'Sri Lanka'],
  ['NP', 'Nepal'], ['AF', 'Afghanistan'], ['IR', 'Iran'], ['IQ', 'Iraq'],
  ['SY', 'Syria'], ['LB', 'Lebanon'], ['JO', 'Jordan'], ['PS', 'Palestine'],
  ['TR', 'Türkiye'], ['CN', 'China'], ['HK', 'Hong Kong'], ['PH', 'Philippines'],
  ['MY', 'Malaysia'], ['ID', 'Indonesia'], ['VN', 'Vietnam'], ['TH', 'Thailand'],
  ['PL', 'Poland'], ['RO', 'Romania'], ['BG', 'Bulgaria'], ['LT', 'Lithuania'],
  ['LV', 'Latvia'], ['UA', 'Ukraine'], ['RU', 'Russia'], ['AL', 'Albania'],
  ['PT', 'Portugal'], ['ES', 'Spain'], ['IT', 'Italy'], ['FR', 'France'],
  ['DE', 'Germany'], ['BR', 'Brazil'], ['CO', 'Colombia'], ['VE', 'Venezuela'],
  ['US', 'United States'], ['CA', 'Canada'], ['AU', 'Australia'], ['NZ', 'New Zealand'],
  ['IE', 'Ireland'], ['GB', 'United Kingdom'], ['OTHER', 'Other'],
];

const connectionTypes: Array<[string, string, string]> = [
  ['FRIENDSHIP', 'Friendship', 'Meet people and build a circle where you live.'],
  ['NETWORKING', 'Networking', 'Meet people in your field or industry.'],
  ['LANGUAGE_EXCHANGE', 'Language Exchange', 'Practise a language, help with yours.'],
  ['STUDY_PARTNER', 'Study Partner', 'Revise, prepare and keep each other going.'],
  ['FLATMATE', 'Flatmate', 'Find someone to share a place with.'],
  ['DATING', 'Dating', 'Meet someone. 18+ only.'],
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
  ['ORDERS', 'Handling enquiries and orders'],
  ['DELIVERY', 'Delivery and collection'],
  ['PRICING', 'Pricing and stock'],
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
  ['LOCAL_KNOWLEDGE', 'Local knowledge'],
  ['WENT_ABOVE_AND_BEYOND', 'Went above and beyond'],
  ['QUICK_TO_REPLY', 'Quick to reply'],
  ['CLEAR_EXPLANATION', 'Clear explanation'],
  ['FAIR_PRICE', 'Fair price'],
  ['ON_TIME', 'On time'],
  ['GOOD_QUALITY', 'Good quality'],
];

// ─── Notification categories (spec 6.1.3, D38) ────────────────────────────────
// The eight rows of the preference matrix.
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

const pair = (
  kind: TaxonomyKind,
  rows: Array<[string, string]>,
): TaxonomySeed[] => rows.map(([code, label], index) => ({ kind, code, label, sort: index + 1 }));

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
  ...professions.map(([code, label, isRegulated, credentialBodies], index) => ({
    kind: TaxonomyKind.PROFESSION,
    code,
    label,
    sort: index + 1,
    metadata: { isRegulated, credentialBodies },
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
  ...pair(TaxonomyKind.INTEREST, interests),
  ...pair(TaxonomyKind.LANGUAGE, languages),
  ...pair(TaxonomyKind.COUNTRY_OF_ORIGIN, countries),
  ...connectionTypes.map(([code, label, description], index) => ({
    kind: TaxonomyKind.CONNECTION_TYPE,
    code,
    label,
    description,
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
];
