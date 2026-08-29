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
  check('the rate reflects it', r.body?.data?.stats?.responseRate === 0.33, r.body?.data?.stats);

  const visitorAgain = await api(client.token, 'GET', `/professionals/${listingId}`);
  check('and still never reaches a visitor',
    !('responseRate' in visitorAgain.body.data.stats), visitorAgain.body.data.stats);

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

  await sweep();
  await finish();
})();
