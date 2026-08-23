/* Compares live payloads against the field lists in the spec's JSON examples.
   Missing keys are failures; extra keys are reported but not failed, since the
   spec's examples are illustrative and additive fields are safe. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');

const dobFor = y => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };

/** Every key the spec's example shows, dotted for nesting. */
const has = (obj, path) =>
  path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj) !== undefined;

function shape(label, obj, required) {
  const missing = required.filter(k => !has(obj, k));
  check(`${label}: ${required.length} spec fields present`, missing.length === 0, { missing, got: obj && Object.keys(obj) });
}

(async () => {
  await sweep('pre-run');
  const a = await makeUser('sa', { countryOfOrigin: 'NG', journeyStage: 'JUST_ARRIVED', bio: 'Nine years in immigration law helping people through it.' });
  const b = await makeUser('sb', { countryOfOrigin: 'GH', journeyStage: 'JUST_ARRIVED' });

  console.log('\n── 0.9 author, 0.10 viewer, 0.5 meta ────────────────────────');

  let r = await api(a.token, 'POST', '/community/requests', {
    categoryCode: 'VISA_DOCS', title: 'Need help understanding my CoS letter',
    description: 'I got my Certificate of Sponsorship last week and cannot read the sponsor section.',
    cityId: 'MANCHESTER', neededOn: new Date(Date.now() + 86400000 * 5).toISOString().slice(0, 10),
    thankYouAmount: 2000,
  });
  const req = r.body?.data;
  const reqId = req?.id;

  shape('0.9 author', req?.author, [
    'id', 'displayName', 'username', 'avatarUrl', 'city', 'isAnonymous',
    'trustChecks', 'isProfessional', 'professionalId',
  ]);
  check('0.9 author.city has id and name', has(req?.author, 'city.id') && has(req?.author, 'city.name'), req?.author?.city);
  check('0.9 trustChecks is an array, never null', Array.isArray(req?.author?.trustChecks), req?.author?.trustChecks);

  shape('1.2.2 request detail', req, [
    'id', 'category.code', 'category.label', 'status', 'title', 'description',
    'city.id', 'city.name', 'neededOn', 'thankYou.amount', 'thankYou.currency',
    'media', 'counts.views', 'counts.helpers', 'counts.replies', 'author',
    'visibility', 'reportToken', 'isNearYou', 'viewer.isOwner', 'viewer.hasOffered',
    'viewer.hasReplied', 'viewer.isBlocked', 'viewer.canEdit', 'viewer.canDelete',
    'viewer.canResolve', 'resolution', 'createdAt', 'updatedAt',
  ]);
  check('0.6 neededOn is a plain date, not a timestamp', /^\d{4}-\d{2}-\d{2}$/.test(req?.neededOn ?? ''), req?.neededOn);
  check('0.6 createdAt is ISO 8601 with a UTC offset', /Z$/.test(req?.createdAt ?? ''), req?.createdAt);
  check('0.6 no pre-formatted display strings (timeAgo etc.)',
    !JSON.stringify(req).match(/"(timeAgo|memberCountLabel|offerLabel|readTime|priceLabel|authorAvatarColor)"/), null);

  r = await api(a.token, 'GET', '/community/requests?status=ALL');
  shape('0.5 page meta', r.body?.meta, [
    'currentPage', 'perPage', 'totalPages', 'totalCount', 'hasNextPage', 'hasPreviousPage',
  ]);

  console.log('\n── 1.1 feed items ───────────────────────────────────────────');

  await api(b.token, 'POST', `/community/requests/${reqId}/responses`, { content: 'I went through this last year, happy to help.', isHelpOffer: true });
  await api(a.token, 'POST', '/community/updates', { content: 'Finally got my BRP today after six weeks of waiting.' });
  await api(a.token, 'POST', '/community/offers', {
    title: 'Airport pickups from Manchester Airport',
    description: 'I drive a 7-seater and do airport runs most evenings, including early mornings.',
    categoryCode: 'AIRPORT_PICKUP', cityId: 'MANCHESTER', priceFrom: 3000, priceBasis: 'PER_JOB',
  });

  r = await api(b.token, 'GET', '/community/feed?limit=20');
  shape('0.5 cursor meta', r.body?.meta, ['nextCursor', 'hasNextPage', 'totalCount']);
  check('0.5 feed totalCount is null', r.body?.meta?.totalCount === null, r.body?.meta?.totalCount);

  const feedReq = r.body?.data?.find(i => i.type === 'REQUEST');
  shape('1.1 REQUEST feed item', feedReq, [
    'type', 'id', 'category', 'status', 'title', 'excerpt', 'city', 'neededOn',
    'thankYou', 'media', 'counts.views', 'counts.helpers', 'counts.replies',
    'author', 'visibility', 'isNearYou', 'viewer.isOwner', 'viewer.hasOffered', 'createdAt',
  ]);
  check('1.1 excerpt is present and truncated, not the full body', typeof feedReq?.excerpt === 'string' && feedReq.excerpt.length <= 201, feedReq?.excerpt?.length);
  check('1.1 counts.helpers reflects real offers', feedReq?.counts?.helpers === 1, feedReq?.counts);

  const feedUpd = r.body?.data?.find(i => i.type === 'UPDATE');
  shape('1.1 UPDATE feed item', feedUpd, [
    'type', 'id', 'content', 'media', 'city', 'counts.reactions', 'counts.replies',
    'commentsEnabled', 'reactionCountHidden', 'author', 'visibility',
    'viewer.isOwner', 'viewer.hasLiked', 'createdAt',
  ]);

  const feedOffer = r.body?.data?.find(i => i.type === 'OFFER');
  shape('1.4.1 OFFER feed item', feedOffer, [
    'id', 'title', 'excerpt', 'category', 'city', 'deliveryMode',
    'priceFrom', 'priceBasis', 'isFree', 'media', 'provider', 'createdAt',
  ]);

  console.log('\n── 1.3.1 / 1.6 / 1.7 ────────────────────────────────────────');

  r = await api(a.token, 'GET', `/community/requests/${reqId}/responses`);
  shape('1.3.1 response', r.body?.data?.[0], [
    'id', 'content', 'isHelpOffer', 'isPrivate', 'availableOn', 'thankYouExpected',
    'author', 'viewer.isOwner', 'viewer.canDelete', 'createdAt',
  ]);

  r = await api(a.token, 'POST', '/community/guides', {
    topicCode: 'FINANCE', title: 'Opening a UK bank account with no proof of address',
    intro: 'Most branches will tell you no. Here is the route that actually works.',
    steps: ['Book an appointment online before you go.', 'Take your BRP and passport.'],
    cityId: 'MANCHESTER', resourceUrl: 'https://www.gov.uk/',
  });
  const guideId = r.body?.data?.id;
  shape('1.6.2 guide detail', r.body?.data, [
    'id', 'title', 'topic', 'intro', 'steps', 'blocks', 'resourceUrl', 'media',
    'readTimeMinutes', 'counts.views', 'counts.likes', 'author', 'isAutoGenerated',
    'provenance', 'viewer.isBookmarked', 'viewer.hasLiked', 'viewer.readProgress',
    'relatedGuideIds', 'publishedAt',
  ]);
  check('1.6.2 blocks carry a type', r.body?.data?.blocks?.[0]?.type === 'STEP', r.body?.data?.blocks?.[0]);

  r = await api(a.token, 'GET', '/community/guides');
  shape('1.6.1 guide summary', r.body?.data?.[0], [
    'id', 'title', 'topic', 'intro', 'city', 'readTimeMinutes', 'counts.views',
    'counts.likes', 'author', 'isAutoGenerated', 'viewer.isBookmarked',
    'viewer.hasLiked', 'viewer.readProgress', 'publishedAt',
  ]);

  r = await api(a.token, 'POST', '/community/groups', {
    name: `Shape Group ${Date.now()}`, description: 'Everything from where to find yam to where to worship.',
    cityId: 'MANCHESTER',
  });
  const groupId = r.body?.data?.id;
  shape('1.7.2 group detail', r.body?.data, [
    'id', 'name', 'description', 'city', 'memberCount', 'joinPolicy', 'isNew',
    'avatarUrl', 'viewer.membership', 'viewer.unreadPostCount', 'viewer.isAdmin',
    'viewer.canPost', 'viewer.canModerate', 'createdAt', 'memberPreview', 'admins', 'rules',
  ]);
  check('1.7.2 pendingRequestCount present for an admin', r.body?.data?.pendingRequestCount !== undefined, r.body?.data?.pendingRequestCount);
  r = await api(b.token, 'GET', `/community/groups/${groupId}`);
  check('1.7.2 pendingRequestCount OMITTED for non-admins', r.body?.data?.pendingRequestCount === undefined, r.body?.data?.pendingRequestCount);
  check('1.7.1 memberCount is an integer, not "1.2k"', Number.isInteger(r.body?.data?.memberCount), r.body?.data?.memberCount);

  r = await api(a.token, 'GET', `/community/groups/${groupId}/posts`);
  await api(a.token, 'POST', `/community/groups/${groupId}/posts`, { content: 'MMU runs a free legal clinic on Thursdays.' });
  r = await api(a.token, 'GET', `/community/groups/${groupId}/posts`);
  shape('1.7.5 group post', r.body?.data?.[0], [
    'id', 'content', 'media', 'counts.replies', 'author', 'viewer.isOwner', 'viewer.canDelete', 'createdAt',
  ]);

  console.log('\n── 2.x Professionals ────────────────────────────────────────');

  r = await api(a.token, 'GET', '/professionals/registration/prefill');
  shape('2.1.2 registration prefill', r.body?.data, [
    'listing', 'prefill.fullName', 'prefill.cityId', 'prefill.cityName',
    'prefill.phoneNumber', 'prefill.avatarUrl', 'prefill.about', 'prefill.aboutSource',
    'promotableOffers', 'steps',
  ]);
  check('2.1.2 steps[] carry key, status and source', has(r.body?.data?.steps?.[0], 'key') && has(r.body?.data?.steps?.[0], 'status') && has(r.body?.data?.steps?.[0], 'source'), r.body?.data?.steps?.[0]);
  check('2.1.2 promotableOffers carry the D8 profession bridge', r.body?.data?.promotableOffers?.[0]?.suggestedProfessionCodes !== undefined, r.body?.data?.promotableOffers?.[0]);

  r = await api(a.token, 'POST', '/professionals/listings', {
    categoryCodes: ['LEGAL'], professionTitle: 'Immigration Lawyer', experienceLevel: 'EXPERT',
    about: 'I specialise in UK immigration law and have done for nine years now.',
    consentAccepted: true, priceFrom: 6500, priceBasis: 'PER_HOUR', yearsExperience: 9,
  });
  const listingId = r.body?.data?.listing?.id;
  check('2.6.1 create returns the listing AND the step list', !!r.body?.data?.listing && Array.isArray(r.body?.data?.steps), Object.keys(r.body?.data ?? {}));

  await api(a.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'Initial Consultation', description: '1-hour session covering your case', price: 6500, priceBasis: 'PER_HOUR',
  });

  r = await api(b.token, 'GET', `/professionals/${listingId}`);
  shape('2.4 professional profile', r.body?.data, [
    'id', 'user', 'professionTitle', 'categories', 'experienceLevel', 'yearsExperience',
    'about', 'city', 'deliveryMode', 'rating.average', 'rating.count',
    'rating.excludedCount', 'rating.distribution', 'stats.jobsCompleted',
    'stats.medianResponseMinutes', 'stats.profileViews', 'priceFrom', 'priceBasis',
    'isAcceptingWork', 'services', 'trust.checks', 'communityProfileUrl',
    'verificationStatus', 'viewer.isOwner', 'viewer.hasBookedBefore',
    'viewer.canLeavePriorWorkReview', 'viewer.conversationId',
  ]);
  shape('2.4 service row', r.body?.data?.services?.[0], ['id', 'name', 'description', 'price', 'priceBasis', 'isActive']);
  check('2.4 trust check carries provenance', has(r.body?.data?.trust?.checks?.[0], 'checkedBy') && has(r.body?.data?.trust?.checks?.[0], 'verifiedAt'), r.body?.data?.trust?.checks?.[0]);
  check('2.4 rating.distribution has all five stars', Object.keys(r.body?.data?.rating?.distribution ?? {}).length === 5, r.body?.data?.rating?.distribution);

  r = await api(b.token, 'GET', '/professionals?cityId=MANCHESTER');
  shape('2.3 professional summary', r.body?.data?.[0], [
    'type', 'id', 'user', 'professionTitle', 'category', 'categories', 'city',
    'distanceMiles', 'rating.average', 'rating.count', 'rating.excludedCount',
    'medianResponseMinutes', 'priceFrom', 'priceBasis', 'isAcceptingWork',
    'trustChecks', 'isImmigrantFriendly',
  ]);

  r = await api(a.token, 'GET', '/professionals/home');
  shape('2.2 professionals home', r.body?.data, [
    'categories', 'nearYou', 'myListing', 'activeBookings', 'trust.verifiedCount',
    'trust.vouchedCount', 'trust.ratedCount',
  ]);
  shape('2.2 myListing', r.body?.data?.myListing, ['id', 'title', 'category', 'serviceCount', 'isAcceptingWork', 'verificationStatus']);
  check('2.2 categories carry professionalCount', r.body?.data?.categories?.[0]?.professionalCount !== undefined, r.body?.data?.categories?.[0]);

  r = await api(a.token, 'GET', '/professionals/me/dashboard');
  shape('2.11 dashboard', r.body?.data, [
    'inProgress.count', 'inProgress.agreedTotal', 'completed.count', 'completed.agreedTotal',
    'jobsThisMonth', 'medianResponseMinutes', 'profileViews',
    'conversion.views', 'conversion.bookings', 'conversion.rate', 'isAcceptingWork',
  ]);

  r = await api(b.token, 'POST', '/professionals/briefs', {
    categoryCode: 'LEGAL', description: 'I need help with a refused spouse visa.', urgency: 'ASAP', budget: 8000,
  });
  const briefId = r.body?.data?.id;
  r = await api(b.token, 'GET', `/professionals/briefs/${briefId}/matches`);
  shape('2.8.2 matches', r.body?.data, ['briefId', 'matches', 'shortlistSize']);
  shape('2.8.2 match', r.body?.data?.matches?.[0], [
    'professional', 'priceForBrief', 'scores.rating.value', 'scores.rating.qualifier',
    'scores.distance.value', 'scores.price.value', 'scores.response.value', 'rationale',
  ]);

  r = await api(b.token, 'GET', `/reviews/${a.id}`);
  shape('2.5.1 reviews', r.body?.data, [
    'summary.average', 'summary.countedTotal', 'summary.excludedTotal',
    'summary.distribution', 'summary.byContext', 'reviews',
  ]);

  console.log('\n── 3.x Connect ──────────────────────────────────────────────');

  await api(a.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE', lookingFor: 'Practising English after work, happy to help with Yoruba.',
    dateOfBirth: dobFor(31), isVisible: true, languages: ['ENGLISH', 'YORUBA'], heritageTag: 'WEST_AFRICAN',
  });
  await api(b.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP', lookingFor: 'New to the city and looking to meet people.',
    dateOfBirth: dobFor(29), isVisible: true,
  });

  r = await api(a.token, 'GET', '/connect/me');
  shape('3.2.1 connect me', r.body?.data, ['hasProfile', 'isVisible', 'profile', 'pendingRequestCount']);
  shape('3.2.1 connect profile', r.body?.data?.profile, [
    'id', 'user', 'age', 'type', 'lookingFor', 'languages', 'interests',
    'heritageTag', 'journeyStage', 'dmPolicy', 'isVerified',
  ]);

  r = await api(b.token, 'GET', '/connect/setup/prefill');
  shape('3.2.2 setup prefill', r.body?.data, [
    'profile', 'prefill.displayName', 'prefill.avatarUrl', 'prefill.cityId',
    'prefill.cityName', 'prefill.dateOfBirth', 'prefill.age', 'prefill.dateOfBirthLocked',
    'prefill.interests', 'prefill.languages', 'prefill.heritageTag',
    'prefill.journeyStage', 'prefill.isVerified', 'asks', 'minimumAge',
  ]);

  r = await api(a.token, 'GET', `/connect/profiles/${b.id}`);
  shape('3.2.3 another profile', r.body?.data, [
    'sharedContext', 'viewer.canMessageDirectly', 'viewer.requestState',
    'viewer.conversationId', 'viewer.isBlocked', 'reportToken',
  ]);
  r = await api(a.token, 'GET', '/connect/profiles');
  shape('3.4 discovery facets', r.body?.meta, ['facets.languages', 'facets.heritage']);

  console.log('\n── 4.x Commerce ─────────────────────────────────────────────');

  const seller = await makeUser('ssel', { phoneNumber: '7700900123', phoneNumberDiallingCode: '+44', heritageTag: 'WEST_AFRICAN' });
  r = await api(seller.token, 'GET', '/commerce/stores/setup/prefill');
  shape('4.1.2 store prefill', r.body?.data, [
    'store', 'prefill.cityId', 'prefill.cityName', 'prefill.phoneNumber',
    'prefill.phoneSource', 'prefill.suggestedHeritageTags', 'prefill.suggestedLogoUrl', 'steps',
  ]);

  r = await api(seller.token, 'POST', '/commerce/stores', {
    name: 'Mama Nkechi Foods', type: 'LOCAL', description: 'West African groceries and frozen fish.',
    area: 'Moss Side', heritageTags: ['WEST_AFRICAN'], delivers: true,
    openingHours: ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'].map(day => ({ day, openMinutes: 540, closeMinutes: 1200 })),
    contact: [{ channel: 'WHATSAPP', value: '+447911123456' }, { channel: 'INSTAGRAM', value: '@kemibeauty' }],
  });
  const storeId = r.body?.data?.id;
  shape('4.5.1 store detail', r.body?.data, [
    'id', 'name', 'type', 'description', 'area', 'city', 'distanceMiles',
    'hidesExactAddress', 'heritageTags', 'categories', 'logoUrl', 'coverUrl',
    'rating.average', 'rating.count', 'isOpenNow', 'openingHours', 'timezone',
    'delivers', 'isNew', 'itemPreview', 'status', 'contact', 'address.area',
    'address.line1', 'address.postcode', 'address.latitude', 'address.longitude',
    'owner', 'catalogue.categories', 'viewer.isOwner', 'viewer.canReview', 'viewer.conversationId',
  ]);
  shape('4.5.1 opening hours row', r.body?.data?.openingHours?.[0], ['day', 'openMinutes', 'closeMinutes']);
  check('4.5.1 exactly 7 opening-hours entries, Monday first', r.body?.data?.openingHours?.length === 7 && r.body.data.openingHours[0].day === 'MONDAY', r.body?.data?.openingHours?.length);
  shape('4.5.1 contact row', r.body?.data?.contact?.[0], ['channel', 'value', 'display']);

  await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Egusi (ground melon seed)', price: 650, unitCode: 'PER_500G', categoryCode: 'FOOD_GROCERIES',
  });
  r = await api(b.token, 'GET', '/commerce/items');
  shape('4.4.3 item', r.body?.data?.[0], [
    'id', 'storeId', 'storeName', 'name', 'price.amount', 'price.currency',
    'unit.code', 'unit.label', 'category', 'photos', 'coverPhotoUrl',
    'isAvailable', 'distanceMiles', 'storeIsOpenNow',
  ]);

  const itemId = r.body?.data?.[0]?.id;
  r = await api(b.token, 'POST', '/commerce/enquiries', {
    storeId, lines: [{ itemId, quantity: 2 }], fulfilment: 'COLLECTION',
  });
  shape('4.7.1 enquiry', r.body?.data, [
    'id', 'reference', 'store', 'state', 'stage', 'lines', 'estimatedTotal',
    'fulfilment', 'conversationId', 'timeline', 'createdAt',
  ]);
  shape('4.7.1 enquiry line', r.body?.data?.lines?.[0], ['itemId', 'name', 'quantity', 'unitPrice', 'lineTotal']);

  r = await api(b.token, 'GET', '/commerce/home');
  shape('4.3 commerce home', r.body?.data, ['openNearYou', 'popular', 'newStores', 'categories', 'myStore', 'cart']);
  check('4.3 categories carry storeCount', r.body?.data?.categories?.[0]?.storeCount !== undefined, r.body?.data?.categories?.[0]);

  console.log('\n── 5.x Messaging ────────────────────────────────────────────');

  r = await api(b.token, 'GET', '/messages');
  const row = r.body?.data?.find(c => c.context?.type === 'ORDER');
  shape('5.3.1 inbox row', row, [
    'id', 'kind', 'isPinned', 'participant', 'context.type', 'context.id',
    'context.title', 'context.subtitle', 'context.thumbnailUrl', 'context.trailing',
    'context.route', 'label', 'lastMessage', 'unreadCount', 'isTyping', 'isMuted',
  ]);
  check('5.3.1 participant carries presence', has(row?.participant, 'isOnline') && has(row?.participant, 'lastSeenAt'), row?.participant);
  shape('5.3.1 lastMessage', row?.lastMessage, ['id', 'kind', 'body', 'senderId', 'isMine', 'status', 'sentAt']);
  shape('5.3.1 inbox meta', r.body?.meta, ['unreadTotal', 'unreadThreads']);

  await api(b.token, 'POST', `/messages/${row.id}/messages`, { clientId: 'shape-1', body: 'Is this still available?' });
  r = await api(b.token, 'GET', `/messages/${row.id}/messages`);
  shape('5.3.3 message', r.body?.data?.[0], [
    'id', 'conversationId', 'kind', 'body', 'sender', 'isMine', 'attachments',
    'status', 'systemType', 'sentAt', 'editedAt', 'deletedAt',
  ]);

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await sweep('cleanup');
  await finish();
})().catch(fail);
