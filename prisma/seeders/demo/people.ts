/** The ten, sketched (B.5). */
export interface SeedPerson {
  /** 1..10. `seed{n}@circl.test` and the id seed both derive from it. */
  n: number;
  firstName: string;
  /** Null on one member, so the nullable last name path renders (0.16.2). */
  lastName: string | null;
  username: string;
  cityId: string;
  countryOfOrigin: string;
  /** Null on one member, so the initials fallback is visible (B.4). */
  hasAvatar: boolean;
  /** Null on one member, so the no-bio path renders (B.4). */
  bio: string | null;
  canHelpWith: string | null;
  /** Spread over months, so "member since" is not all one date. */
  joinedDaysAgo: number;
  dateOfBirth: string;
  heritageTag: string;
  journeyStage: string;
  interests: string[];
  languages: string[];
  shape: string;
}

export const PEOPLE: SeedPerson[] = [
  {
    n: 1,
    firstName: 'Amara',
    lastName: 'Okonkwo',
    username: 'amaraok',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'NG',
    hasAvatar: true,
    bio: 'Came over for my masters in 2023 and stayed. Still learning which bus actually turns up.',
    canHelpWith: 'CV reviews, Airport runs, Opening a bank account',
    joinedDaysAgo: 240,
    dateOfBirth: '1994-03-11',
    heritageTag: 'WEST_AFRICAN',
    journeyStage: 'ESTABLISHED',
    interests: ['JOB_SEARCH', 'FOOD_COOKING', 'STUDY', 'MUSIC', 'TRAVEL'],
    languages: ['ENGLISH', 'YORUBA'],
    shape: 'The demo account. Active everywhere.',
  },
  {
    n: 2,
    firstName: 'Ravi',
    lastName: 'Menon',
    username: 'ravimenon',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'IN',
    hasAvatar: false,
    bio: null,
    canHelpWith: null,
    joinedDaysAgo: 4,
    dateOfBirth: '2001-09-02',
    heritageTag: 'SOUTH_ASIAN',
    journeyStage: 'JUST_ARRIVED',
    interests: ['STUDY', 'TECH', 'GAMING', 'SPORT_FITNESS'],
    languages: ['ENGLISH', 'HINDI'],
    shape: 'New arrival. Thin profile, one request, no replies. No avatar, no bio.',
  },
  {
    n: 3,
    firstName: 'Blessing',
    lastName: 'Adeyemi',
    username: 'blessingade',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'NG',
    hasAvatar: true,
    bio: 'Immigration adviser. Nine years of it, most of them explaining the same three forms.',
    canHelpWith: 'Visa paperwork, Right to work checks',
    joinedDaysAgo: 400,
    dateOfBirth: '1988-06-24',
    heritageTag: 'WEST_AFRICAN',
    journeyStage: 'ESTABLISHED',
    interests: ['JOB_SEARCH', 'BUSINESS', 'FAITH_COMMUNITY', 'READING', 'PARENTING'],
    languages: ['ENGLISH', 'YORUBA'],
    shape: 'Established professional. Many reviews, several services, bookings in several states.',
  },
  {
    n: 4,
    firstName: 'Chidi',
    lastName: 'Nwosu',
    username: 'chidinwosu',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'GH',
    hasAvatar: true,
    bio: 'Just set up as a handyman. Ask me about flat-pack furniture and radiators.',
    canHelpWith: 'Small repairs',
    joinedDaysAgo: 21,
    dateOfBirth: '1992-11-30',
    heritageTag: 'WEST_AFRICAN',
    journeyStage: 'SETTLING_IN',
    interests: ['SPORT_FITNESS', 'TECH', 'MUSIC', 'OUTDOORS'],
    languages: ['ENGLISH', 'TWI'],
    shape: 'Newly listed professional. No reviews, no bookings, availability off.',
  },
  {
    n: 5,
    firstName: 'Farida',
    lastName: 'Rahman',
    username: 'faridarahman',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'BD',
    hasAvatar: true,
    bio: 'Translator and interpreter. Bengali, Hindi, English, and a lot of patience.',
    canHelpWith: 'Translation, Letters from the council',
    joinedDaysAgo: 300,
    dateOfBirth: '1985-01-19',
    heritageTag: 'SOUTH_ASIAN',
    journeyStage: 'ESTABLISHED',
    interests: ['LANGUAGES', 'ART_CULTURE', 'FILM_TV', 'READING', 'VOLUNTEERING', 'FOOD_COOKING'],
    languages: ['ENGLISH', 'BENGALI', 'HINDI'],
    shape: 'Professional with mixed reviews, including a three-star, and a disputed booking.',
  },
  {
    n: 6,
    firstName: 'Tendai',
    lastName: 'Moyo',
    username: 'tendaimoyo',
    cityId: 'MANCHESTER',
    countryOfOrigin: 'ZW',
    hasAvatar: true,
    bio: 'I answer questions. It is mostly what I do here. Six years in, happy to pass it on.',
    canHelpWith: 'NHS registration, School applications, Anything council-shaped',
    joinedDaysAgo: 520,
    dateOfBirth: '1990-04-08',
    heritageTag: 'SOUTHERN_AFRICAN',
    journeyStage: 'ESTABLISHED',
    interests: ['VOLUNTEERING', 'FOOD_COOKING', 'FAITH_COMMUNITY', 'PARENTING', 'BUSINESS', 'READING', 'ART_CULTURE'],
    languages: ['ENGLISH'],
    shape: 'Community regular. Many answers and offers, several guides, no listing.',
  },
  {
    n: 7,
    firstName: 'Ifeoma',
    lastName: 'Balogun',
    username: 'ifeomab',
    cityId: 'LONDON',
    countryOfOrigin: 'NG',
    hasAvatar: true,
    bio: 'I run a small African grocery in Peckham. Ask me what to do with plantain.',
    canHelpWith: 'Where to buy proper yam',
    joinedDaysAgo: 180,
    dateOfBirth: '1983-07-15',
    heritageTag: 'WEST_AFRICAN',
    journeyStage: 'ESTABLISHED',
    interests: ['FOOD_COOKING', 'BUSINESS', 'FASHION_BEAUTY', 'MUSIC', 'FAITH_COMMUNITY'],
    languages: ['ENGLISH', 'YORUBA', 'IGBO'],
    shape: 'Seller. Store, items, enquiries in flight.',
  },
  {
    n: 8,
    firstName: 'Marek',
    lastName: 'Kowalczyk',
    username: 'marekk',
    cityId: 'LONDON',
    countryOfOrigin: 'PL',
    hasAvatar: true,
    bio: 'Here since 2019. Looking for people to run with and practise my English on.',
    canHelpWith: 'Running routes, Polish paperwork',
    joinedDaysAgo: 150,
    dateOfBirth: '1996-02-27',
    heritageTag: 'EASTERN_EUROPEAN',
    journeyStage: 'ESTABLISHED',
    interests: ['SPORT_FITNESS', 'LANGUAGES', 'OUTDOORS', 'TRAVEL', 'FILM_TV', 'GAMING'],
    languages: ['ENGLISH', 'POLISH'],
    shape: 'Connect-heavy. Full profile, several conversations from it.',
  },
  {
    n: 9,
    firstName: 'Aiyana',
    lastName: null,
    username: 'aiyana',
    cityId: 'BIRMINGHAM',
    countryOfOrigin: 'OTHER',
    hasAvatar: false,
    bio: 'Quiet here, mostly reading.',
    canHelpWith: null,
    joinedDaysAgo: 95,
    dateOfBirth: '1999-12-05',
    heritageTag: 'OTHER',
    journeyStage: 'SETTLING_IN',
    interests: ['READING', 'FILM_TV', 'ART_CULTURE', 'GAMING'],
    languages: ['ENGLISH'],
    shape: 'Quiet member. Almost no activity. One-word name, so the nullable path renders.',
  },
  {
    n: 10,
    firstName: 'Grace',
    lastName: 'Wanjiru',
    username: 'gracew',
    cityId: 'LEEDS',
    countryOfOrigin: 'KE',
    hasAvatar: true,
    bio: 'Nurse, night shifts mostly. New to Leeds and trying to find my feet.',
    canHelpWith: 'NHS things, Night bus survival',
    joinedDaysAgo: 60,
    dateOfBirth: '1993-08-21',
    heritageTag: 'EAST_AFRICAN',
    journeyStage: 'SETTLING_IN',
    interests: ['OUTDOORS', 'PARENTING', 'MUSIC', 'TRAVEL', 'FAITH_COMMUNITY'],
    languages: ['ENGLISH', 'SWAHILI'],
    shape: 'Member in another city. Thin city, so Pulse shows its empty state there.',
  },
];

/** B.3: the Connect Pulse floor is 20 contributing members and the ten cannot clear it in any arrangement. */
export const CONNECT_EXTRA_COUNT = 18;

const EXTRA_FIRST = [
  'Nadia', 'Samuel', 'Priya', 'Kwame', 'Lucia', 'Omar', 'Thandiwe', 'Viktor', 'Mei',
  'Adaeze', 'Joseph', 'Fatima', 'Daniel', 'Zanele', 'Hassan', 'Rosa', 'Kofi', 'Ayesha',
];

const EXTRA_LAST = [
  'Haddad', 'Mensah', 'Iyer', 'Boateng', 'Fernandes', 'Siddiqui', 'Ndlovu', 'Petrov', 'Chen',
  'Eze', 'Mwangi', 'Toure', 'Osei', 'Dube', 'Bello', 'Alvarez', 'Asante', 'Khan',
];

const EXTRA_TYPES = [
  'FRIENDSHIP', 'NETWORKING', 'LANGUAGE_EXCHANGE', 'STUDY_PARTNER', 'FLATMATE', 'DATING',
];

const EXTRA_COUNTRIES = ['NG', 'GH', 'KE', 'IN', 'PK', 'BD', 'PH', 'ZW', 'ZA', 'JM', 'CN', 'PL', 'RO'];

export const connectExtras = () =>
  Array.from({ length: CONNECT_EXTRA_COUNT }, (_, index) => ({
    n: 100 + index,
    firstName: EXTRA_FIRST[index],
    lastName: EXTRA_LAST[index],
    username: `${EXTRA_FIRST[index].toLowerCase()}${EXTRA_LAST[index].toLowerCase()}`,
    // All in Manchester: the floor is evaluated per city, so spreading them would clear nothing anywhere (B.3).
    cityId: 'MANCHESTER',
    countryOfOrigin: EXTRA_COUNTRIES[index % EXTRA_COUNTRIES.length],
    typeCode: EXTRA_TYPES[index % EXTRA_TYPES.length],
    // Spread widely enough that the minAge and maxAge filters change the result.
    birthYear: 1980 + ((index * 3) % 24),
  }));
