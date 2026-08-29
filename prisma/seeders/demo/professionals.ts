import { JobState } from '@prisma/client';
import { DemoSeedContext, HOME_CITY, userId } from './seed-demo';
import { daysAgo, hoursAgo, seedId } from './ids';

/** Sections 2.1 to 2.9 (B.4). */
const LISTINGS = [
  {
    label: 'blessing',
    user: 3,
    professionTitle: 'Immigration Adviser',
    categories: ['IMMIGRATION', 'LEGAL'],
    experienceLevel: 'EXPERT',
    yearsExperience: 9,
    about:
      'I have spent nine years on UK immigration casework, most of it explaining the same three ' +
      'forms to people who were told something different by three other people. Student and ' +
      'skilled worker routes, dependants, and the paperwork nobody warns you about.',
    priceFrom: 6500,
    priceBasis: 'PER_HOUR',
    deliveryMode: 'BOTH',
    isAcceptingWork: true,
    freeConsultation: true,
    jobsCompleted: 34,
    medianResponseMinutes: 95,
    profileViews: 612,
    daysAgo: 380,
    services: [
      ['consult', 'Initial consultation', 'One hour on your case and what the next step is', 6500, 'PER_HOUR'],
      ['student', 'Student visa application review', 'I read the whole application before you submit it', 18000, 'PER_JOB'],
      ['dependant', 'Dependant application', 'Start to finish, including the document list', 32000, 'PER_JOB'],
    ],
  },
  {
    label: 'chidi',
    user: 4,
    professionTitle: 'Handyman',
    categories: ['TRADES_REPAIRS'],
    experienceLevel: 'MID_LEVEL',
    yearsExperience: 3,
    about:
      'Flat-pack furniture, shelves, radiators, doors that will not close properly. I am new on ' +
      'here but not new to the work.',
    priceFrom: 3000,
    priceBasis: 'PER_HOUR',
    deliveryMode: 'IN_PERSON',
    // Availability off, so the NOT_ACCEPTING_WORK refusal has somewhere to happen (B.5, member 4).
    isAcceptingWork: false,
    freeConsultation: false,
    jobsCompleted: 0,
    medianResponseMinutes: null,
    profileViews: 18,
    daysAgo: 18,
    services: [['hour', 'Hourly rate', 'Minimum one hour, tools included', 3000, 'PER_HOUR']],
  },
  {
    label: 'farida',
    user: 5,
    professionTitle: 'Translator and Interpreter',
    categories: ['TRANSLATION'],
    experienceLevel: 'EXPERT',
    yearsExperience: 12,
    about:
      'Bengali, Hindi and English. Council letters, tenancy agreements, NHS appointments. I will ' +
      'tell you what a letter actually means rather than translating it word for word.',
    priceFrom: 4000,
    priceBasis: 'PER_HOUR',
    deliveryMode: 'BOTH',
    isAcceptingWork: true,
    freeConsultation: false,
    jobsCompleted: 21,
    medianResponseMinutes: 240,
    profileViews: 287,
    daysAgo: 290,
    services: [
      ['letter', 'Letter or document translation', 'Per document, turnaround two days', 4000, 'PER_JOB'],
      ['appointment', 'Interpreting at an appointment', 'I come with you and speak for you', 5500, 'PER_HOUR'],
    ],
  },
];

/** Every state in 2.9.1, each with its timeline stamps. */
const BOOKINGS: Array<{
  label: string;
  listing: string;
  client: number;
  service: string;
  state: JobState;
  amount: number;
  hoursAgo: number;
}> = [
  // Member 1 is the demo account, so it holds the one that needs their action.
  { label: 'b1', listing: 'blessing', client: 1, service: 'consult', state: JobState.PENDING_ACCEPTANCE, amount: 6500, hoursAgo: 6 },
  { label: 'b2', listing: 'blessing', client: 2, service: 'student', state: JobState.ACCEPTED, amount: 18000, hoursAgo: 40 },
  { label: 'b3', listing: 'blessing', client: 6, service: 'consult', state: JobState.IN_PROGRESS, amount: 6500, hoursAgo: 90 },
  { label: 'b4', listing: 'blessing', client: 10, service: 'dependant', state: JobState.DELIVERED, amount: 32000, hoursAgo: 150 },
  { label: 'b5', listing: 'farida', client: 1, service: 'letter', state: JobState.CHANGES_REQUESTED, amount: 4000, hoursAgo: 200 },
  // The one waiting on the demo account: delivered, and the client confirms (B.5).
  { label: 'b10', listing: 'farida', client: 1, service: 'appointment', state: JobState.DELIVERED, amount: 5500, hoursAgo: 30 },
  { label: 'b6', listing: 'blessing', client: 8, service: 'consult', state: JobState.COMPLETED, amount: 6500, hoursAgo: 400 },
  { label: 'b7', listing: 'farida', client: 6, service: 'appointment', state: JobState.COMPLETED, amount: 5500, hoursAgo: 600 },
  { label: 'b8', listing: 'blessing', client: 9, service: 'consult', state: JobState.CANCELLED, amount: 6500, hoursAgo: 300 },
  { label: 'b9', listing: 'farida', client: 10, service: 'letter', state: JobState.DISPUTED, amount: 4000, hoursAgo: 260 },
];

/** A range of ratings, not all five (B.4). */
const REVIEWS: Array<{
  label: string;
  subject: number;
  reviewer: number;
  rating: number;
  comment: string;
  context: 'BOOKING' | 'COMMUNITY';
  booking?: string;
  daysAgo: number;
  tags?: string[];
}> = [
  { label: 'r1', subject: 3, reviewer: 8, rating: 5, comment: 'Answered on a Sunday and did not make me feel stupid for asking. Application went through first time.', context: 'BOOKING', booking: 'b6', daysAgo: 15, tags: ['CLEAR_EXPLANATION', 'WENT_ABOVE_AND_BEYOND'] },
  { label: 'r2', subject: 3, reviewer: 6, rating: 5, comment: 'Knows the rules properly rather than repeating what is on the website.', context: 'BOOKING', daysAgo: 40 },
  { label: 'r3', subject: 3, reviewer: 2, rating: 4, comment: 'Good advice, though it took a couple of days to get the first reply.', context: 'BOOKING', daysAgo: 8 },
  { label: 'r4', subject: 5, reviewer: 6, rating: 5, comment: 'Came to the appointment with me and it changed how the whole thing went.', context: 'BOOKING', booking: 'b7', daysAgo: 22, tags: ['ON_TIME'] },
  { label: 'r5', subject: 5, reviewer: 10, rating: 3, comment: 'The translation was accurate but it came back three days late and I had to chase twice.', context: 'BOOKING', daysAgo: 10 },
  { label: 'r6', subject: 6, reviewer: 1, rating: 5, comment: 'Answered my bank question in ten minutes and it was the right answer.', context: 'COMMUNITY', daysAgo: 5, tags: ['QUICK_TO_REPLY'] },
  { label: 'r7', subject: 1, reviewer: 9, rating: 4, comment: 'Gave me a lift to the airport at 4am and would not take extra for it.', context: 'COMMUNITY', daysAgo: 30 },
];

/** States a booking has stopped moving in, and states it has been delivered in. */
const TERMINAL_STATES: JobState[] = [JobState.COMPLETED, JobState.CANCELLED];
const DELIVERED_STATES: JobState[] = [
  JobState.DELIVERED,
  JobState.COMPLETED,
  JobState.CHANGES_REQUESTED,
];

export const seedProfessionals = async (ctx: DemoSeedContext) => {
  const { prisma } = ctx;

  for (const listing of LISTINGS) {
    const id = seedId(`listing:${listing.label}`);
    const createdAt = daysAgo(listing.daysAgo);

    const data = {
      userId: userId(listing.user),
      professionTitle: listing.professionTitle,
      experienceLevel: listing.experienceLevel as never,
      yearsExperience: listing.yearsExperience,
      about: listing.about,
      cityId: HOME_CITY,
      deliveryMode: listing.deliveryMode as never,
      priceFrom: listing.priceFrom,
      priceBasis: listing.priceBasis as never,
      isAcceptingWork: listing.isAcceptingWork,
      freeConsultation: listing.freeConsultation,
      // D13: every listing goes live unverified, and none of the other five statuses are seeded because only 2.7 can produce them.
      verificationStatus: 'UNVERIFIED' as const,
      consentAccepted: true,
      consentAcceptedAt: createdAt,
      consentVersion: '1.0',
      jobsCompleted: listing.jobsCompleted,
      medianResponseMinutes: listing.medianResponseMinutes,
      profileViews: listing.profileViews,
      createdAt,
    };

    await prisma.professionalListing.upsert({
      where: { id },
      update: data,
      create: { id, ...data },
    });

    for (const [index, code] of listing.categories.entries()) {
      await prisma.professionalListingCategory.upsert({
        where: { listingId_code: { listingId: id, code } },
        update: { isPrimary: index === 0 },
        create: { listingId: id, code, isPrimary: index === 0 },
      });
    }

    for (const [index, service] of listing.services.entries()) {
      const [slug, name, description, price, basis] = service as [string, string, string, number, string];
      const serviceId = seedId(`service:${listing.label}:${slug}`);
      const serviceData = {
        listingId: id,
        name,
        description,
        price,
        priceBasis: basis as never,
        isActive: true,
        sort: index,
      };

      await prisma.professionalService.upsert({
        where: { id: serviceId },
        update: serviceData,
        create: { id: serviceId, ...serviceData },
      });
    }
  }

  for (const booking of BOOKINGS) {
    const id = seedId(`booking:${booking.label}`);
    const listing = LISTINGS.find(row => row.label === booking.listing)!;
    const service = listing.services.find(row => row[0] === booking.service)!;
    const createdAt = hoursAgo(booking.hoursAgo);
    const terminal = TERMINAL_STATES.includes(booking.state);

    const data = {
      clientId: userId(booking.client),
      professionalId: userId(listing.user),
      listingId: seedId(`listing:${listing.label}`),
      serviceId: seedId(`service:${listing.label}:${booking.service}`),
      serviceName: service[1] as string,
      serviceDescription: service[2] as string,
      quotedAmount: booking.amount,
      agreedAmount: booking.amount,
      state: booking.state,
      mode: 'ONLINE' as never,
      // Only the stamps this state has actually reached.
      deliveredAt: DELIVERED_STATES.includes(booking.state)
        ? hoursAgo(booking.hoursAgo - 20)
        : null,
      completedAt: booking.state === JobState.COMPLETED ? hoursAgo(booking.hoursAgo - 30) : null,
      cancelledAt: booking.state === JobState.CANCELLED ? hoursAgo(booking.hoursAgo - 10) : null,
      cancelReason:
        booking.state === JobState.CANCELLED ? 'Sorted it another way, sorry for the trouble.' : null,
      firstClientMessageAt: createdAt,
      firstProReplyAt:
        booking.state === JobState.PENDING_ACCEPTANCE ? null : hoursAgo(booking.hoursAgo - 2),
      createdAt,
      updatedAt: terminal ? hoursAgo(booking.hoursAgo - 30) : createdAt,
    };

    await prisma.booking.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  for (const review of REVIEWS) {
    const id = seedId(`review:${review.label}`);
    const reviewerProfile = await prisma.userProfile.findUnique({
      where: { userId: userId(review.reviewer) },
      select: { countryOfOrigin: true },
    });

    const data = {
      subjectUserId: userId(review.subject),
      reviewerId: userId(review.reviewer),
      rating: review.rating,
      comment: review.comment,
      context: review.context as never,
      bookingId: review.booking ? seedId(`booking:${review.booking}`) : null,
      countsToAverage: true,
      tags: (review.tags ?? []) as never,
      // Denormalised at write time exactly as the service does, so the immigrant-friendly filter is an index scan rather than a join (2.5).
      reviewerCountryOfOrigin: reviewerProfile?.countryOfOrigin ?? null,
      editableUntil: daysAgo(review.daysAgo - 1),
      createdAt: daysAgo(review.daysAgo),
    };

    await prisma.review.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  return { listings: LISTINGS.length, bookings: BOOKINGS.length, reviews: REVIEWS.length };
};

export { BOOKINGS, LISTINGS, REVIEWS };
