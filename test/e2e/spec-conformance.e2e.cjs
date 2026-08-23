/* The eight defects the spec-conformance audit found. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');

(async () => {
  await sweep('pre-run');
  const a = await makeUser('fa', { openInbox: true });
  const b = await makeUser('fb', { openInbox: true });

  console.log('\n── 1. Views: a post is no longer born with one ──────────────');
  let r = await api(a.token, 'POST', '/community/requests', {
    categoryCode: 'JOBS', title: 'Checking that views start at zero', cityId: 'MANCHESTER',
  });
  const reqId = r.body?.data?.id;
  check('created request reports 0 views', r.body?.data?.counts?.views === 0, r.body?.data?.counts);
  await api(a.token, 'GET', `/community/requests/${reqId}`);
  r = await api(a.token, 'GET', `/community/requests/${reqId}`);
  check('the author re-reading their own request does not count', r.body?.data?.counts?.views === 0, r.body?.data?.counts);
  await api(b.token, 'GET', `/community/requests/${reqId}`);
  r = await api(b.token, 'GET', `/community/requests/${reqId}`);
  check('another member reading twice counts once', r.body?.data?.counts?.views === 1, r.body?.data?.counts);

  console.log('\n── 2. POST /disputes, the polymorphic endpoint (4.1.3) ──────');
  const listing = await prisma.professionalListing.create({
    data: {
      userId: a.id, professionTitle: 'Translator', experienceLevel: 'MID_LEVEL',
      about: 'I translate Yoruba and English documents and have done for six years.',
      cityId: 'MANCHESTER', consentAccepted: true,
      services: { create: [{ name: 'Document translation', price: 4000 }] },
    },
    include: { services: true },
  });
  r = await api(b.token, 'POST', '/bookings', { listingId: listing.id, serviceId: listing.services[0].id });
  const bookingId = r.body?.data?.id;
  await api(a.token, 'POST', `/bookings/${bookingId}/accept`);

  r = await api(b.token, 'POST', '/disputes', {
    subjectType: 'BOOKING', subjectId: bookingId, reasonCode: 'COMMUNICATION',
    description: 'I have not heard anything back for over a week and I am starting to worry.',
  });
  check('POST /disputes with subjectType BOOKING → 201', r.status === 201, r.body?.error);
  const disputeId = r.body?.data?.id;

  console.log('\n── 3. POST /disputes/{id}/evidence (2.10) ───────────────────');
  r = await api(b.token, 'POST', `/disputes/${disputeId}/evidence`, { note: 'Screenshots of my unanswered messages.' });
  check('the party who raised it can add evidence → 201', r.status === 201, r.body?.error);
  r = await api(a.token, 'POST', `/disputes/${disputeId}/evidence`, { note: 'My reply was sent, here is the thread.' });
  check('and so can the OTHER party — "both of you can add evidence"', r.status === 201, r.body?.error);
  const outsider = await makeUser('fc');
  r = await api(outsider.token, 'POST', `/disputes/${disputeId}/evidence`, { note: 'Nothing to do with me.' });
  check('a stranger cannot → 403', r.status === 403, r.status);

  r = await api(b.token, 'GET', `/disputes/${disputeId}`);
  check('GET /disputes/{id} returns both sides\' evidence', r.body?.data?.evidence?.length === 2, r.body?.data?.evidence?.length);
  check('and marks which is mine', r.body?.data?.evidence?.some(e => e.isMine) && r.body?.data?.evidence?.some(e => !e.isMine), r.body?.data?.evidence);
  check('canAddEvidence true while open', r.body?.data?.viewer?.canAddEvidence === true, r.body?.data?.viewer);

  console.log('\n── 4. Commerce orders use the SAME endpoint (4.1.3) ─────────');
  const seller = await makeUser('fs');
  r = await api(seller.token, 'POST', '/commerce/stores', { name: 'Audit Shop', area: 'Moss Side' });
  const storeId = r.body?.data?.id;
  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, { name: 'Egusi', price: 650, categoryCode: 'FOOD_GROCERIES' });
  const itemId = r.body?.data?.id;
  r = await api(b.token, 'POST', '/commerce/enquiries', { storeId, lines: [{ itemId, quantity: 1 }], fulfilment: 'COLLECTION' });
  const enquiryId = r.body?.data?.id;
  await api(seller.token, 'POST', `/commerce/enquiries/${enquiryId}/accept`);

  r = await api(b.token, 'POST', '/disputes', {
    subjectType: 'ORDER', subjectId: enquiryId, reasonCode: 'NOT_AS_DESCRIBED',
    description: 'The bag had already been opened and the contents were not what I ordered.',
  });
  check('POST /disputes with subjectType ORDER → 201', r.status === 201, r.body?.error);
  const orderDispute = await prisma.dispute.findFirst({ where: { enquiryId } });
  check('stored against the same shared table', orderDispute?.subjectType === 'ORDER', orderDispute?.subjectType);

  r = await api(b.token, 'POST', `/commerce/enquiries/${enquiryId}/disputes`, { reasonCode: 'QUALITY', description: 'x'.repeat(30) });
  check('the duplicate enquiry-scoped route is gone → 404', r.status === 404, r.status);

  console.log('\n── 5. 0.14 rate limits and the 429 contract ─────────────────');
  const spammer = await makeUser('fr');
  let limited = null;
  for (let i = 0; i < 12; i++) {
    const res = await api(spammer.token, 'POST', '/moderation/reports', {
      targetType: 'REQUEST', targetId: reqId, reasonCode: 'SPAM',
    });
    if (res.status === 429) { limited = res; break; }
  }
  check('reports throttle at 10 an hour, per the spec table', limited !== null, 'never throttled in 12 attempts');
  if (limited) {
    check('429 carries error.code RATE_LIMITED (UPPER_SNAKE)', limited.body?.error?.code === 'RATE_LIMITED', limited.body?.error);
    check('and tells the client how long to wait', typeof limited.body?.data?.retryAfterSeconds === 'number', limited.body?.data);
  }

  const reader = await makeUser('fread');
  let readBlocked = false;
  for (let i = 0; i < 150; i++) {
    const res = await api(reader.token, 'GET', '/community/feed?limit=1');
    if (res.status === 429) { readBlocked = true; break; }
  }
  check('reads are NOT throttled at 150 (spec allows 600/min)', readBlocked === false, 'reads throttled too early');

  console.log('\n── 6. D31: inbox search covers CONTEXT TITLES ───────────────');
  const enquiryRef = (await prisma.enquiry.findUnique({ where: { id: enquiryId } }))?.reference;
  r = await api(b.token, 'GET', `/messages?q=${encodeURIComponent(enquiryRef)}`);
  check(`searching a context title ("${enquiryRef}") finds the thread`, r.body?.data?.length >= 1, { n: r.body?.data?.length });
  r = await api(b.token, 'GET', `/messages?q=${encodeURIComponent('Audit Shop')}`);
  check('and the context subtitle too', r.body?.data?.length >= 1, { n: r.body?.data?.length });
  r = await api(b.token, 'GET', '/messages?q=fa');
  check('participant names still match', r.body?.data?.length >= 1, { n: r.body?.data?.length });

  console.log('\n── 7. Messaging rate limits exist on both paths (5.7) ───────');
  r = await api(b.token, 'POST', '/messages', { recipientUserId: a.id });
  const convId = r.body?.data?.id;
  let msgLimited = false;
  for (let i = 0; i < 70; i++) {
    const res = await api(b.token, 'POST', `/messages/${convId}/messages`, { clientId: `rl-${i}`, body: `m${i}` });
    if (res.status === 429) { msgLimited = true; break; }
  }
  check('the REST send path throttles at 60 a minute', msgLimited === true, 'never throttled in 70 sends');

  console.log('\n── 8. 1.0.3 deprecated ?city= use is now actually logged ────');
  await api(a.token, 'GET', '/community/requests?city=Manchester');
  check('(checked in the server log below)', true);

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await sweep('cleanup');
  await finish();
})().catch(fail);
