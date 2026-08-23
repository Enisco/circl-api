/* Section 2 end-to-end check. Creates throwaway users, exercises listings,
   promotion, browse, reviews, bookings, briefs and disputes, then cleans up. */
require('dotenv').config({ path: './.env' });
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const BASE = 'http://localhost:4000/api/v1';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`); }
};

async function api(token, method, path, body, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function makeUser(tag, extra = {}) {
  const role = await prisma.role.findUnique({ where: { code: 'user' } });
  const user = await prisma.user.create({
    data: {
      firstName: 'E2E', lastName: tag, email: `e2e-${tag}-${Date.now()}@example.test`,
      username: `e2e_${tag}_${Date.now()}`, status: 'ACTIVE',
      userRole: { create: { roleId: role.id } },
      profile: { create: { cityId: 'MANCHESTER', bio: 'I have worked in immigration law for nine years and I help people navigate it.', ...extra } },
      trustChecks: { create: { check: 'EMAIL', status: 'VERIFIED', verifiedAt: new Date() } },
      sessions: { create: { userAgent: 'e2e', deviceType: 'cli', browserName: 'cli', operatingSystem: 'cli', ipAddress: '127.0.0.1', isActive: true, deviceFingerprint: `e2e-${tag}-${Date.now()}` } },
    },
    include: { sessions: true },
  });
  return { id: user.id, token: jwt.sign({ sub: user.id, sid: user.sessions[0].id }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) };
}

(async () => {
  const pro = await makeUser('pro', { countryOfOrigin: 'NG' });
  const client = await makeUser('client', { countryOfOrigin: 'GH' });
  const client2 = await makeUser('client2', { countryOfOrigin: 'KE' });
  const client3 = await makeUser('client3', { countryOfOrigin: 'GB' });
  const ids = [pro.id, client.id, client2.id, client3.id];

  console.log('\n── 2.7 Verification (D13: status only) ──────────────────────');

  let r = await api(pro.token, 'GET', '/verification/status');
  check('status → 200', r.status === 200, r.body?.error);
  const checks = r.body?.data?.checks ?? [];
  check('EMAIL verified at signup', checks.find(c => c.check === 'EMAIL')?.status === 'VERIFIED', checks);
  check('IDENTITY / RTW / CREDENTIAL all NOT_STARTED',
    ['IDENTITY', 'RIGHT_TO_WORK', 'CREDENTIAL'].every(k => checks.find(c => c.check === k)?.status === 'NOT_STARTED'), checks);
  check('no case open', r.body?.data?.case === null);

  console.log('\n── 2.1.2 Registration prefill ───────────────────────────────');

  r = await api(pro.token, 'GET', '/professionals/registration/prefill');
  check('prefill → 200', r.status === 200, r.body?.error);
  check('listing null before registering', r.body?.data?.listing === null);
  check('fullName prefilled', r.body?.data?.prefill?.fullName === 'E2E pro', r.body?.data?.prefill);
  check('city prefilled from profile', r.body?.data?.prefill?.cityId === 'MANCHESTER');
  check('about prefilled from bio, labelled', r.body?.data?.prefill?.aboutSource === 'PROFILE_BIO' && !!r.body?.data?.prefill?.about);
  check('steps is [LISTING REQUIRED] only (D13)',
    r.body?.data?.steps?.length === 1 && r.body.data.steps[0].key === 'LISTING' && r.body.data.steps[0].status === 'REQUIRED', r.body?.data?.steps);

  console.log('\n── 2.1.3 Offer promotion ────────────────────────────────────');

  r = await api(pro.token, 'POST', '/community/offers', {
    title: 'Help with UK visa paperwork',
    description: 'I have worked in immigration law for nine years and can walk you through the forms.',
    categoryCode: 'VISA_DOCS', cityId: 'MANCHESTER', priceFrom: 3000, priceBasis: 'PER_JOB',
  });
  const offerId = r.body?.data?.id;
  check('offer created', r.status === 201, r.body?.error);

  r = await api(pro.token, 'GET', '/professionals/registration/prefill');
  const promotable = r.body?.data?.promotableOffers ?? [];
  check('offer appears as promotable', promotable.some(o => o.id === offerId), promotable.length);
  check('D8 bridge suggests a profession from the community category',
    promotable.find(o => o.id === offerId)?.suggestedProfessionCodes?.includes('IMMIGRATION'),
    promotable.find(o => o.id === offerId)?.suggestedProfessionCodes);

  r = await api(pro.token, 'POST', `/professionals/listings/from-offer/${offerId}`, {});
  check('promote without a professionCode works (it is suggested)', r.status === 201, r.body?.error);
  const listingId = r.body?.data?.listing?.id;
  check('price copied across', r.body?.data?.listing?.priceFrom?.amount === 3000, r.body?.data?.listing?.priceFrom);
  check('city copied across', r.body?.data?.listing?.city?.id === 'MANCHESTER');
  check('IMMIGRATION is flagged regulated (D13 mitigation)', r.body?.data?.listing?.isRegulated === true, r.body?.data?.listing?.isRegulated);

  r = await api(pro.token, 'POST', `/professionals/listings/from-offer/${offerId}`, {});
  check('second promote → 409 with the existing listing in data',
    r.status === 409 && r.body?.error?.code === 'OFFER_ALREADY_PROMOTED' && r.body?.data?.listing?.id === listingId, r.body?.error);

  r = await api(client.token, 'GET', '/community/offers?cityId=MANCHESTER');
  check('offer stays live while the listing is unverified', r.body?.data?.some(o => o.id === offerId), r.body?.data?.length);

  r = await api(pro.token, 'POST', '/professionals/listings', {
    categoryCodes: ['LEGAL'], professionTitle: 'Immigration Lawyer', experienceLevel: 'EXPERT',
    about: 'I specialise in UK immigration law and have done for nine years now.', consentAccepted: true,
  });
  check('second listing → 409 with existing in data',
    r.status === 409 && r.body?.error?.code === 'LISTING_ALREADY_EXISTS' && r.body?.data?.listing?.id === listingId, r.body?.error);

  r = await api(pro.token, 'POST', '/professionals/listings', {
    categoryCodes: ['LEGAL'], professionTitle: 'X', experienceLevel: 'EXPERT',
    about: 'Too short', consentAccepted: false,
  });
  check('consentAccepted false → 400 naming the field',
    r.status === 400 && r.body?.error?.details?.some(d => d.field === 'consentAccepted'), r.body?.error?.details);

  console.log('\n── 2.6 Listing & services ───────────────────────────────────');

  r = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}`, {
    professionTitle: 'Immigration Lawyer', experienceLevel: 'EXPERT', yearsExperience: 9,
    about: 'I specialise in UK immigration law and have done for nine years now.',
  });
  check('patch listing → 200', r.status === 200, r.body?.error);

  r = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'Initial Consultation', description: '1-hour session covering your case and next steps',
    price: 6500, priceBasis: 'PER_HOUR',
  });
  check('add service → 201 with an id', r.status === 201 && !!r.body?.data?.id, r.body?.error);
  const serviceId = r.body?.data?.id;
  check('price is a money object', r.body?.data?.price?.amount === 6500 && r.body?.data?.price?.currency === 'GBP');

  r = await api(client.token, 'PATCH', `/professionals/listings/${listingId}`, { professionTitle: 'Hijacked' });
  check('non-owner patch → 403', r.status === 403, r.body?.error);

  r = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/availability`, { isAcceptingWork: false });
  check('availability off → 200', r.body?.data?.isAcceptingWork === false, r.body?.error);

  r = await api(client.token, 'POST', '/bookings', { listingId, serviceId });
  check('booking a closed listing → 422 NOT_ACCEPTING_WORK', r.status === 422 && r.body?.error?.code === 'NOT_ACCEPTING_WORK', r.body?.error);

  await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/availability`, { isAcceptingWork: true });

  console.log('\n── 2.3 / 2.4 Browse & profile ───────────────────────────────');

  r = await api(client.token, 'GET', '/professionals?cityId=MANCHESTER');
  check('browse → 200', r.status === 200, r.body?.error);
  check('listing found, typed PROFESSIONAL', r.body?.data?.some(p => p.id === listingId && p.type === 'PROFESSIONAL'), r.body?.data?.map(p => p.type));
  check('meta.totalCount is the filtered count', typeof r.body?.meta?.totalCount === 'number');
  check('distanceMiles null without coordinates (D25)', r.body?.data?.[0]?.distanceMiles === null, r.body?.data?.[0]?.distanceMiles);

  r = await api(client.token, 'GET', '/professionals?listingType=BOTH&cityId=MANCHESTER');
  const both = new Set(r.body?.data?.map(p => p.type));
  check('listingType=BOTH returns both discriminated types (D14)', both.has('PROFESSIONAL') && both.has('COMMUNITY_OFFER'), [...both]);

  r = await api(client.token, 'GET', '/professionals?cityId=LONDON&category=IMMIGRATION');
  check('empty result carries nearbyCityMatches', r.body?.meta?.totalCount === 0 && Array.isArray(r.body?.meta?.nearbyCityMatches), r.body?.meta);
  check('nearbyCityMatches names a real alternative', r.body?.meta?.nearbyCityMatches?.[0]?.cityId === 'MANCHESTER', r.body?.meta?.nearbyCityMatches);

  r = await api(client.token, 'GET', `/professionals/${listingId}`);
  check('profile by LISTING id → 200', r.status === 200, r.body?.error);
  r = await api(client.token, 'GET', `/professionals/${pro.id}`);
  check('profile by USER id → same listing (D9)', r.body?.data?.id === listingId, r.body?.data?.id);
  check('services carry ids', r.body?.data?.services?.[0]?.id === serviceId);
  check('trust shows EMAIL with provenance', r.body?.data?.trust?.checks?.[0]?.check === 'EMAIL' && !!r.body?.data?.trust?.checks?.[0]?.checkedBy, r.body?.data?.trust);
  check('canLeavePriorWorkReview true before any booking', r.body?.data?.viewer?.canLeavePriorWorkReview === true);
  check('communityProfileUrl points at the same person', r.body?.data?.communityProfileUrl === `/profile/community/${pro.id}`);

  console.log('\n── 2.9 Bookings ─────────────────────────────────────────────');

  r = await api(pro.token, 'POST', '/bookings', { listingId, serviceId });
  check('cannot book yourself → 422', r.status === 422 && r.body?.error?.code === 'CANNOT_BOOK_YOURSELF', r.body?.error);

  r = await api(client.token, 'POST', '/bookings', { listingId, serviceId, agreedAmount: 6500 });
  check('create booking → 201', r.status === 201, r.body?.error);
  const bookingId = r.body?.data?.id;
  check('server copied the service name', r.body?.data?.serviceName === 'Initial Consultation', r.body?.data?.serviceName);
  check('conversationId returned, never guessed', typeof r.body?.data?.conversationId === 'string', r.body?.data?.conversationId);
  check('timeline is data with all stages', r.body?.data?.timeline?.length >= 6 && r.body.data.timeline[0].stage === 'REQUESTED', r.body?.data?.timeline?.map(t => t.stage));
  check('REQUESTED reached, DONE not', r.body?.data?.timeline?.[0]?.reachedAt !== null && r.body?.data?.timeline?.find(t => t.stage === 'DONE')?.reachedAt === null);
  check('client viewer: no accept, can cancel', r.body?.data?.viewer?.canAccept === false && r.body?.data?.viewer?.canCancel === true, r.body?.data?.viewer);

  r = await api(pro.token, 'GET', `/bookings/${bookingId}`);
  check('professional viewer: can accept', r.body?.data?.viewer?.canAccept === true && r.body?.data?.viewer?.role === 'PROFESSIONAL', r.body?.data?.viewer);

  r = await api(client.token, 'POST', `/bookings/${bookingId}/accept`);
  check('client cannot accept → 403', r.status === 403, r.body?.error);

  r = await api(client.token, 'POST', `/bookings/${bookingId}/complete`);
  check('complete from wrong state → 409 with current state', r.status === 409 && r.body?.error?.code === 'INVALID_TRANSITION' && r.body?.data?.state === 'PENDING_ACCEPTANCE', r.body);

  r = await api(pro.token, 'POST', `/bookings/${bookingId}/accept`);
  check('accept → ACCEPTED', r.body?.data?.state === 'ACCEPTED', r.body?.error);
  r = await api(pro.token, 'POST', `/bookings/${bookingId}/start`);
  check('start → IN_PROGRESS', r.body?.data?.state === 'IN_PROGRESS');
  r = await api(pro.token, 'POST', `/bookings/${bookingId}/deliver`, { note: 'Sent you the case notes.' });
  check('deliver → DELIVERED', r.body?.data?.state === 'DELIVERED');
  check('autoCompleteAt stamped 7 days out', !!r.body?.data?.autoCompleteAt &&
    Math.round((new Date(r.body.data.autoCompleteAt) - Date.now()) / 86400000) === 7, r.body?.data?.autoCompleteAt);

  r = await api(client.token, 'POST', `/bookings/${bookingId}/request-changes`, { message: 'Could you also cover the appeal route?' });
  check('request changes → CHANGES_REQUESTED', r.body?.data?.state === 'CHANGES_REQUESTED', r.body?.error);
  r = await api(pro.token, 'POST', `/bookings/${bookingId}/deliver`, {});
  check('re-deliver from CHANGES_REQUESTED → DELIVERED', r.body?.data?.state === 'DELIVERED', r.body?.error);

  r = await api(client.token, 'POST', `/bookings/${bookingId}/complete`);
  check('complete → COMPLETED', r.body?.data?.state === 'COMPLETED', r.body?.error);
  check('canReview true once complete', r.body?.data?.viewer?.canReview === true, r.body?.data?.viewer);
  check('DONE stage now stamped', r.body?.data?.timeline?.find(t => t.stage === 'DONE')?.reachedAt !== null);

  r = await api(client.token, 'GET', '/bookings?role=CLIENT');
  check('my bookings → needsYourAction present', typeof r.body?.data?.[0]?.needsYourAction === 'boolean', r.body?.data?.[0]);
  r = await api(client.token, 'GET', '/bookings?role=PROFESSIONAL');
  check('role=PROFESSIONAL without a listing → 403', r.status === 403 && r.body?.error?.code === 'NOT_A_PROFESSIONAL', r.body?.error);

  console.log('\n── 2.5 Reviews & reputation ─────────────────────────────────');

  r = await api(client2.token, 'POST', '/reviews', {
    subjectUserId: pro.id, rating: 5, comment: 'He helped me get my spouse visa after two refusals.',
    context: 'BOOKING', sourceId: bookingId,
  });
  check('review a booking you were not in → 422', r.status === 422 && r.body?.error?.code === 'REVIEW_NOT_ELIGIBLE', r.body?.error);

  r = await api(client.token, 'POST', '/reviews', {
    subjectUserId: pro.id, rating: 5, comment: 'He helped me get my spouse visa after two refusals. Patient and clear.',
    context: 'BOOKING', sourceId: bookingId, tags: ['VISA_ADVICE'],
  });
  check('review a completed booking → 201', r.status === 201, r.body?.error);
  const reviewId = r.body?.data?.id;
  check('countsToAverage true for BOOKING', r.body?.data?.countsToAverage === true);
  check('tag rendered as a label', r.body?.data?.tags?.[0] === 'Visa advice', r.body?.data?.tags);

  r = await api(client.token, 'POST', '/reviews', {
    subjectUserId: pro.id, rating: 4, comment: 'Trying to review the same booking twice should fail.',
    context: 'BOOKING', sourceId: bookingId,
  });
  check('duplicate → 409 with the existing review in data',
    r.status === 409 && r.body?.error?.code === 'REVIEW_ALREADY_LEFT' && r.body?.data?.review?.id === reviewId, r.body?.error);

  r = await api(client.token, 'POST', '/reviews', {
    subjectUserId: pro.id, rating: 5, comment: 'I also worked with him before Circl, years ago now.',
    context: 'PRIOR_WORK',
  });
  check('prior-work blocked when a booking exists → 422', r.status === 422 && r.body?.error?.code === 'REVIEW_NOT_ELIGIBLE', r.body?.error);

  r = await api(client2.token, 'POST', '/reviews', {
    subjectUserId: pro.id, rating: 5, comment: 'I worked with him before Circl and he was excellent throughout.',
    context: 'PRIOR_WORK',
  });
  check('prior-work allowed with no booking → 201', r.status === 201, r.body?.error);
  check('countsToAverage FALSE for prior work', r.body?.data?.countsToAverage === false, r.body?.data?.countsToAverage);

  r = await api(client2.token, 'POST', '/reviews', {
    subjectUserId: pro.id, rating: 4, comment: 'A second prior-work review from the same person, ever.',
    context: 'PRIOR_WORK',
  });
  check('one prior-work per pair, ever → 409', r.status === 409 && r.body?.error?.code === 'REVIEW_ALREADY_LEFT', r.body?.error);

  r = await api(pro.token, 'POST', `/reviews/${reviewId}/reply`, { comment: 'Thank you, glad it worked out.' });
  check('subject replies once → 201', r.status === 201, r.body?.error);
  r = await api(pro.token, 'POST', `/reviews/${reviewId}/reply`, { comment: 'Twice?' });
  check('second reply → 409', r.status === 409, r.body?.error);

  r = await api(client.token, 'GET', `/reviews/${pro.id}`);
  check('reviews list → 200', r.status === 200, r.body?.error);
  check('average excludes prior work', r.body?.data?.summary?.average === 5 && r.body?.data?.summary?.countedTotal === 1, r.body?.data?.summary);
  check('excludedTotal counts the prior-work entry', r.body?.data?.summary?.excludedTotal === 1, r.body?.data?.summary);
  check('byContext breakdown present', r.body?.data?.summary?.byContext?.BOOKING === 1 && r.body?.data?.summary?.byContext?.PRIOR_WORK === 1, r.body?.data?.summary?.byContext);
  check('prior-work sorts last', r.body?.data?.reviews?.at(-1)?.context === 'PRIOR_WORK', r.body?.data?.reviews?.map(x => x.context));
  check('subjectReply surfaced on the review', !!r.body?.data?.reviews?.find(x => x.id === reviewId)?.subjectReply);

  r = await api(client.token, 'GET', `/reviews/${pro.id}?context=BOOKING`);
  check('summary is over ALL reviews even when filtered', r.body?.data?.summary?.excludedTotal === 1 && r.body?.data?.reviews?.length === 1, r.body?.data?.summary);

  console.log('\n── D11 Immigrant-friendly ───────────────────────────────────');

  const summaryBefore = await prisma.reputationSummary.findUnique({ where: { userId: pro.id } });
  check('not immigrant-friendly on 1 counted review', summaryBefore?.isImmigrantFriendly === false, summaryBefore?.immigrantReviewCount);

  // Two more completed bookings from non-UK reviewers takes it to 3.
  for (const [i, buyer] of [client2, client3].entries()) {
    const b = await api(buyer.token, 'POST', '/bookings', { listingId, serviceId });
    const bid = b.body?.data?.id;
    await api(pro.token, 'POST', `/bookings/${bid}/accept`);
    await api(pro.token, 'POST', `/bookings/${bid}/start`);
    await api(pro.token, 'POST', `/bookings/${bid}/deliver`, {});
    await api(buyer.token, 'POST', `/bookings/${bid}/complete`);
    await api(buyer.token, 'POST', '/reviews', {
      subjectUserId: pro.id, rating: 5, comment: `Excellent work on my case, would recommend to anyone. Round ${i}.`,
      context: 'BOOKING', sourceId: bid,
    });
  }

  const summaryAfter = await prisma.reputationSummary.findUnique({ where: { userId: pro.id } });
  check('3 counted reviews', summaryAfter?.countedTotal === 3, summaryAfter?.countedTotal);
  check('only the 2 non-UK reviewers count toward D11', summaryAfter?.immigrantReviewCount === 2, summaryAfter?.immigrantReviewCount);
  check('under-counts rather than over-counts: not yet immigrant-friendly', summaryAfter?.isImmigrantFriendly === false, summaryAfter);

  // A third non-UK reviewer tips it over.
  const client4 = await makeUser('client4', { countryOfOrigin: 'ZW' });
  ids.push(client4.id);
  {
    const b = await api(client4.token, 'POST', '/bookings', { listingId, serviceId });
    const bid = b.body?.data?.id;
    await api(pro.token, 'POST', `/bookings/${bid}/accept`);
    await api(pro.token, 'POST', `/bookings/${bid}/start`);
    await api(pro.token, 'POST', `/bookings/${bid}/deliver`, {});
    await api(client4.token, 'POST', `/bookings/${bid}/complete`);
    await api(client4.token, 'POST', '/reviews', {
      subjectUserId: pro.id, rating: 5, comment: 'Third non-UK reviewer, which is what tips the rule over.',
      context: 'BOOKING', sourceId: bid,
    });
  }
  const summaryFinal = await prisma.reputationSummary.findUnique({ where: { userId: pro.id } });
  check('3 non-UK reviewers averaging 4+ → immigrant-friendly', summaryFinal?.isImmigrantFriendly === true, summaryFinal);

  r = await api(client.token, 'GET', '/professionals?immigrantFriendly=true&cityId=MANCHESTER');
  check('immigrantFriendly filter finds the listing', r.body?.data?.some(p => p.id === listingId), r.body?.data?.length);

  console.log('\n── 2.8 Smart Match ──────────────────────────────────────────');

  r = await api(client.token, 'POST', '/professionals/briefs', {
    categoryCode: 'IMMIGRATION',
    description: 'I need help with a spouse visa application that was refused once already.',
    urgency: 'ASAP', budget: 8000,
  });
  check('create brief → 201', r.status === 201, r.body?.error);
  const briefId = r.body?.data?.id;

  r = await api(client.token, 'GET', `/professionals/briefs/${briefId}/matches`);
  check('matches → 200', r.status === 200, r.body?.error);
  check('at most 3 matches', (r.body?.data?.matches?.length ?? 0) <= 3, r.body?.data?.shortlistSize);
  const m = r.body?.data?.matches?.[0];
  check('four scores, each 0..1 with a qualifier',
    m && ['rating', 'distance', 'price', 'response'].every(k => m.scores[k].value >= 0 && m.scores[k].value <= 1 && ['EXCELLENT', 'GOOD', 'FAIR'].includes(m.scores[k].qualifier)), m?.scores);
  check('rationale is a sentence or honestly null', m && (m.rationale === null || /\.$/.test(m.rationale)), m?.rationale);
  console.log(`    (rationale: ${m?.rationale ?? 'null'})`);

  r = await api(client.token, 'POST', `/professionals/briefs/${briefId}/choose`, { listingId });
  check('choose creates the booking directly', r.status === 201 && !!r.body?.data?.id, r.body?.error);
  check('the brief carried into the booking', r.body?.data?.brief?.description?.includes('spouse visa'), r.body?.data?.brief);
  const briefBookingId = r.body?.data?.id;

  r = await api(client.token, 'POST', '/professionals/briefs', {
    categoryCode: 'PHOTOGRAPHY_VIDEO', description: 'Nobody is listed for this yet.',
  });
  const emptyBriefId = r.body?.data?.id;
  r = await api(client.token, 'GET', `/professionals/briefs/${emptyBriefId}/matches`);
  check('zero matches → fallback MANUAL_PLACEMENT, not an empty screen',
    r.body?.data?.matches?.length === 0 && r.body?.data?.fallback === 'MANUAL_PLACEMENT', r.body?.data);

  r = await api(client.token, 'POST', `/professionals/briefs/${emptyBriefId}/manual-placement`);
  check('manual placement opens a Circl-team thread', r.status === 201 && !!r.body?.data?.conversationId, r.body?.error);

  console.log('\n── 2.10 Disputes ────────────────────────────────────────────');

  r = await api(client.token, 'POST', `/bookings/${briefBookingId}/disputes`, {
    reasonCode: 'COMMUNICATION', description: 'I have not heard anything back for over a week now and I am worried.',
  });
  check('raise dispute → 201', r.status === 201, r.body?.error);
  check('returns conversationId and expectedResolutionAt', !!r.body?.data?.conversationId && !!r.body?.data?.expectedResolutionAt, r.body?.data);
  const disputeConversationId = r.body?.data?.conversationId;
  const disputeId = r.body?.data?.id;

  const bookingAfter = await prisma.booking.findUnique({ where: { id: briefBookingId } });
  check('booking moved to DISPUTED', bookingAfter?.state === 'DISPUTED', bookingAfter?.state);
  check('dispute reuses the booking thread, not a new one', disputeConversationId === bookingAfter?.conversationId, { disputeConversationId, booking: bookingAfter?.conversationId });

  r = await api(pro.token, 'POST', `/bookings/${briefBookingId}/disputes`, {
    reasonCode: 'OTHER', description: 'A second dispute on the same booking should return the open one.',
  });
  check('second dispute → 409 with the open one', r.status === 409 && r.body?.error?.code === 'DISPUTE_ALREADY_OPEN', r.body?.error);
  check('the open dispute is handed back', r.body?.data?.dispute?.id === disputeId, r.body?.data);

  console.log('\n── 2.11 Dashboard ───────────────────────────────────────────');

  r = await api(pro.token, 'GET', '/professionals/me/dashboard');
  check('dashboard → 200', r.status === 200, r.body?.error);
  check('completed count reflects finished jobs', r.body?.data?.completed?.count === 4, r.body?.data?.completed);
  check('agreedTotal is a money object', typeof r.body?.data?.completed?.agreedTotal?.amount === 'number');
  check('no payout, balance or fee anywhere in the payload',
    !JSON.stringify(r.body?.data ?? {}).match(/payout|balance|stripe|fee/i), Object.keys(r.body?.data ?? {}));
  check('conversion rate present', typeof r.body?.data?.conversion?.rate === 'number', r.body?.data?.conversion);

  r = await api(pro.token, 'GET', '/professionals/home');
  check('home → 200', r.status === 200, r.body?.error);
  check('myListing present for a professional', r.body?.data?.myListing?.id === listingId, r.body?.data?.myListing);
  check('activeBookings capped at 3', (r.body?.data?.activeBookings?.length ?? 0) <= 3, r.body?.data?.activeBookings?.length);
  r = await api(client.token, 'GET', '/professionals/home');
  check('myListing null for a non-professional', r.body?.data?.myListing === null);
  check('categories carry real counts', r.body?.data?.categories?.some(c => c.professionalCount > 0), r.body?.data?.categories?.slice(0, 3));

  r = await api(client.token, 'GET', '/professionals/me');
  check('GET /professionals/me without a listing → 404', r.status === 404 && r.body?.error?.code === 'LISTING_NOT_FOUND', r.body?.error);

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await prisma.moderationQueueItem.deleteMany({ where: { subjectUserId: { in: ids } } });
  await prisma.activityEvent.deleteMany({ where: { userId: { in: ids } } });
  await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: ids } } });
  await prisma.conversation.deleteMany({ where: { participants: { some: { userId: { in: ids } } } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  console.log(`  removed ${ids.length} test users and their content`);

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
  await prisma.$disconnect(); await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.error(e); await prisma.$disconnect().catch(()=>{}); await pool.end().catch(()=>{}); process.exit(1); });
