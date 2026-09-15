/* Section 2 end-to-end check. Creates throwaway users, exercises listings,
   promotion, browse, reviews, bookings, briefs and disputes, then cleans up. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');



(async () => {
  await sweep('pre-run');

  // A bio, so the registration prefill has something to prefill `about` from.
  const pro = await makeUser('pro', {
    countryOfOrigin: 'NG',
    bio: 'I have worked in immigration law for nine years and I help people navigate it.',
  });
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

  // The three values, and the one that is easy to assume. A filter row with neither option chosen
  // has to send BOTH: leaving the parameter off is the one filter on this endpoint that applies
  // itself, and it shows professionals only while looking as though it filters nothing.
  const kindsFor = async qs => {
    const res = await api(client.token, 'GET', `/professionals?cityId=MANCHESTER&limit=50${qs}`);

    return { status: res.status, kinds: new Set((res.body?.data ?? []).map(row => row.type)) };
  };

  const absent = await kindsFor('');
  check('the parameter absent is PROFESSIONAL only, not both',
    absent.status === 200 && absent.kinds.has('PROFESSIONAL') && !absent.kinds.has('COMMUNITY_OFFER'),
    [...absent.kinds]);

  const offersOnly = await kindsFor('&listingType=COMMUNITY_OFFER');
  check('COMMUNITY_OFFER is the offers, and only those',
    offersOnly.status === 200 && offersOnly.kinds.has('COMMUNITY_OFFER') && !offersOnly.kinds.has('PROFESSIONAL'),
    [...offersOnly.kinds]);

  const wrong = await kindsFor('&listingType=OFFER');
  check('and a value outside the three is refused, not ignored', wrong.status === 400, wrong.status);

  // BOTH merges the two kinds into one list, so the sort has to run across the merged set. Sorting
  // each kind and concatenating would look identical whenever one kind happens to rank higher
  // throughout — which it does in most data — so this is checked with a price that forces the
  // orders apart: the cheap offer must come above the dearer listing, and the dear one below it.
  const cheap = await api(pro.token, 'POST', '/community/offers', {
    title: 'A cheap hour of help with forms',
    description: 'Priced low on purpose, to prove the sort runs across both kinds rather than within each.',
    categoryCode: 'VISA_DOCS', cityId: 'MANCHESTER', priceFrom: 100, priceBasis: 'PER_JOB',
  });
  const dear = await api(pro.token, 'POST', '/community/offers', {
    title: 'An expensive hour of help with forms',
    description: 'Priced high on purpose, so one offer sits either side of the listing in the order.',
    categoryCode: 'VISA_DOCS', cityId: 'MANCHESTER', priceFrom: 900000, priceBasis: 'PER_JOB',
  });
  check('two offers priced either side of the listing', cheap.status === 201 && dear.status === 201,
    { cheap: cheap.status, dear: dear.status });

  r = await api(client.token, 'GET', '/professionals?listingType=BOTH&cityId=MANCHESTER&sort=PRICE&limit=50');
  const order = (r.body?.data ?? []).map(row => row.id);
  const at = id => order.indexOf(id);

  check('the cheapest offer sorts above the listing', at(cheap.body?.data?.id) < at(listingId),
    { cheap: at(cheap.body?.data?.id), listing: at(listingId) });
  check('and the dearest below it, so the order spans both kinds',
    at(listingId) < at(dear.body?.data?.id),
    { listing: at(listingId), dear: at(dear.body?.data?.id) });
  check('which concatenating the two kinds could not produce',
    at(cheap.body?.data?.id) < at(listingId) && at(listingId) < at(dear.body?.data?.id),
    (r.body?.data ?? []).map(row => `${row.type[0]}:${row.priceFrom?.amount ?? 'null'}`).slice(0, 8));

  r = await api(client.token, 'GET', `/professionals/${listingId}`);
  check('priceBasis is a code, as it always was', r.body?.data?.priceBasis === 'PER_JOB' || r.body?.data?.priceBasis === 'NEGOTIABLE', r.body?.data?.priceBasis);
  check('and now carries its words beside it, so no client keeps a map',
    typeof r.body?.data?.priceBasisLabel === 'string' && r.body.data.priceBasisLabel.length > 0, r.body?.data?.priceBasisLabel);
  const svcRow = (r.body?.data?.services ?? [])[0];
  check('a service carries it too', !svcRow || typeof svcRow.priceBasisLabel === 'string', svcRow);

  r = await api(client.token, 'POST', '/professionals/listings', { categoryCodes: ['LEGAL'], professionTitle: 'X', experienceLevel: 'EXPERT', about: 'Long enough to pass the minimum length rule here.', consentAccepted: true, priceBasis: 'per hour' });
  check('the display words are refused on the way in, naming the four codes',
    r.status === 400 && /PER_HOUR/.test(JSON.stringify(r.body?.error?.details ?? '')), r.body?.error?.details);

  console.log('\n── 2.6.4 Availability governs push, not pull ────────────────');

  await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/availability`, { isAcceptingWork: false });

  r = await api(client.token, 'GET', `/professionals/${listingId}`);
  check('the profile opens and the Message button has something to sit under', r.status === 200 && r.body?.data?.isAcceptingWork === false, r.body?.data?.isAcceptingWork);

  // Asked for by the title the listing actually carries by now, rather than the one it was created
  // with: this suite renames it twice before here.
  const offTitle = r.body?.data?.professionTitle;

  r = await api(client.token, 'GET', `/professionals?cityId=MANCHESTER&q=${encodeURIComponent(offTitle)}`);
  const offRow = (r.body?.data ?? []).find(p => p.id === listingId);
  check('turning work off does not hide the listing: a member who knows the name can still find it', !!offRow, { looked_for: offTitle, got: r.body?.data?.map(p => p.professionTitle) });
  check('and the card says so, so the app can draw the state', offRow?.isAcceptingWork === false, offRow?.isAcceptingWork);

  r = await api(client.token, 'GET', '/professionals?cityId=MANCHESTER&availability=ACCEPTING_BOOKINGS');
  check('but the availability filter excludes them', !(r.body?.data ?? []).some(p => p.id === listingId), r.body?.data?.map(p => p.id));

  r = await api(client.token, 'GET', '/professionals/home?cityId=MANCHESTER');
  check('and Circl stops recommending them in nearYou, which is push', !(r.body?.data?.nearYou ?? []).some(p => p.id === listingId), r.body?.data?.nearYou?.map(p => p.id));

  r = await api(client.token, 'POST', '/bookings', { listingId, serviceId });
  check('booking is where it is refused, by name', r.status === 422 && r.body?.error?.code === 'NOT_ACCEPTING_WORK', r.body?.error?.code);

  await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/availability`, { isAcceptingWork: true });

  console.log('\n── 2.3 The searched city first, then outwards ───────────────');

  r = await api(client.token, 'GET', '/professionals?cityId=TRURO&limit=20');
  const outward = r.body?.data ?? [];
  check('a city with nobody in it still fills the page', outward.length > 0, r.body?.meta);
  check('every row of it is flagged as a nearby city', outward.every(p => p.isNearbyCity === true), outward.map(p => p.isNearbyCity));
  check('and carries the distance from the city searched', outward.every(p => typeof p.milesFromSearchedCity === 'number'), outward.map(p => p.milesFromSearchedCity));
  check('nearest first', outward.every((p, i) => i === 0 || p.milesFromSearchedCity >= outward[i - 1].milesFromSearchedCity), outward.map(p => p.milesFromSearchedCity));
  check('meta.inCityCount says where the divider goes', r.body?.meta?.inCityCount === 0, r.body?.meta?.inCityCount);

  r = await api(client.token, 'GET', '/professionals?cityId=MANCHESTER&limit=20');
  const mixed = r.body?.data ?? [];
  const firstNearby = mixed.findIndex(p => p.isNearbyCity === true);
  check('the searched city comes first', firstNearby === -1 || mixed.slice(0, firstNearby).every(p => !p.isNearbyCity), mixed.map(p => p.isNearbyCity));
  check('in-city rows carry no nearby distance', mixed.filter(p => !p.isNearbyCity).every(p => p.milesFromSearchedCity === null), 'expected null');
  check('meta.inCityCount counts only the searched city', r.body?.meta?.inCityCount > 0 && r.body?.meta?.inCityCount <= r.body?.meta?.totalCount, r.body?.meta);

  const page1 = await api(client.token, 'GET', '/professionals?cityId=MANCHESTER&limit=2&page=1');
  const page2 = await api(client.token, 'GET', '/professionals?cityId=MANCHESTER&limit=2&page=2');
  const ids1 = (page1.body?.data ?? []).map(p => p.id);
  const ids2 = (page2.body?.data ?? []).map(p => p.id);
  check('page two does not repeat page one', ids2.every(id => !ids1.includes(id)), { ids1, ids2 });

  r = await api(client.token, 'GET', '/professionals?cityId=ANYWHERE&limit=20');
  check('ANYWHERE flags nothing as nearby, since nothing was searched for', (r.body?.data ?? []).every(p => p.isNearbyCity === false), r.body?.data?.map(p => p.isNearbyCity));

  // The empty state is now the case where nobody anywhere matches, because a city with nobody in
  // it fills from the cities around it. LOGISTICS is a profession the seed gives to no one.
  r = await api(client.token, 'GET', '/professionals?cityId=TRURO&category=LOGISTICS');
  check('nobody anywhere is still an empty page', r.body?.meta?.totalCount === 0 && (r.body?.data ?? []).length === 0, r.body?.meta);
  check('and carries the widen hint, empty because there is nothing to widen to', Array.isArray(r.body?.meta?.nearbyCityMatches) && r.body.meta.nearbyCityMatches.length === 0, r.body?.meta?.nearbyCityMatches);

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
  await sweep('cleanup');

  await finish();
})().catch(fail);
