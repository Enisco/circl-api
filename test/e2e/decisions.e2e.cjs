/* The numbered decisions (D1..D39).
 *
 * Each one is a rule the app depends on and which is invisible in a response
 * shape: a decayed offer, a null distance, a floor, a state that does not gate.
 * Shapes are checked elsewhere; this checks the behaviour behind them. */
const { api, check, dobFor, finish, makeUser, prisma, sweep } = require('./harness.cjs');

(async () => {
  await sweep();
  const a = await makeUser('dec-a');
  const b = await makeUser('dec-b');
  let r;

  console.log('\n── D1 / D22 taxonomy: seed everything, activate a subset ─────');
  r = await api(a.token, 'GET', '/taxonomy');
  const cats = await prisma.taxonomyTerm.count({ where: { kind: 'COMMUNITY_CATEGORY' } });
  const activeCats = await prisma.taxonomyTerm.count({ where: { kind: 'COMMUNITY_CATEGORY', isActive: true } });
  check('D1 the full community vocabulary is seeded', cats >= 19, cats);
  check('D1 the endpoint ships the full vocabulary, flagged',
    (r.body?.data?.communityCategories ?? []).length === cats, {
      served: r.body?.data?.communityCategories?.length, seeded: cats });
  check('D1 every term carries isActive, which is what the client filters on',
    (r.body?.data?.communityCategories ?? []).every(c => typeof c.isActive === 'boolean') &&
      (r.body?.data?.communityCategories ?? []).filter(c => c.isActive).length === activeCats,
    { active: activeCats });
  const items = await prisma.taxonomyTerm.count({ where: { kind: 'ITEM_CATEGORY' } });
  check('D22 commerce categories: 12 seeded, 8 flagged active',
    items === 12 && (r.body?.data?.itemCategories ?? []).filter(c => c.isActive).length === 8,
    { seeded: items, active: (r.body?.data?.itemCategories ?? []).filter(c => c.isActive).length });
  check('D13 the verification filter ships inactive so the client hides the row',
    r.body?.data?.filters?.verification?.isActive === false, r.body?.data?.filters?.verification);

  console.log('\n── D3 / D7 feed ranking ─────────────────────────────────────');
  const offer = await api(a.token, 'POST', '/community/offers', {
    categoryCode: 'AIRPORT_PICKUP', title: 'Airport runs, any hour',
    description: 'I do this run most weeks anyway, happy to take somebody along.',
    cityId: 'MANCHESTER', deliveryMode: 'IN_PERSON',
  });
  check('an offer exists to rank', offer.status === 201, offer.status);
  await prisma.communityOffer.update({
    where: { id: offer.body.data.id },
    data: { createdAt: new Date(Date.now() - 240 * 86400000) },
  });
  const req = await api(b.token, 'POST', '/community/requests', {
    categoryCode: 'AIRPORT_PICKUP', title: 'Need a lift from the airport tomorrow at 6am',
    cityId: 'MANCHESTER',
  });

  r = await api(a.token, 'GET', '/community/feed?ranking=PERSONALISED&cityId=MANCHESTER');
  const ids = (r.body?.data ?? []).map(i => i.id);
  const reqAt = ids.indexOf(req.body?.data?.id);
  const offerAt = ids.indexOf(offer.body?.data?.id);
  check('D3 an 8-month-old offer never outranks a request for tomorrow',
    reqAt !== -1 && (offerAt === -1 || reqAt < offerAt), { request: reqAt, offer: offerAt });
  const ranked = (r.body?.data ?? []).filter(i => i.ranking);
  check('D7 no ranking object carries a placeholder reason',
    ranked.every(i => typeof i.ranking.reason === 'string' && i.ranking.reason.length > 10),
    ranked[0]?.ranking);
  check('D7 every stated reason is backed by named signals',
    ranked.every(i => Array.isArray(i.ranking.signals) && i.ranking.signals.length > 0),
    ranked[0]?.ranking?.signals);

  const latest = await api(a.token, 'GET', '/community/feed?ranking=LATEST&cityId=MANCHESTER');
  check('D7 LATEST is chronological and carries no ranking at all',
    (latest.body?.data ?? []).every(i => i.ranking === undefined),
    (latest.body?.data ?? []).filter(i => i.ranking).length);
  check('D7 PERSONALISED carries it only on rows that actually matched',
    ranked.length > 0 && ranked.length < (r.body?.data ?? []).length,
    { ranked: ranked.length, total: r.body?.data?.length });

  console.log('\n── 0.16 canHelpWith is text in, chips out ───────────────────');
  for (const [raw, want] of [
    ['CV reviews, Airport runs', ['CV reviews', 'Airport runs']],
    ['I can help with most things', ['I can help with most things']],
    ['  CV reviews ,  , Airport runs ,', ['CV reviews', 'Airport runs']],
    ['', []],
  ]) {
    await api(a.token, 'PATCH', '/users/profile', { canHelpWith: raw });
    const profile = await api(a.token, 'GET', '/users/me/profile');
    check(`canHelpWith ${JSON.stringify(raw)} splits to ${JSON.stringify(want)}`,
      JSON.stringify(profile.body?.data?.canHelpWith) === JSON.stringify(want),
      profile.body?.data?.canHelpWith);
  }
  check('canHelpWith is capped at 300 raw characters',
    (await api(a.token, 'PATCH', '/users/profile', { canHelpWith: 'x'.repeat(301) })).status === 400);

  console.log('\n── 0.11 every media write is a key, every read a URL ─────────');
  {
    const mint = await api(a.token, 'POST', '/media/uploads',
      { purpose: 'COMMUNITY', files: [{ mimeType: 'image/png', byteSize: 8 }] });
    const slot = mint.body?.data?.[0];
    await fetch(slot.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' },
      body: Buffer.from('89504e470d0a1a0a', 'hex') });

    const made = await api(a.token, 'POST', '/community/groups', {
      name: `Convention check ${Date.now()}`,
      description: 'Confirming the key in, URL out convention holds for groups.',
      cityId: 'MANCHESTER', avatarKey: slot.key,
    });
    check('a group takes avatarKey on write', made.status === 201, { s: made.status, b: made.body?.error });
    check('and returns avatarUrl, signed', /X-Amz-Signature=/.test(made.body?.data?.avatarUrl ?? ''),
      made.body?.data?.avatarUrl?.slice(0, 60));
    check('the key is never returned', !('avatarKey' in (made.body?.data ?? {})),
      Object.keys(made.body?.data ?? {}).filter(k => /avatar/i.test(k)));

    const legacy = await api(a.token, 'POST', '/community/groups', {
      name: `Legacy check ${Date.now()}`,
      description: 'The pre-update field name must fail loudly, not silently.',
      cityId: 'MANCHESTER', avatarMediaId: slot.key,
    });
    check('the old avatarMediaId fails loudly, naming the field',
      legacy.status === 400 && legacy.body?.error?.details?.[0]?.field === 'avatarMediaId',
      { s: legacy.status, d: legacy.body?.error?.details });
  }

  console.log('\n── D5 / D6 guides ───────────────────────────────────────────');
  const guide = await api(a.token, 'POST', '/community/guides', {
    topicCode: 'FINANCE', title: 'Opening a bank account in your first month',
    intro: 'What the branches ask for and what they are actually allowed to ask for.',
    steps: [
      'Start with a digital bank, they need the least.',
      'Open a Monzo or Starling account on your passport alone.',
    ],
  });
  check('D5 the composer sends a flat steps array (1.6.3)', guide.status === 201, { s: guide.status, b: guide.body });
  r = await api(b.token, 'GET', `/community/guides/${guide.body?.data?.id}`);
  check('D5 it is stored as typed blocks', r.body?.data?.blocks?.[0]?.type !== undefined, r.body?.data?.blocks?.[0]);
  check('D5 and projected back to a flat steps array', Array.isArray(r.body?.data?.steps), r.body?.data?.steps);

  await api(b.token, 'PUT', `/community/guides/${guide.body?.data?.id}/progress`, { progress: 0.5 });
  const progress = await prisma.guideProgress.findFirst({ where: { userId: b.id } });
  check('D6 read progress is its own row keyed on (user, guide)',
    progress?.progress === 0.5, progress);

  console.log('\n── D9 listing lookup accepts either id ──────────────────────');
  const listing = await api(b.token, 'POST', '/professionals/listings', {
    categoryCodes: ['LEGAL'], professionTitle: 'Adviser', experienceLevel: 'EXPERT',
    about: 'Immigration casework, mostly the same three forms over and over again.',
    consentAccepted: true,
  });
  const listingId = listing.body?.data?.listing?.id;
  const byListing = await api(a.token, 'GET', `/professionals/${listingId}`);
  const byUser = await api(a.token, 'GET', `/professionals/${b.id}`);
  check('D9 a listing id resolves', byListing.status === 200, byListing.status);
  check('D9 and so does the professional\'s user id', byUser.status === 200, byUser.status);
  check('D9 both return the same listing',
    byListing.body?.data?.id === byUser.body?.data?.id, {
      a: byListing.body?.data?.id, b: byUser.body?.data?.id });

  console.log('\n── D14 listingType=BOTH is one query with a discriminator ────');
  r = await api(a.token, 'GET', '/professionals?listingType=BOTH&cityId=MANCHESTER');
  check('D14 → 200', r.status === 200, r.body?.error);
  check('D14 every row carries a type discriminator',
    (r.body?.data ?? []).every(row => row.type === 'PROFESSIONAL' || row.type === 'COMMUNITY_OFFER'),
    [...new Set((r.body?.data ?? []).map(row => row.type))]);
  check('D14 one paginated result, no duplicate ids',
    new Set((r.body?.data ?? []).map(i => i.id)).size === (r.body?.data ?? []).length);

  console.log('\n── D17 / D18 Connect ────────────────────────────────────────');
  await api(a.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP', lookingFor: 'Sunday walks and somebody to moan about the rain with.',
    dateOfBirth: dobFor(31), dmPolicy: 'REQUEST_FIRST', isVisible: true,
  });
  await api(b.token, 'PUT', '/connect/me', {
    typeCode: 'NETWORKING', lookingFor: 'Meeting people who do the same work here.',
    dateOfBirth: dobFor(29), dmPolicy: 'REQUEST_FIRST', isVisible: true,
    cityIdOverride: 'LONDON',
  });

  const bProfile = await api(b.token, 'GET', '/connect/me');
  check('D18 the override is on the Connect profile',
    bProfile.body?.data?.profile?.city?.id === 'LONDON', bProfile.body?.data?.profile?.city);
  const bUserProfile = await prisma.userProfile.findUnique({ where: { userId: b.id } });
  check('D18 and never touches users.profile.cityId',
    bUserProfile.cityId === 'MANCHESTER', bUserProfile.cityId);

  const cr = await api(a.token, 'POST', '/connect/requests',
    { toProfileId: bProfile.body?.data?.profile?.id, note: 'Same line of work by the looks of it.' },
    { 'Idempotency-Key': `dec-${Date.now()}` });
  check('a request was sent', cr.status === 201, { s: cr.status, b: cr.body });

  await api(b.token, 'PUT', '/connect/me', { isVisible: false });
  const stillThere = await api(b.token, 'GET', '/connect/requests?direction=RECEIVED');
  check('D17 hiding removes you from discovery and nothing else',
    (stillThere.body?.data ?? []).some(x => x.id === cr.body?.data?.id),
    (stillThere.body?.data ?? []).length);
  const grid = await api(a.token, 'GET', '/connect/profiles');
  check('D17 but you are gone from the grid',
    !(grid.body?.data ?? []).some(p => p.user?.id === b.id), grid.body?.data?.length);
  await api(b.token, 'PUT', '/connect/me', { isVisible: true });

  console.log('\n── D20 / D21 / D23 / D25 Commerce ───────────────────────────');
  const store = await api(a.token, 'POST', '/commerce/stores', {
    name: 'Test Provisions', type: 'LOCAL', cityId: 'MANCHESTER', area: 'Rusholme',
    description: 'A small shop selling the things the supermarkets do not.',
    delivers: true,
  });
  check('a store exists', store.status === 201, { s: store.status, b: store.body });
  const storeId = store.body?.data?.id;
  check('D23 it is live immediately, not held for review',
    store.body?.data?.status === 'OPEN', store.body?.data?.status);

  const item = await api(a.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Ground egusi', price: 650, unitCode: 'PER_500G', categoryCode: 'FOOD_GROCERIES',
  });
  const custom = await api(a.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Spice mix', price: 400, unitCode: 'EACH', unitCustomLabel: 'per scoop',
    categoryCode: 'FOOD_GROCERIES',
  });
  check('D21 a custom unit label is accepted alongside the code',
    custom.status === 201 && custom.body?.data?.unit?.label === 'per scoop',
    { s: custom.status, u: custom.body?.data?.unit });

  r = await api(b.token, 'POST', '/commerce/carts/validate',
    { lines: [{ itemId: item.body?.data?.id, quantity: 2 }] });
  check('D20 the cart is validated server-side, not stored', r.status === 200, { s: r.status, b: r.body });

  r = await api(b.token, 'GET', '/commerce/stores?cityId=MANCHESTER');
  check('D25 distanceMiles is null without a location, never estimated',
    (r.body?.data ?? []).every(s => s.distanceMiles === null),
    (r.body?.data ?? []).map(s => s.distanceMiles).slice(0, 5));

  console.log('\n── D24 an expired enquiry cannot be reviewed ────────────────');
  const enquiry = await api(b.token, 'POST', '/commerce/enquiries',
    { storeId, lines: [{ itemId: item.body?.data?.id, quantity: 1 }], fulfilment: 'COLLECTION' },
    { 'Idempotency-Key': `dec-e-${Date.now()}` });
  await prisma.enquiry.update({ where: { id: enquiry.body?.data?.id }, data: { state: 'EXPIRED' } });
  r = await api(b.token, 'POST', '/reviews', {
    subjectUserId: a.id, rating: 5, context: 'ORDER', sourceId: enquiry.body?.data?.id,
    comment: 'Trying to review something that expired.',
  });
  check('D24 → 422, because nothing was ever confirmed as received',
    r.status === 422, { s: r.status, c: r.body?.error?.code });

  console.log('\n── D26 / D27 / D28 messaging ────────────────────────────────');
  const convo = await api(b.token, 'POST', '/messages', { recipientUserId: a.id },
    { 'Idempotency-Key': `dec-m-${Date.now()}` });
  const convoId = convo.body?.data?.id;
  const sent = await api(b.token, 'POST', `/messages/${convoId}/messages`,
    { clientId: 'dec-1', body: 'Is this still going?' });
  check('D26 the server stamps sentAt', typeof sent.body?.data?.sentAt === 'string',
    Object.keys(sent.body?.data ?? {}));

  r = await api(b.token, 'PATCH', `/messages/${convoId}/messages/${sent.body?.data?.id}`,
    { body: 'Edited' });
  check('D27 there is no message edit route', r.status === 404 || r.status === 405, r.status);

  console.log('\n── D2 anonymous posts stay blockable ────────────────────────');
  const anon = await api(a.token, 'POST', '/community/requests', {
    categoryCode: 'ACCOMMODATION', title: 'Something I would rather not put my name to',
    cityId: 'MANCHESTER', visibility: 'ANONYMOUS',
  });
  r = await api(b.token, 'GET', `/community/requests/${anon.body?.data?.id}`);
  check('D2 an anonymous post names nobody', r.body?.data?.author?.id === null, r.body?.data?.author);
  check('D2 but carries a reportToken so it stays reportable',
    typeof r.body?.data?.reportToken === 'string', r.body?.data?.reportToken);
  const reported = await api(b.token, 'POST', '/moderation/reports', {
    targetType: 'REQUEST', targetId: r.body?.data?.reportToken,
    reasonCode: 'SPAM', note: 'Testing the anonymous path.',
  });
  check('D2 the reportToken is accepted in targetId (1.8.1)',
    reported.status === 202, { s: reported.status, b: reported.body });
  check('D2 and the response reveals nothing about the outcome',
    reported.body?.data === null, reported.body?.data);

  await sweep();
  await finish();
})();
