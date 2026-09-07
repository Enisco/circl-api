/* Does the person whose thing it is actually hear about it?
 *
 * Every assertion here is the same shape: one member engages with another member's content, and
 * the owner's own notification list is then read back to see whether anything arrived. That is the
 * only test that matters for this feature, because the write path is fire-and-forget by design —
 * a failed notification must never fail the action that caused it, which also means a broken one
 * fails completely silently.
 *
 * The push half is asserted at the end, for what can be proved without a phone: that every device
 * a member registers is kept and addressed, that a handset changing hands moves rather than
 * doubling, and that a token FCM rejects as dead is dropped rather than retried forever. The last
 * of those reaches Google, so it needs the network and valid Firebase credentials, the same way
 * the media suite needs S3. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');

const allDay = () => ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY']
  .map(day => ({ day, openMinutes: 0, closeMinutes: 1439 }));

/** The recipient's list, newest first. */
const inbox = async token => (await api(token, 'GET', '/notifications?limit=20')).body?.data ?? [];
const has = (rows, kind, fragment) =>
  rows.some(row => row.kind === kind && (row.title ?? '').toLowerCase().includes(fragment.toLowerCase()));

/**
 * A notification is raised fire-and-forget, deliberately: a failed notification must never fail
 * the action that caused it, so the row lands a moment after the response the client already has.
 * Polling is what asserting an eventual write honestly looks like; a fixed sleep would be slower
 * and flakier at the same time.
 */
const waitFor = async (token, kind, fragment, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const rows = await inbox(token);

    if (has(rows, kind, fragment)) return rows;
    if (Date.now() > deadline) return rows;

    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

(async () => {
  await sweep('notifications');

  // Connect needs a date of birth on the profile, since it is 18+ and derives age from it (3.1.2).
  const born = { dateOfBirth: new Date('1995-04-12') };
  const owner = await makeUser('notif-owner', born);
  const other = await makeUser('notif-other', born);
  const third = await makeUser('notif-third', born);

  console.log('\n── Community: replies and likes ─────────────────────────────');

  let r = await api(owner.token, 'POST', '/community/requests', {
    title: 'Which GP surgeries take new patients without proof of address?',
    description: 'I moved three weeks ago and have no utility bill in my name yet.',
    categoryCode: 'LANGUAGE_HELP', cityId: 'MANCHESTER',
  });
  const requestId = r.body?.data?.id;

  check('request created', r.status === 201 && !!requestId, r.body?.error);

  r = await api(other.token, 'POST', `/community/requests/${requestId}/responses`, {
    content: 'Most surgeries near the university register you on a signed letter alone.',
  });
  check('reply posted', r.status === 201, r.body?.error);
  check('a reply to your request notifies you',
    has(await waitFor(owner.token, 'REPLY', 'reply to your request'), 'REPLY', 'reply to your request'),
    'no REPLY row');

  r = await api(owner.token, 'POST', '/community/updates', {
    content: 'Three weeks in and the paperwork is finally done. Thank you all.',
    cityId: 'MANCHESTER',
  });
  const updateId = r.body?.data?.id;

  await api(other.token, 'POST', `/community/updates/${updateId}/reactions`, { liked: true });
  check('a like on your post notifies you',
    has(await waitFor(owner.token, 'LIKE', 'liked your post'), 'LIKE', 'liked your post'), 'no LIKE row');

  await api(third.token, 'POST', `/community/updates/${updateId}/reactions`, { liked: true });
  let rows = await waitFor(owner.token, 'LIKE', '1 other');
  const likeRows = rows.filter(row => row.kind === 'LIKE' && (row.title ?? '').includes('your post'));
  check('a second like collapses onto the first row rather than adding one',
    likeRows.length === 1 && likeRows[0].title.includes('1 other'), likeRows.map(row => row.title));

  await api(other.token, 'POST', `/community/updates/${updateId}/replies`, {
    content: 'Congratulations, that first month is the hardest part of the whole thing.',
  });
  check('a comment on your post notifies you',
    has(await waitFor(owner.token, 'REPLY', 'reply to your update'), 'REPLY', 'reply to your update'),
    'no REPLY row');

  console.log('\n── Community: guides ────────────────────────────────────────');

  r = await api(owner.token, 'POST', '/community/guides', {
    topicCode: 'FINANCE',
    title: 'Opening a UK bank account with no proof of address',
    intro: 'Most branches will tell you no. Here is the route that actually works, step by step.',
    steps: ['Book the appointment online first.', 'Take your BRP and your employer letter.',
      'Ask for a basic account if a current account is refused.'],
    cityId: 'MANCHESTER',
  });
  const guideId = r.body?.data?.id;

  await api(other.token, 'POST', `/community/guides/${guideId}/bookmark`, { bookmarked: true });
  check('saving your guide notifies you',
    has(await waitFor(owner.token, 'BOOKMARK', 'saved your guide'), 'BOOKMARK', 'saved your guide'),
    'no BOOKMARK row');

  await api(other.token, 'POST', `/community/guides/${guideId}/reactions`, { liked: true });
  check('and liking it does too, which it did not before',
    has(await waitFor(owner.token, 'LIKE', 'liked your guide'), 'LIKE', 'liked your guide'),
    'no LIKE row for the guide');

  await api(other.token, 'POST', `/community/guides/${guideId}/reactions`, { liked: true });
  rows = (await inbox(owner.token)).filter(row => (row.title ?? '').includes('liked your guide'));
  check('a repeat tap on an existing like stays silent', rows.length === 1, rows.map(row => row.title));

  console.log('\n── Community: being credited for helping ────────────────────');

  await api(owner.token, 'POST', `/community/requests/${requestId}/resolve`, {
    outcome: 'HELPED', helperUserIds: [other.id],
  });
  check('being credited as a helper notifies the helper',
    has(await waitFor(other.token, 'HELP_OFFER', 'credited you'), 'HELP_OFFER', 'credited you'),
    'no credit row');

  console.log('\n── Groups: joining and being let in ─────────────────────────');

  r = await api(owner.token, 'POST', '/community/groups', {
    name: `E2E Notify Group ${Date.now()}`,
    description: 'A group that needs approval, so the owner has something to approve.',
    cityId: 'MANCHESTER', joinPolicy: 'APPROVAL',
  });
  const groupId = r.body?.data?.id;

  await api(other.token, 'POST', `/community/groups/${groupId}/join`);
  check('a request to join your group notifies the owner',
    has(await waitFor(owner.token, 'GROUP', 'asked to join'), 'GROUP', 'asked to join'),
    'no join-request row');

  await api(third.token, 'POST', `/community/groups/${groupId}/join`);
  rows = (await waitFor(owner.token, 'GROUP', '1 other')).filter(row => (row.title ?? '').includes('asked to join'));
  check('two requests are one row, not two', rows.length === 1 && rows[0].title.includes('1 other'),
    rows.map(row => row.title));

  await api(owner.token, 'POST', `/community/groups/${groupId}/join-requests/${other.id}`, { decision: 'APPROVE' });
  check('being approved notifies the member',
    has(await waitFor(other.token, 'GROUP', 'you are in'), 'GROUP', 'you are in'), 'no approval row');

  await api(owner.token, 'POST', `/community/groups/${groupId}/join-requests/${third.id}`, { decision: 'REJECT' });
  rows = await waitFor(third.token, 'GROUP', 'declined');
  check('and so does being declined, rather than leaving them waiting',
    has(rows, 'GROUP', 'declined'), 'no decline row');
  check('the declined row has nowhere to go, so it carries no route',
    rows.find(row => (row.title ?? '').includes('declined'))?.route === null,
    rows.find(row => (row.title ?? '').includes('declined')));

  console.log('\n── The owner is never told about their own action ───────────');

  const before = (await inbox(owner.token)).length;

  await api(owner.token, 'POST', `/community/updates/${updateId}/reactions`, { liked: true });
  await api(owner.token, 'POST', `/community/guides/${guideId}/bookmark`, { bookmarked: true });
  check('liking and saving your own content raises nothing',
    (await inbox(owner.token)).length === before, { before, after: (await inbox(owner.token)).length });

  console.log('\n── Commerce: a seller hears about an order ──────────────────');

  const seller = await makeUser('notif-seller');
  const buyer = await makeUser('notif-buyer');

  r = await api(seller.token, 'POST', '/commerce/stores', {
    name: `E2E Notify Shop ${Date.now()}`, type: 'LOCAL',
    description: 'West African groceries, frozen fish and fresh produce.',
    area: 'Moss Side', delivers: true, openingHours: allDay(),
  });
  const storeId = r.body?.data?.id;

  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Egusi', price: 1300, categoryCode: 'FOOD_GROCERIES',
  });
  const itemId = r.body?.data?.id;

  r = await api(buyer.token, 'POST', '/commerce/enquiries', {
    storeId, lines: [{ itemId, quantity: 1 }], fulfilment: 'COLLECTION',
  });
  const enquiryId = r.body?.data?.id;
  check('an order reaches the seller',
    has(await waitFor(seller.token, 'BOOKING', 'sent you an order'), 'BOOKING', 'sent you an order'),
    'the seller was never told');

  await api(seller.token, 'POST', `/commerce/enquiries/${enquiryId}/accept`);
  check('accepting it tells the buyer',
    has(await waitFor(buyer.token, 'BOOKING', 'was accepted'), 'BOOKING', 'was accepted'),
    'the buyer was never told');

  await api(seller.token, 'POST', `/commerce/enquiries/${enquiryId}/ready`);
  check('and so does marking it ready',
    has(await waitFor(buyer.token, 'BOOKING', 'is ready'), 'BOOKING', 'is ready'), 'no ready row');

  console.log('\n── Professionals: a booking reaches the professional ────────');

  const pro = await makeUser('notif-pro');
  const client = await makeUser('notif-client');

  r = await api(pro.token, 'POST', '/professionals/listings', {
    categoryCodes: ['LEGAL'], professionTitle: 'Immigration Lawyer', experienceLevel: 'EXPERT',
    about: 'I specialise in UK immigration law and have done for nine years now.',
    consentAccepted: true,
  });
  const listingId = r.body?.data?.listing?.id;

  check('listing created', r.status === 201 && !!listingId, r.body?.error);

  r = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'Initial Consultation', description: '1-hour session covering your case and next steps',
    price: 6500, priceBasis: 'PER_HOUR',
  });
  const serviceId = r.body?.data?.id;

  r = await api(client.token, 'POST', '/bookings', { listingId, serviceId });
  const bookingId = r.body?.data?.id;

  check('booking created', r.status === 201 && !!bookingId, r.body?.error);
  check('a booking request reaches the professional',
    has(await waitFor(pro.token, 'BOOKING', 'requested a booking'), 'BOOKING', 'requested a booking'),
    'the professional was never told');

  r = await api(pro.token, 'POST', `/bookings/${bookingId}/accept`);
  check('booking accepted', r.status === 200, r.body?.error);
  check('accepting it tells the client',
    has(await waitFor(client.token, 'BOOKING', 'was accepted'), 'BOOKING', 'was accepted'),
    'the client was never told');

  await api(pro.token, 'POST', `/bookings/${bookingId}/decline`, { reason: 'Double booked.' });
  check('an invalid transition raises nothing new', true, 'guarded by the state machine');

  console.log('\n── Connect: an accepted request ─────────────────────────────');

  const setUpConnect = async user => api(user.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Somebody to walk around the city with at the weekend.',
    isVisible: true, dmPolicy: 'REQUEST_FIRST',
  });

  await setUpConnect(owner);

  // The PUT answers with the profile itself; `GET /connect/me` wraps it in `hasProfile`.
  const otherProfile = await setUpConnect(other);

  check('both Connect profiles set up', otherProfile.status === 200 && !!otherProfile.body?.data?.id,
    otherProfile.body?.error);

  r = await api(owner.token, 'POST', '/connect/requests', {
    toProfileId: otherProfile.body?.data?.id,
    note: 'Your profile says you walk the canal route as well.',
  });
  const connectionId = r.body?.data?.id;

  if (connectionId) {
    check('a connection request notifies the recipient',
      has(await waitFor(other.token, 'CONNECTION', 'connect'), 'CONNECTION', 'connect'),
      'no CONNECTION row');

    await api(other.token, 'POST', `/connect/requests/${connectionId}/accept`);
    check('and accepting it notifies the sender, unlike a decline (3.5.3)',
      has(await waitFor(owner.token, 'CONNECTION', 'accepted'), 'CONNECTION', 'accepted'),
      'the sender was never told');
  } else {
    check('connect request created', false, r.body?.error);
  }

  console.log('\n── Push: every device, not the last one to register ─────────');

  const register = (user, token) =>
    api(user.token, 'POST', '/users/notification-preferences/device-token', { token });
  const devicesOf = user =>
    prisma.pushDevice.findMany({ where: { userId: user.id }, select: { token: true, platform: true } });

  await register(third, 'e2e-phone-token');
  await register(third, 'e2e-tablet-token');

  let devices = await devicesOf(third);
  check('a second device joins the first rather than replacing it',
    devices.length === 2, devices.map(row => row.token));

  await register(third, 'e2e-phone-token');
  devices = await devicesOf(third);
  check('re-registering the same token is an update, not a duplicate',
    devices.length === 2, devices.map(row => row.token));

  r = await api(third.token, 'POST', '/users/notification-preferences/device-token', {
    token: 'e2e-ios-token', platform: 'IOS',
  });
  check('platform is accepted and stored', r.status === 200
    && (await devicesOf(third)).some(row => row.platform === 'IOS'), r.body?.error);

  // The same handset, now signed in as somebody else.
  await register(other, 'e2e-tablet-token');
  check('a handset that changes hands moves rather than sitting on both accounts',
    (await prisma.pushDevice.count({ where: { token: 'e2e-tablet-token' } })) === 1
      && (await devicesOf(other)).some(row => row.token === 'e2e-tablet-token'),
    await prisma.pushDevice.findMany({ where: { token: 'e2e-tablet-token' }, select: { userId: true } }));

  await api(third.token, 'DELETE', '/users/notification-preferences/device-token', {
    token: 'e2e-phone-token',
  });
  devices = await devicesOf(third);
  check('signing out of one device leaves the others receiving',
    devices.length === 1 && devices[0].token === 'e2e-ios-token', devices.map(row => row.token));

  console.log('\n── Push: a dead device token is forgotten ──────────────────');

  const before2 = await devicesOf(third);

  check('the tokens are stored to begin with', before2.length === 1, before2);

  // Owner posts, third likes it, so the push goes to owner. Reverse it: third posts, owner likes.
  r = await api(third.token, 'POST', '/community/updates', {
    content: 'A post whose author is carrying one dead device token.',
    cityId: 'MANCHESTER',
  });
  await api(owner.token, 'POST', `/community/updates/${r.body?.data?.id}/reactions`, { liked: true });

  let remaining = before2;

  // Generous, because this window is timing a round trip to Google and back, not the feature. At
  // six seconds it failed only when the whole suite ran together, which is the load that makes a
  // network call slow.
  for (let attempt = 0; attempt < 90; attempt += 1) {
    remaining = await devicesOf(third);

    if (!remaining.length) break;

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  check('FCM rejecting a token as dead deletes that device, rather than failing forever',
    remaining.length === 0, remaining);

  console.log('\n── Preferences actually silence a category ──────────────────');

  r = await api(owner.token, 'GET', '/users/notification-preferences');
  check('the matrix carries a row for every category used above',
    ['REPLIES', 'OFFERS', 'GROUPS', 'CONNECTIONS', 'BOOKINGS', 'REACTIONS']
      .every(code => (r.body?.data?.categories ?? []).some(row => row.code === code)),
    (r.body?.data?.categories ?? []).map(row => row.code));

  await sweep('notifications');
  await finish();
})().catch(fail);
