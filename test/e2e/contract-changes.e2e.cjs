/* The smaller contract changes in the updated spec.
 *
 * Each one is small enough to look obvious and specific enough to get wrong:
 * owner-only stats that must not leak, an id that saves a round trip, a field
 * that lives on the user record but is printed on a Connect card, and a tab
 * gated on the right thing. */
const { api, check, finish, makeUser, prisma, sweep } = require('./harness.cjs');

(async () => {
  await sweep();
  const pro = await makeUser('cc-pro');
  const client = await makeUser('cc-cli');

  console.log('\n── 0.7 helpTags in the taxonomy ─────────────────────────────');
  let r = await api(pro.token, 'GET', '/taxonomy');
  check('taxonomy → 200', r.status === 200, r.status);
  const tags = r.body?.data?.helpTags ?? [];
  check('helpTags is served', tags.length > 0, tags.length);
  check('as code/label pairs, not free text',
    tags.every(t => typeof t.code === 'string' && typeof t.label === 'string'), tags[0]);

  console.log('\n── 2.4 owner-only listing stats ─────────────────────────────');
  const made = await api(pro.token, 'POST', '/professionals/listings', {
    categoryCodes: ['LEGAL'], professionTitle: 'Immigration Lawyer', experienceLevel: 'EXPERT',
    about: 'I specialise in UK immigration law and have done for nine years now.',
    consentAccepted: true,
  });
  check('listing created', made.status === 201, { s: made.status, b: made.body });
  const listingId = made.body?.data?.listing?.id;

  r = await api(pro.token, 'GET', '/professionals/me');
  check('the owner sees enquiries and responseRate',
    'enquiries' in (r.body?.data?.stats ?? {}) && 'responseRate' in (r.body?.data?.stats ?? {}),
    r.body?.data?.stats);
  check('responseRate is null below three enquiries',
    r.body?.data?.stats?.responseRate === null, r.body?.data?.stats);
  check('enquiries starts at zero', r.body?.data?.stats?.enquiries === 0, r.body?.data?.stats);

  const seen = await api(client.token, 'GET', `/professionals/${listingId}`);
  check("a visitor's view carries stats", seen.status === 200 && seen.body?.data?.stats, seen.status);
  check('but not the owner\'s performance numbers',
    !('enquiries' in seen.body.data.stats) && !('responseRate' in seen.body.data.stats),
    seen.body.data.stats);

  // The counting itself, exercised through bookings.
  const svc = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'Initial Consultation', description: '1-hour session covering your case and next steps',
    price: 6500, priceBasis: 'PER_HOUR',
  });
  const serviceId = svc.body?.data?.id;
  await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/availability`,
    { isAcceptingWork: true });

  const enquirers = [];
  for (let i = 0; i < 3; i++) {
    const buyer = await makeUser(`cc-b${i}`);
    enquirers.push(buyer);
    const booked = await api(buyer.token, 'POST', '/bookings',
      { listingId, serviceId, agreedAmount: 6500 },
      { 'Idempotency-Key': `e2e-cc-${i}-${Date.now()}` });
    if (i === 0) check('a booking request is an enquiry', booked.status === 201, { s: booked.status, b: booked.body });
    if (i === 0) enquirers[0].bookingId = booked.body?.data?.id;
  }

  r = await api(pro.token, 'GET', '/professionals/me');
  check('three enquirers are counted', r.body?.data?.stats?.enquiries === 3, r.body?.data?.stats);
  check('none answered yet reads as 0, not null, once there are three',
    r.body?.data?.stats?.responseRate === 0, r.body?.data?.stats);

  // Declining is answering: saying no is a reply.
  const declined = await api(pro.token, 'POST', `/bookings/${enquirers[0].bookingId}/decline`,
    { reason: 'I am fully booked for the next month.' });
  check('the professional acts on one', declined.status === 200 || declined.status === 201,
    { s: declined.status, b: declined.body });

  r = await api(pro.token, 'GET', '/professionals/me');
  // An integer percent, the same shape and formatter as the store's counter.
  check('the rate reflects it, one answered in three', r.body?.data?.stats?.responseRate === 33, r.body?.data?.stats);

  const visitorAgain = await api(client.token, 'GET', `/professionals/${listingId}`);
  check('and still never reaches a visitor',
    !('responseRate' in visitorAgain.body.data.stats), visitorAgain.body.data.stats);

  const own = await api(pro.token, 'GET', `/professionals/${listingId}`);
  check('but the profile a professional opens of themselves carries it, like their own shop page',
    own.body?.data?.stats?.responseRate === 33 && own.body?.data?.stats?.enquiries === 3,
    own.body?.data?.stats);

  console.log('\n── 2.11 listingId on the dashboard ──────────────────────────');
  r = await api(pro.token, 'GET', '/professionals/me/dashboard');
  check('dashboard → 200', r.status === 200, r.status);
  check('it carries listingId, so the availability switch needs no lookup',
    r.body?.data?.listingId === listingId, { got: r.body?.data?.listingId, want: listingId });

  console.log('\n── 2.9.3 the bookings professional tab ──────────────────────');
  r = await api(pro.token, 'GET', '/bookings?role=PROFESSIONAL');
  check('a professional with a listing may read the tab', r.status === 200, { s: r.status, b: r.body?.error });
  const listing = await prisma.professionalListing.findUnique({ where: { id: listingId } });
  check('and is gated on the listing, not on verification',
    listing.verificationStatus === 'UNVERIFIED', listing.verificationStatus);

  r = await api(client.token, 'GET', '/bookings?role=PROFESSIONAL');
  check('a member without one is refused',
    r.status === 403 && r.body?.error?.code === 'NOT_A_PROFESSIONAL',
    { s: r.status, c: r.body?.error?.code });

  r = await api(client.token, 'GET', '/bookings?role=CLIENT');
  check('but the client tab is theirs', r.status === 200, r.status);

  await prisma.professionalListing.update({
    where: { id: listingId }, data: { deletedAt: new Date() },
  });
  r = await api(pro.token, 'GET', '/bookings?role=PROFESSIONAL');
  check('a deleted listing does not keep the tab open', r.status === 403, r.status);
  await prisma.professionalListing.update({ where: { id: listingId }, data: { deletedAt: null } });

  console.log('\n── 3.2.1 countryOfOrigin and city on Connect ────────────────');
  await api(pro.token, 'PATCH', '/users/profile',
    { countryOfOrigin: 'NG', dateOfBirth: '1994-03-11', cityId: 'Manchester' });

  r = await api(pro.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Practising English after work, happy to help with Yoruba in return.',
    dmPolicy: 'REQUEST_FIRST', isVisible: true,
  });
  check('connect profile saved', r.status === 200 || r.status === 201, { s: r.status, b: r.body });

  r = await api(pro.token, 'GET', '/connect/me');
  const profile = r.body?.data?.profile ?? {};
  check('the card carries countryOfOrigin as a code/label pair',
    profile.countryOfOrigin?.code === 'NG' && typeof profile.countryOfOrigin?.label === 'string',
    profile.countryOfOrigin);
  check('and city, so the hero can print "Manchester · Nigeria"',
    profile.city?.id === 'MANCHESTER' && typeof profile.city?.name === 'string', profile.city);
  check('countryOfOrigin comes from the user record, not a Connect copy', (() => {
    const row = profile.countryOfOrigin;
    return row && !('connectCountryOfOrigin' in profile);
  })(), Object.keys(profile));

  console.log('\n── 0.12 A key on the two creates that already refuse a second ──');

  // The argument the mobile team changed their mind on: a member whose save timed out and who taps
  // again should get their shop back, not an error for something that worked.
  const shopkeeper = await makeUser('cc-shop');
  const shop = { name: 'Ada Retry Grocers', type: 'LOCAL', area: 'Longsight',
    description: 'A shop created twice on purpose, to see which of the two answers comes back.' };

  r = await api(shopkeeper.token, 'POST', '/commerce/stores', shop, { 'Idempotency-Key': 'cc-shop-1' });
  const shopId = r.body?.data?.id;
  check('store create → 201', r.status === 201 && !!shopId, r.body?.error);

  r = await api(shopkeeper.token, 'POST', '/commerce/stores', shop, { 'Idempotency-Key': 'cc-shop-1' });
  check('the same key replays the shop rather than refusing it',
    r.status === 201 && r.body?.data?.id === shopId, { status: r.status, error: r.body?.error?.code });

  r = await api(shopkeeper.token, 'POST', '/commerce/stores', shop, { 'Idempotency-Key': 'cc-shop-2' });
  check('but a different key is a different intention, and one store per member still holds',
    r.status === 409 && r.body?.error?.code === 'STORE_ALREADY_EXISTS', r.body?.error?.code);
  check('so there is still one shop',
    (await prisma.store.count({ where: { ownerId: shopkeeper.id } })) === 1);

  const fitter = await makeUser('cc-fit', { bio: 'Eleven years fitting kitchens.' });
  const fitting = { categoryCodes: ['TRADES_REPAIRS'], professionTitle: 'Kitchen Fitter',
    experienceLevel: 'EXPERT', consentAccepted: true,
    about: 'A listing created twice at once, to see whether both of them go through.' };
  const idOf = row => row?.body?.data?.listing?.id ?? row?.body?.data?.id;

  const [one, two] = await Promise.all([
    api(fitter.token, 'POST', '/professionals/listings', fitting, { 'Idempotency-Key': 'cc-list-1' }),
    api(fitter.token, 'POST', '/professionals/listings', fitting, { 'Idempotency-Key': 'cc-list-1' }),
  ]);
  const winner = [one, two].find(row => row.status === 201);
  check('two listing creates at once give one listing and one refusal',
    !!winner && [one, two].some(row => row.status === 409), [one.status, two.status]);
  check('named, so it is not inferred from the status',
    [one, two].find(row => row.status === 409)?.body?.error?.code === 'IDEMPOTENT_REQUEST_IN_PROGRESS',
    [one, two].find(row => row.status === 409)?.body?.error);
  check('only one was created',
    (await prisma.professionalListing.count({ where: { userId: fitter.id } })) === 1);

  r = await api(fitter.token, 'POST', '/professionals/listings', fitting, { 'Idempotency-Key': 'cc-list-1' });
  check('and once it has finished, the same key replays it',
    r.status === 201 && idOf(r) === idOf(winner), { status: r.status, error: r.body?.error?.code });

  await sweep();
  await finish();
})();
