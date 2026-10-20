/* "Let Circl handle it" — managed service requests, end to end.
 *
 * The member describes a problem, staff read it and offer it to professionals they judged
 * suitable, and up to three of them introduce themselves. The parts worth checking hard are the
 * ones that leak or double up if they are wrong:
 *
 *  - the member never learns who was asked, and the professional never learns who is asking;
 *  - three acceptances is a cap enforced in the database, not a number the client is trusted with;
 *  - REVOKED is not DECLINED, because one of those says a professional turned work down;
 *  - the introduction is posted once, by the server, in the professional's name.
 */
const {
  adminHeaders,
  api,
  approveListing,
  check,
  fail,
  fieldNames,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

const listingFor = async (user, title, categoryCode) => {
  const made = await api(user.token, 'POST', '/professionals/listings', {
    categoryCodes: [categoryCode],
    professionTitle: title,
    experienceLevel: 'EXPERT',
    about: 'I build and fix websites for small businesses, and I answer the phone.',
    cityId: 'MANCHESTER',
    deliveryMode: 'BOTH',
    consentAccepted: true,
  });

  return made.body?.data?.listing?.id ?? null;
};

/**
 * A professional who is findable and taking work.
 *
 * The listing is approved on the way out, because the regulated professions hold theirs until a
 * staff member decides — and a suite about offering work wants a reachable professional, not an
 * approval workflow.
 */
const professional = async (tag, title, categoryCode = 'TECH_SOFTWARE') => {
  const user = await makeUser(tag, { cityId: 'MANCHESTER' });
  const listingId = await listingFor(user, title, categoryCode);

  await approveListing(listingId);

  return { ...user, listingId };
};

/** An approved verification in a category, live or lapsed. */
const verify = (userId, categoryCode, { lapsed = false } = {}) =>
  prisma.categoryVerification.create({
    data: {
      userId,
      categoryCode,
      status: 'APPROVED',
      submittedForSubcategories: [],
      decidedAt: new Date(lapsed ? Date.now() - 400 * 24 * 3600 * 1000 : Date.now()),
      expiresAt: new Date(
        lapsed ? Date.now() - 30 * 24 * 3600 * 1000 : Date.now() + 365 * 24 * 3600 * 1000,
      ),
    },
  });

const submit = async (member, body) => {
  const made = await api(member.token, 'POST', '/professionals/service-requests', body);

  return { status: made.status, data: made.body?.data, error: made.body?.error };
};

(async () => {
  await sweep();

  const member = await makeUser('sr-member', { cityId: 'MANCHESTER' });
  const stranger = await makeUser('sr-stranger');
  const staff = await makeAdmin('sr-staff');

  const [alice, bob, carol, dave] = await Promise.all([
    professional('sr-alice', 'Web developer'),
    professional('sr-bob', 'Accountant for sole traders'),
    professional('sr-carol', 'Copywriter'),
    professional('sr-dave', 'Photographer'),
  ]);

  console.log('\n── Submitting ───────────────────────────────────────────────');

  let r = await submit(member, {});
  check('description is required', r.status === 400 || r.status === 422, r.status);

  r = await submit(member, {
    description: 'My landlord is keeping my deposit and will not say why.',
  });
  const request = r.data;

  check('a description alone is enough', r.status === 201, { s: r.status, e: r.error });
  check('it starts as SUBMITTED', request?.status === 'SUBMITTED', request?.status);
  check(
    'no category is not an error — it is the point of the feature',
    request?.category === null,
    request?.category,
  );
  check(
    'the city comes from their profile, unasked',
    request?.city?.id === 'MANCHESTER',
    request?.city,
  );
  check('nobody has responded yet', Array.isArray(request?.responders) && !request.responders.length, request?.responders);

  r = await submit(member, {
    description: 'I need somebody to look at my accounts before the deadline.',
    urgency: 'ASAP',
    budget: 15000,
    categoryCode: 'TECH_SOFTWARE',
  });
  const urgent = r.data;

  check('a figure in pence travels', urgent?.budget?.amount === 15000, urgent?.budget);
  check('so does the member’s own guess', urgent?.category?.code === 'TECH_SOFTWARE', urgent?.category);

  r = await submit(member, {
    description: 'Someone to translate two documents.',
    budgetText: '50-100',
  });

  check(
    'a budget that is not a figure travels as words — "50-100" is not £50,100',
    r.data?.budgetText === '50-100' && r.data?.budget === null,
    { text: r.data?.budgetText, figure: r.data?.budget },
  );

  r = await submit(member, { description: 'x', categoryCode: 'NOT_A_REAL_CATEGORY' });
  check('an unknown category is refused', r.status === 422 || r.status === 400, r.status);

  console.log('\n── Their own list ───────────────────────────────────────────');

  r = await api(member.token, 'GET', '/professionals/service-requests');
  check('the list is theirs, newest first', r.status === 200 && r.body?.data?.length === 3, {
    s: r.status,
    n: r.body?.data?.length,
  });
  check(
    'newest first means newest first',
    r.body?.data?.[0]?.description.startsWith('Someone to translate'),
    r.body?.data?.[0]?.description,
  );

  r = await api(stranger.token, 'GET', `/professionals/service-requests/${request.id}`);
  check('somebody else’s request is not found, not forbidden', r.status === 404, r.status);

  console.log('\n── The queue ────────────────────────────────────────────────');

  r = await api(staff, 'GET', '/admin/service-requests', null, adminHeaders(staff));
  const queue = r.body?.data ?? [];
  const queued = queue.find(row => row.id === request.id);

  check('staff see it', r.status === 200 && !!queued, { s: r.status, n: queue.length });
  check(
    'the member’s words arrive in full, never truncated',
    queued?.description === 'My landlord is keeping my deposit and will not say why.',
    queued?.description,
  );
  check('and the member with them', !!queued?.member?.id, queued?.member);

  r = await api(
    staff,
    'GET',
    '/admin/service-requests?sort=urgency&perPage=100',
    null,
    adminHeaders(staff),
  );
  const order = (r.body?.data ?? []).map(row => row.urgency);
  const rank = ['ASAP', 'THIS_WEEK', 'THIS_MONTH', 'FLEXIBLE'];

  check(
    'the queue can be worked most urgent first',
    r.status === 200 && order.every((u, i) => i === 0 || rank.indexOf(u) >= rank.indexOf(order[i - 1])),
    order,
  );

  r = await api(staff, 'GET', '/admin/service-requests?sort=nonsense', null, adminHeaders(staff));
  check('and cannot be sorted by a column it does not offer', r.status === 400, r.status);

  r = await api(
    staff,
    'GET',
    '/admin/service-requests?uncategorised=true',
    null,
    adminHeaders(staff),
  );
  check(
    'the first pass is the ones nobody has categorised',
    (r.body?.data ?? []).some(row => row.id === request.id),
    r.body?.data?.length,
  );

  r = await api(
    staff,
    'PATCH',
    `/admin/service-requests/${request.id}/category`,
    { categoryCode: 'TECH_SOFTWARE' },
    adminHeaders(staff),
  );

  check('staff decide the category', r.status === 200, { s: r.status, e: r.body?.error });
  check(
    'Circl’s decision and the member’s guess are kept apart',
    r.body?.data?.category?.code === 'TECH_SOFTWARE' && r.body?.data?.memberCategory === null,
    { circl: r.body?.data?.category, member: r.body?.data?.memberCategory },
  );

  console.log('\n── Finding somebody ─────────────────────────────────────────');

  r = await api(
    staff,
    'GET',
    `/admin/service-requests/${request.id}/professionals`,
    null,
    adminHeaders(staff),
  );
  const candidates = r.body?.data ?? [];

  check('the search answers', r.status === 200 && candidates.length >= 4, {
    s: r.status,
    n: candidates.length,
  });
  check(
    'the member themselves is never a candidate',
    !candidates.some(row => row.professionalId === member.id),
    candidates.map(row => row.professionalId),
  );
  check(
    'nobody has been offered it yet',
    candidates.every(row => row.offerStatus === null),
    candidates.map(row => row.offerStatus),
  );

  r = await api(
    staff,
    'GET',
    `/admin/service-requests/${request.id}/professionals?q=Accountant`,
    null,
    adminHeaders(staff),
  );
  check(
    'searching matches a listing title',
    (r.body?.data ?? []).some(row => row.professionalId === bob.id),
    r.body?.data?.map(row => row.professionTitle),
  );

  console.log('\n── Regulated work ───────────────────────────────────────────');

  /* Gating lives on subcategories, not professions: `HEALTHCARE` carries no flag and its
   * `HEALTH_DOCTOR` and six siblings do. Reading the profession's own metadata made
   * "regulated work" a fact that was false everywhere, including Immigration and Legal.
   *
   * It is shown, not enforced (product owner, 20 Oct): a request names a profession at most, so
   * there is no honest way to tell whether this particular job is the regulated kind, and
   * filtering the profession hid every unverified tradesperson from a request about a dripping
   * tap. */
  const [adviser, licensed, lapsed] = await Promise.all([
    professional('sr-adviser', 'Immigration adviser', 'IMMIGRATION'),
    professional('sr-licensed', 'IAA-registered adviser', 'IMMIGRATION'),
    professional('sr-lapsed', 'Immigration paperwork help', 'IMMIGRATION'),
  ]);

  await verify(licensed.id, 'IMMIGRATION');
  await verify(lapsed.id, 'IMMIGRATION', { lapsed: true });

  const regulated = (await submit(member, { description: 'I need help with a visa refusal.' })).data;

  await api(
    staff,
    'PATCH',
    `/admin/service-requests/${regulated.id}/category`,
    { categoryCode: 'IMMIGRATION' },
    adminHeaders(staff),
  );

  r = await api(
    staff,
    'GET',
    `/admin/service-requests/${regulated.id}/professionals?perPage=100`,
    null,
    adminHeaders(staff),
  );
  const found = r.body?.data ?? [];
  const rowFor = who => found.find(row => row.professionalId === who.id);

  check(
    'a profession with regulated work in it is flagged as such',
    r.body?.meta?.hasRegulatedWork === true,
    r.body?.meta,
  );
  check(
    'an unverified professional is still listed, not hidden',
    !!rowFor(adviser),
    found.map(row => row.professionTitle),
  );
  check(
    'with the fact staff judge on, rather than a filter applied for them',
    rowFor(adviser)?.verifiedInCategory === false,
    rowFor(adviser),
  );
  check(
    'somebody with a live approval reads as verified',
    rowFor(licensed)?.verifiedInCategory === true,
    rowFor(licensed),
  );
  check(
    'and an approval that lapsed last month does not',
    rowFor(lapsed)?.verifiedInCategory === false,
    rowFor(lapsed),
  );

  r = await api(
    staff,
    'POST',
    `/admin/service-requests/${regulated.id}/offers`,
    { professionalIds: [adviser.id] },
    adminHeaders(staff),
  );
  check(
    'and the offer goes through — the staff member made the call',
    r.status === 201 && r.body?.data?.offered === 1,
    { s: r.status, e: r.body?.error },
  );

  r = await api(
    staff,
    'GET',
    `/admin/service-requests/${request.id}/professionals`,
    null,
    adminHeaders(staff),
  );
  check(
    'while a profession with no regulated work says so',
    r.body?.meta?.hasRegulatedWork === false,
    r.body?.meta,
  );
  check(
    'and nobody is marked verified in it',
    (r.body?.data ?? []).every(row => row.verifiedInCategory === false),
    (r.body?.data ?? []).map(row => row.verifiedInCategory),
  );

  console.log('\n── Offering it ──────────────────────────────────────────────');

  r = await api(
    staff,
    'POST',
    `/admin/service-requests/${request.id}/offers`,
    { professionalIds: [alice.id, bob.id, carol.id, dave.id] },
    adminHeaders(staff),
  );

  check('four professionals are asked', r.status === 201 && r.body?.data?.offered === 4, {
    s: r.status,
    offered: r.body?.data?.offered,
    e: r.body?.error,
  });
  check('the request is now matching', r.body?.data?.state === 'MATCHING', r.body?.data?.state);

  r = await api(
    staff,
    'POST',
    `/admin/service-requests/${request.id}/offers`,
    { professionalIds: [alice.id] },
    adminHeaders(staff),
  );
  check(
    'offering twice does not send a second offer',
    r.status === 201 && r.body?.data?.offered === 0,
    r.body?.data?.offered,
  );

  const buzzed = await prisma.notification.count({
    where: {
      userId: alice.id,
      kind: 'SERVICE_REQUEST',
      metadata: { path: ['serviceRequestId'], equals: request.id },
    },
  });

  check('and does not buzz them about it again', buzzed === 1, buzzed);

  r = await api(
    staff,
    'POST',
    `/admin/service-requests/${request.id}/offers`,
    { professionalIds: [member.id] },
    adminHeaders(staff),
  );
  check(
    'the member cannot be offered their own request',
    r.status === 422,
    { s: r.status, e: r.body?.error },
  );

  const closedBooks = await professional('sr-closed', 'Electrician');

  await api(
    closedBooks.token,
    'PATCH',
    `/professionals/listings/${closedBooks.listingId}/availability`,
    { isAcceptingWork: false },
  );

  r = await api(
    staff,
    'POST',
    `/admin/service-requests/${request.id}/offers`,
    { professionalIds: [closedBooks.id] },
    adminHeaders(staff),
  );
  check(
    'somebody who has closed their books is not sent work',
    r.status === 422,
    { s: r.status, e: r.body?.error },
  );

  const suspended = await professional('sr-suspended', 'Plumber');

  await prisma.user.update({ where: { id: suspended.id }, data: { status: 'SUSPENDED' } });

  r = await api(
    staff,
    'POST',
    `/admin/service-requests/${request.id}/offers`,
    { professionalIds: [suspended.id] },
    adminHeaders(staff),
  );
  check(
    'and neither can somebody Circl has suspended',
    r.status === 422,
    { s: r.status, e: r.body?.error },
  );

  r = await api(member.token, 'GET', `/professionals/service-requests/${request.id}`);
  check('the member sees that offers are out', r.body?.data?.status === 'MATCHING', r.body?.data?.status);
  check(
    'and never how many people were asked',
    !fieldNames(r.body?.data).some(name => /offer|asked|candidate/i.test(name)),
    fieldNames(r.body?.data).filter(name => /offer|asked|candidate/i.test(name)),
  );

  console.log('\n── The professional’s inbox ─────────────────────────────────');

  r = await api(alice.token, 'GET', '/professionals/me/service-request-offers');
  const offers = r.body?.data ?? [];
  const offer = offers.find(row => row.request?.id === request.id);

  check('the offer is there', r.status === 200 && !!offer, { s: r.status, n: offers.length });
  check('it is waiting for an answer', offer?.status === 'PENDING', offer?.status);
  check(
    'the request carries its city, which is how you judge an offer',
    offer?.request?.city?.id === 'MANCHESTER',
    offer?.request?.city,
  );
  check(
    'but the member is not named, and nothing about them travels',
    !fieldNames(offer).some(name => /member|user|email|responder/i.test(name)),
    fieldNames(offer).filter(name => /member|user|email|responder/i.test(name)),
  );

  /* The notification a professional is sent has to open something they are allowed to read. The
   * request is the member's: it answers 404 to everybody else, so targeting it would land them on
   * a screen they cannot have. Their own offer is the thing that is theirs. */
  const offered = await prisma.notification.findFirst({
    where: { userId: alice.id, kind: 'SERVICE_REQUEST' },
    orderBy: { createdAt: 'desc' },
    select: { title: true, metadata: true, route: true },
  });

  check(
    'the professional was told there is work',
    offered?.title === 'Circl has a request for you',
    offered?.title,
  );
  check(
    'and it points at their own offer, not at the member’s request',
    offered?.metadata?.target?.type === 'SERVICE_REQUEST_OFFER' &&
      offered?.metadata?.target?.id === offer.id,
    offered?.metadata,
  );

  r = await api(alice.token, 'GET', `/professionals/service-requests/${request.id}`);
  check(
    'which matters, because the request itself is not theirs to read',
    r.status === 404,
    r.status,
  );

  console.log('\n── Taking it on ─────────────────────────────────────────────');

  r = await api(alice.token, 'POST', `/professionals/me/service-request-offers/${offer.id}/accept`);
  const accepted = r.body?.data;

  check('accepting answers 200', r.status === 200, { s: r.status, e: r.body?.error });
  check('with the thread already open', !!accepted?.conversationId, accepted);

  const intro = await prisma.message.findMany({
    where: { conversationId: accepted.conversationId },
    select: { senderId: true, body: true, kind: true },
  });

  check('the server wrote the introduction, not the app', intro.length === 1, intro.length);
  check('and wrote it in the professional’s name', intro[0]?.senderId === alice.id, intro[0]?.senderId);
  check(
    'two sentences, naming who they are and why they are writing',
    intro[0]?.body?.includes('Web developer') && intro[0]?.body?.includes('Circl passed me'),
    intro[0]?.body,
  );
  check(
    'it promises nothing about price and claims no vetting',
    !/£|price|cost|vetted|approved/i.test(intro[0]?.body ?? ''),
    intro[0]?.body,
  );

  const unread = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: accepted.conversationId, userId: member.id } },
    select: { unreadCount: true },
  });

  check('the member has it unread', unread?.unreadCount === 1, unread);

  r = await api(alice.token, 'POST', `/professionals/me/service-request-offers/${offer.id}/accept`);
  check(
    'accepting twice is not an error — the same thread comes back',
    r.status === 200 && r.body?.data?.conversationId === accepted.conversationId,
    { s: r.status, id: r.body?.data?.conversationId },
  );

  const again = await prisma.message.count({ where: { conversationId: accepted.conversationId } });

  check('and does not introduce them twice', again === 1, again);

  r = await api(member.token, 'GET', `/professionals/service-requests/${request.id}`);
  check('the member sees somebody took it on', r.body?.data?.status === 'MATCHED', r.body?.data?.status);
  check(
    'with a way into the conversation',
    r.body?.data?.responders?.[0]?.conversationId === accepted.conversationId,
    r.body?.data?.responders,
  );
  check(
    'and who they are',
    r.body?.data?.responders?.[0]?.headline === 'Web developer',
    r.body?.data?.responders?.[0],
  );

  console.log('\n── Two devices, one tap ─────────────────────────────────────');

  /* The case §4 of the contract is about: two devices tapping Accept on the same offer at the
   * same moment. The status check cannot be the only guard — both calls pass it — so the offer is
   * re-read inside the lock. What must not happen is a member being introduced to the same
   * professional twice. */
  const raceRequest = (await submit(member, { description: 'A leaking tap in the bathroom.' })).data;

  await api(
    staff,
    'POST',
    `/admin/service-requests/${raceRequest.id}/offers`,
    { professionalIds: [carol.id] },
    adminHeaders(staff),
  );

  const raceOffer = await (async () => {
    const inbox = await api(carol.token, 'GET', '/professionals/me/service-request-offers');

    return (inbox.body?.data ?? []).find(row => row.request?.id === raceRequest.id);
  })();

  const [first, second] = await Promise.all([
    api(carol.token, 'POST', `/professionals/me/service-request-offers/${raceOffer.id}/accept`),
    api(carol.token, 'POST', `/professionals/me/service-request-offers/${raceOffer.id}/accept`),
  ]);

  check(
    'both calls answer, neither with an error',
    first.status === 200 && second.status === 200,
    { first: first.status, second: second.status },
  );
  check(
    'and on the same thread',
    first.body?.data?.conversationId &&
      first.body?.data?.conversationId === second.body?.data?.conversationId,
    { first: first.body?.data?.conversationId, second: second.body?.data?.conversationId },
  );

  const raceMessages = await prisma.message.count({
    where: { conversationId: first.body?.data?.conversationId },
  });

  check('the member is introduced once, not twice', raceMessages === 1, raceMessages);

  const raceNotices = await prisma.notification.count({
    where: { userId: member.id, kind: 'SERVICE_REQUEST', metadata: { path: ['serviceRequestId'], equals: raceRequest.id } },
  });

  check('and told once, not twice', raceNotices === 1, raceNotices);

  console.log('\n── The cap ──────────────────────────────────────────────────');

  const offerFor = async pro => {
    const inbox = await api(pro.token, 'GET', '/professionals/me/service-request-offers');

    return (inbox.body?.data ?? []).find(row => row.request?.id === request.id);
  };

  const bobOffer = await offerFor(bob);
  const carolOffer = await offerFor(carol);
  const daveOffer = await offerFor(dave);

  r = await api(bob.token, 'POST', `/professionals/me/service-request-offers/${bobOffer.id}/accept`);
  check('a second professional may take it on', r.status === 200, r.status);

  r = await api(
    carol.token,
    'POST',
    `/professionals/me/service-request-offers/${carolOffer.id}/accept`,
  );
  check('and a third', r.status === 200, r.status);

  r = await api(
    dave.token,
    'POST',
    `/professionals/me/service-request-offers/${daveOffer.id}/accept`,
  );
  check('the fourth is refused', r.status === 409, { s: r.status, e: r.body?.error });
  check(
    'with the code the app already handles',
    r.body?.error?.code === 'SERVICE_REQUEST_FILLED',
    r.body?.error,
  );

  r = await api(dave.token, 'GET', '/professionals/me/service-request-offers');
  const daveRow = (r.body?.data ?? []).find(row => row.request?.id === request.id);

  check(
    'their offer reads as withdrawn, not as work they turned down',
    daveRow?.status === 'REVOKED',
    daveRow?.status,
  );
  check('and it stays in their list rather than vanishing', !!daveRow, r.body?.data?.length);

  r = await api(member.token, 'GET', `/professionals/service-requests/${request.id}`);
  check('the member sees three responders, not four', r.body?.data?.responders?.length === 3, {
    n: r.body?.data?.responders?.length,
  });

  console.log('\n── Declining, and withdrawing ───────────────────────────────');

  r = await api(
    staff,
    'POST',
    `/admin/service-requests/${urgent.id}/offers`,
    { professionalIds: [alice.id, bob.id] },
    adminHeaders(staff),
  );
  check('a second request is offered out', r.status === 201, r.status);

  const urgentOffer = await (async () => {
    const inbox = await api(alice.token, 'GET', '/professionals/me/service-request-offers');

    return (inbox.body?.data ?? []).find(row => row.request?.id === urgent.id);
  })();

  r = await api(
    alice.token,
    'POST',
    `/professionals/me/service-request-offers/${urgentOffer.id}/decline`,
  );
  check('passing on one answers 200', r.status === 200 && r.body?.data?.status === 'DECLINED', {
    s: r.status,
    status: r.body?.data?.status,
  });

  r = await api(member.token, 'POST', `/professionals/service-requests/${urgent.id}/cancel`);
  check('the member may withdraw while nobody has written', r.status === 200, {
    s: r.status,
    e: r.body?.error,
  });
  check('it reads as withdrawn', r.body?.data?.status === 'CANCELLED', r.body?.data?.status);

  const leftOver = await prisma.serviceRequestOffer.findMany({
    where: { requestId: urgent.id },
    select: { status: true },
  });

  check(
    'withdrawing takes back every offer still waiting',
    !leftOver.some(row => row.status === 'PENDING'),
    leftOver.map(row => row.status),
  );

  r = await api(member.token, 'POST', `/professionals/service-requests/${request.id}/cancel`);
  check(
    'but not once somebody has written — that is a conversation now',
    r.status === 409,
    { s: r.status, e: r.body?.error },
  );

  console.log('\n── The outcome ──────────────────────────────────────────────');

  const quiet = (
    await submit(member, { description: 'I need a certified Portuguese translator.' })
  ).data;

  r = await api(
    staff,
    'POST',
    `/admin/service-requests/${request.id}/outcome`,
    { outcome: 'NONE', note: 'Nobody available.' },
    adminHeaders(staff),
  );
  check(
    '"nobody available" cannot be sent once somebody has taken it on',
    r.status === 422 && r.body?.data?.accepted === 3,
    { s: r.status, e: r.body?.error },
  );

  r = await api(
    staff,
    'POST',
    `/admin/service-requests/${quiet.id}/outcome`,
    { outcome: 'FOUND' },
    adminHeaders(staff),
  );
  check(
    '"we found people" with nobody found is refused',
    r.status === 422,
    { s: r.status, e: r.body?.error },
  );

  r = await api(
    staff,
    'POST',
    `/admin/service-requests/${quiet.id}/outcome`,
    {
      outcome: 'NONE',
      note: 'Nobody in Manchester offers certified Portuguese translation yet. We have asked two agencies.',
    },
    adminHeaders(staff),
  );
  check('"nobody available" is a first-class outcome', r.status === 200, {
    s: r.status,
    e: r.body?.error,
  });
  check('it closes the request', r.body?.data?.state === 'NO_MATCH', r.body?.data?.state);

  r = await api(member.token, 'GET', `/professionals/service-requests/${quiet.id}`);
  check('the member is told, in Circl’s own words', r.body?.data?.note?.startsWith('Nobody in Manchester'), r.body?.data?.note);
  check('and the status says so', r.body?.data?.status === 'NO_MATCH', r.body?.data?.status);

  const told = await prisma.notification.findFirst({
    where: { userId: member.id, kind: 'SERVICE_REQUEST' },
    orderBy: { createdAt: 'desc' },
    select: { title: true, metadata: true, route: true },
  });

  check('a notification went with it', !!told, told);
  check(
    'the one that matters most is the one that says nobody was found',
    told?.title?.includes('could not find'),
    told?.title,
  );

  r = await api(
    staff,
    'POST',
    `/admin/service-requests/${quiet.id}/offers`,
    { professionalIds: [alice.id] },
    adminHeaders(staff),
  );
  check(
    'offering a closed request to somebody new is how it reopens',
    r.status === 201 && r.body?.data?.state === 'MATCHING',
    { s: r.status, state: r.body?.data?.state, e: r.body?.error },
  );

  r = await api(member.token, 'GET', `/professionals/service-requests/${quiet.id}`);
  check(
    'and the member sees it is being looked at again',
    r.body?.data?.status === 'MATCHING',
    r.body?.data?.status,
  );

  r = await api(
    staff,
    'POST',
    `/admin/service-requests/${urgent.id}/offers`,
    { professionalIds: [alice.id] },
    adminHeaders(staff),
  );
  check(
    'but a request the member withdrew is not reopened over their head',
    r.status === 409,
    { s: r.status, e: r.body?.error },
  );

  console.log('\n── Offers nobody answered ───────────────────────────────────');

  const stale = (await submit(member, { description: 'Someone to clear a blocked drain.' })).data;

  await api(
    staff,
    'POST',
    `/admin/service-requests/${stale.id}/offers`,
    { professionalIds: [dave.id] },
    adminHeaders(staff),
  );

  await prisma.serviceRequestOffer.updateMany({
    where: { requestId: stale.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });

  r = await api(
    staff,
    'POST',
    '/admin/jobs/service-request-offers.expire/run',
    {},
    adminHeaders(staff),
  );
  check('the sweep runs', r.status === 200 || r.status === 202, { s: r.status, e: r.body?.error });

  const swept = await prisma.serviceRequestOffer.findMany({
    where: { requestId: stale.id },
    select: { status: true },
  });

  check('an unanswered offer lapses', swept[0]?.status === 'EXPIRED', swept);

  r = await api(dave.token, 'GET', '/professionals/me/service-request-offers');
  const expired = (r.body?.data ?? []).find(row => row.request?.id === stale.id);

  check('the professional sees it as expired', expired?.status === 'EXPIRED', expired?.status);

  r = await api(
    dave.token,
    'POST',
    `/professionals/me/service-request-offers/${expired.id}/accept`,
  );
  check('and cannot answer it afterwards', r.status === 409, r.status);

  await finish();
})().catch(fail);
