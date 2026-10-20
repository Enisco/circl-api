/**
 * §5.16 and §5.17 — the support pipeline, and the disagreements.
 *
 * Two sections in one suite because they share the shape of the thing being tested: a queue with
 * somebody's name on each row, an ending that has to be recorded as more than "done", and a member
 * on the other side who has to be told. Most of the assertions are about that last part.
 *
 * The rule the dispute half exists to protect: **Circl never moves money.** A resolution is a
 * finding, and the suite checks the finding reaches both parties — because a finding told to one of
 * them is half a resolution.
 */
const {
  adminHeaders,
  api,
  approveListing,
  check,
  clearRateLimits,
  fail,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
  uploadPng,
} = require('./harness.cjs');

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const key = () => ({ 'Idempotency-Key': `md-${Math.random().toString(36).slice(2)}` });

const register = async (label, codes) => {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const permissions = await prisma.permission.findMany({ where: { code: { in: codes } } });

  if (permissions.length !== codes.length) {
    throw new Error(
      `role ${label}: unknown permission(s) ${codes
        .filter(wanted => !permissions.some(row => row.code === wanted))
        .join(', ')}`,
    );
  }

  const role = await prisma.role.create({
    data: {
      name: `E2E managed ${label} ${stamp}`,
      code: `e2e-md-${label}-${stamp}`,
      isSystem: false,
      isAdmin: true,
      rolePermissions: { create: permissions.map(permission => ({ permissionId: permission.id })) },
    },
  });

  return role.code;
};

async function main() {
  await sweep('pre-run');
  await clearRateLimits();

  const leadRole = await register('lead', [
    'support:read',
    'support:manage',
    'managed:manage',
    'disputes:manage',
    'moderation:assign',
    'members:read',
    // For `linkable-cases`, which is what a grant's reason is chosen from (S9.1).
    'messages:read',
  ]);
  // Support's own shape: they read the pipeline and cannot act on it.
  const agentRole = await register('agent', ['support:read', 'members:read']);

  const lead = await makeAdmin('md-lead', leadRole);
  const agent = await makeAdmin('md-agent', agentRole);
  const asLead = adminHeaders(lead);
  const asAgent = adminHeaders(agent);

  const member = await makeUser('md-member', { cityId: 'MANCHESTER' });
  const pro = await makeUser('md-pro', { cityId: 'MANCHESTER' });

  // ── 1. A managed request to work ──────────────────────────────────────────
  heading('1. the pipeline');

  const asked = await api(
    member.token,
    'POST',
    '/managed-requests',
    { subjectType: 'STOREFRONT', helpAreas: ['LISTINGS'], notes: 'I cannot work out the photos.' },
    key(),
  );

  check('a member asks Circl to take something on', asked.status === 201, asked.body?.error);

  const requestRow = await prisma.managedRequest.findFirst({
    where: { userId: member.id },
    orderBy: { createdAt: 'desc' },
  });

  check('and it lands as a managed request', !!requestRow, requestRow);

  const list = await api(null, 'GET', '/admin/managed/requests', null, asLead);
  const listed = (list.body?.data ?? []).find(row => row.id === requestRow?.id);

  check('the pipeline answers', list.status === 200, list.status || list.body?.error);
  check(
    'with the member on the row, nobody assigned, and the thread it lives in',
    listed?.member?.id === member.id &&
      listed?.assignedTo === null &&
      typeof listed?.conversationId === 'string',
    listed,
  );
  // `Code[]`, not bare codes: `LISTINGS` on a screen where "Writing and photographing listings"
  // belongs is the taxonomy leaking, and the portal cannot turn one into the other.
  check(
    'and the help areas carry their labels',
    listed?.helpAreas?.[0]?.code === 'LISTINGS' &&
      typeof listed.helpAreas[0].label === 'string' &&
      listed.helpAreas[0].label !== 'LISTINGS',
    listed?.helpAreas,
  );
  check(
    'and the two badge counts, which ignore the filters',
    typeof list.body?.meta?.unassigned === 'number' && typeof list.body?.meta?.mine === 'number',
    list.body?.meta,
  );

  const closedOnly = await api(null, 'GET', '/admin/managed/requests?state=CLOSED', null, asLead);

  check(
    'the default is the open states, not everything',
    !(closedOnly.body?.data ?? []).some(row => row.id === requestRow?.id),
    (closedOnly.body?.data ?? []).length,
  );

  // ── 2. Who may act ────────────────────────────────────────────────────────
  heading('2. reading is support’s, acting is not');

  const agentRead = await api(
    null,
    'GET',
    `/admin/managed/requests/${requestRow?.id}`,
    null,
    asAgent,
  );

  check('an agent may read one', agentRead.status === 200, agentRead.status);

  const agentWrite = await api(
    null,
    'PATCH',
    `/admin/managed/requests/${requestRow?.id}`,
    { state: 'IN_PROGRESS' },
    { ...asAgent, ...key() },
  );

  check('and may not act on it → 403', agentWrite.status === 403, agentWrite.status);

  // ── 3. Moving it along ────────────────────────────────────────────────────
  heading('3. the member hears about every move');

  const empty = await api(
    null,
    'PATCH',
    `/admin/managed/requests/${requestRow?.id}`,
    {},
    { ...asLead, ...key() },
  );

  check('a PATCH that changes nothing is a 400, not a no-op', empty.status === 400, empty.status);

  const taken = await api(
    null,
    'PATCH',
    `/admin/managed/requests/${requestRow?.id}`,
    { state: 'IN_PROGRESS', assigneeId: lead.id, note: 'Ringing them this afternoon.' },
    { ...asLead, ...key() },
  );

  check('it moves to IN_PROGRESS', taken.status === 200, taken.status || taken.body?.error);
  check(
    'with the assignee resolved to a StaffRef',
    taken.body?.data?.assignedTo?.id === lead.id &&
      typeof taken.body?.data?.assignedTo?.name === 'string',
    taken.body?.data?.assignedTo,
  );
  check(
    'and the note appended to the running record with the date and who wrote it',
    (taken.body?.data?.notes ?? '').includes('Ringing them this afternoon.') &&
      (taken.body?.data?.notes ?? '').includes(lead.email) &&
      (taken.body?.data?.notes ?? '').includes('I cannot work out the photos.'),
    taken.body?.data?.notes,
  );

  const systemMessages = await prisma.message.findMany({
    where: { conversationId: requestRow?.conversationId, kind: 'SYSTEM' },
    orderBy: { sentAt: 'desc' },
    take: 3,
  });

  check(
    'the member’s Circl-team thread says somebody is on it',
    systemMessages.some(
      message => message.systemType === 'MANAGED_STATE_CHANGED' && /working on/.test(message.body),
    ),
    systemMessages.map(message => [message.systemType, message.body?.slice(0, 50)]),
  );

  // Counted in JS rather than with a JSON path filter: Prisma 7 wants a scalar filter beside a
  // path, and what this is asserting is "a row mentioning this request exists".
  const forMember = await prisma.notification.findMany({
    where: { userId: member.id },
    select: { metadata: true },
    take: 50,
  });
  const notified = forMember.filter(
    row => row.metadata?.managedRequestId === requestRow?.id,
  ).length;

  check('and they are notified, not left to find it', notified >= 1, notified);

  const noReason = await api(
    null,
    'PATCH',
    `/admin/managed/requests/${requestRow?.id}`,
    { state: 'CLOSED' },
    { ...asLead, ...key() },
  );

  check('closing with no reason is a 422 (§7.7)', noReason.status === 422, {
    status: noReason.status,
    code: noReason.body?.error?.code,
  });

  const closed = await api(
    null,
    'PATCH',
    `/admin/managed/requests/${requestRow?.id}`,
    { state: 'CLOSED', closedReason: 'STORE_SET_UP' },
    { ...asLead, ...key() },
  );

  check('closing with one works', closed.status === 200, closed.body?.error);
  check(
    'and the ending is recorded as what it was, with its date',
    closed.body?.data?.closedReason === 'STORE_SET_UP' && !!closed.body?.data?.closedAt,
    { reason: closed.body?.data?.closedReason, at: closed.body?.data?.closedAt },
  );

  const reopened = await api(
    null,
    'PATCH',
    `/admin/managed/requests/${requestRow?.id}`,
    { state: 'OPEN' },
    { ...asLead, ...key() },
  );

  check(
    'closed is final → 409 INVALID_TRANSITION with what was allowed',
    reopened.status === 409 &&
      reopened.body?.error?.code === 'INVALID_TRANSITION' &&
      Array.isArray(reopened.body?.data?.allowed),
    { status: reopened.status, data: reopened.body?.data },
  );

  const trail = await prisma.auditLog.findFirst({
    where: { action: 'managed.updated', targetId: requestRow?.id },
    orderBy: { occurredAt: 'desc' },
  });

  check(
    'every move is audited with before and after',
    trail?.before?.state === 'IN_PROGRESS' && trail?.after?.state === 'CLOSED',
    { before: trail?.before, after: trail?.after },
  );

  // ── 4. Briefs and placement ───────────────────────────────────────────────
  heading('4. placing a member with somebody, in Circl’s name');

  const listing = await api(pro.token, 'POST', '/professionals/listings', {
    categoryCodes: ['BUSINESS_CONSULTING'],
    professionTitle: 'Business Adviser',
    experienceLevel: 'EXPERT',
    about: 'I help new arrivals set up small businesses, and have done for six years.',
    consentAccepted: true,
  });
  const listingId = listing.body?.data?.listing?.id;

  await approveListing(listingId);

  const brief = await api(
    member.token,
    'POST',
    '/professionals/briefs',
    {
      categoryCode: 'BUSINESS_CONSULTING',
      description: 'I want to register a small company and I do not know where to start.',
      urgency: 'THIS_WEEK',
      budget: 15000,
    },
    key(),
  );
  const briefId = brief.body?.data?.id;

  check('the member writes a brief', brief.status === 201 && !!briefId, brief.body?.error);

  const briefs = await api(null, 'GET', '/admin/managed/briefs?sort=urgency', null, asLead);
  const briefListed = (briefs.body?.data ?? []).find(row => row.id === briefId);

  check('the brief list answers', briefs.status === 200, briefs.status || briefs.body?.error);
  check(
    'with the category’s label, the city as a CityRef, and money named as pence',
    briefListed?.category?.label &&
      briefListed.category.label !== briefListed.category.code &&
      briefListed?.budgetPence === 15000 &&
      (briefListed?.city === null || typeof briefListed?.city?.name === 'string'),
    briefListed,
  );

  const briefDetail = await api(null, 'GET', `/admin/managed/briefs/${briefId}`, null, asLead);

  check('the detail answers', briefDetail.status === 200, briefDetail.status);
  check(
    'with the shortlist and the scores behind each rank',
    Array.isArray(briefDetail.body?.data?.matches) &&
      briefDetail.body.data.matches.every(
        match =>
          typeof match.totalScore === 'number' &&
          typeof match.ratingScore === 'number' &&
          typeof match.professional?.id === 'string' &&
          'acceptingWork' in match,
      ),
    (briefDetail.body?.data?.matches ?? []).map(match => [match.rank, match.totalScore]),
  );

  const closedBooks = await prisma.professionalListing.update({
    where: { id: listingId },
    data: { isAcceptingWork: false },
    select: { id: true },
  });

  const refusedPlace = await api(
    null,
    'POST',
    `/admin/managed/briefs/${briefId}/place`,
    { listingId: closedBooks.id },
    { ...asLead, ...key() },
  );

  check(
    'placing against closed books is a 422, the same refusal the member gets',
    refusedPlace.status === 422 && refusedPlace.body?.error?.code === 'NOT_ACCEPTING_WORK',
    { status: refusedPlace.status, code: refusedPlace.body?.error?.code },
  );

  await prisma.professionalListing.update({
    where: { id: listingId },
    data: { isAcceptingWork: true },
  });

  const placed = await api(
    null,
    'POST',
    `/admin/managed/briefs/${briefId}/place`,
    { listingId, note: 'Best fit on price and they speak Twi.' },
    { ...asLead, ...key() },
  );

  check('the placement lands', placed.status === 200, placed.status || placed.body?.error);
  check(
    'the brief is MATCHED with a real booking behind it',
    placed.body?.data?.state === 'MATCHED' &&
      !!placed.body?.data?.bookingId &&
      placed.body?.data?.chosenListingId === listingId,
    {
      state: placed.body?.data?.state,
      bookingId: placed.body?.data?.bookingId,
      chosen: placed.body?.data?.chosenListingId,
    },
  );
  check(
    'and it records that **Circl** chose, not the member',
    placed.body?.data?.placedBy?.id === lead.id && !!placed.body?.data?.placedAt,
    { placedBy: placed.body?.data?.placedBy, at: placed.body?.data?.placedAt },
  );

  const booking = await prisma.booking.findUnique({
    where: { id: placed.body?.data?.bookingId },
    select: { clientId: true, professionalId: true, state: true },
  });

  check(
    'the booking is the member’s own, in the state their own choice would have made',
    booking?.clientId === member.id &&
      booking?.professionalId === pro.id &&
      booking?.state === 'PENDING_ACCEPTANCE',
    booking,
  );

  const proNotifications = await prisma.notification.findMany({
    where: { userId: pro.id },
    select: { metadata: true },
    take: 50,
  });
  const proTold = proNotifications.filter(row => row.metadata?.briefId === briefId).length;

  check('the professional is told where the job came from', proTold >= 1, proTold);

  const placedTwice = await api(
    null,
    'POST',
    `/admin/managed/briefs/${briefId}/place`,
    { listingId },
    { ...asLead, ...key() },
  );

  check(
    'placing twice is a 409 ALREADY_DECIDED',
    placedTwice.status === 409 && placedTwice.body?.error?.code === 'ALREADY_DECIDED',
    { status: placedTwice.status, code: placedTwice.body?.error?.code },
  );

  const rePlace = await api(
    null,
    'PATCH',
    `/admin/managed/briefs/${briefId}`,
    { state: 'MATCHING', note: 'They did not get on; finding somebody else.' },
    { ...asLead, ...key() },
  );

  check('a lead can open it again', rePlace.status === 200, rePlace.body?.error);
  check(
    'and the previous choice is cleared, so no screen still reads it as placed',
    rePlace.body?.data?.state === 'MATCHING' &&
      rePlace.body?.data?.chosenListingId === null &&
      rePlace.body?.data?.placedBy === null,
    rePlace.body?.data,
  );

  const releasedBooking = await prisma.booking.findUnique({
    where: { id: placed.body?.data?.bookingId },
    select: { state: true },
  });

  /**
   * The booking goes with the placement.
   *
   * Re-opening cleared `bookingId` off the brief and left the booking itself live, so the
   * professional kept a `PENDING_ACCEPTANCE` job for work that had been taken off them — and the
   * next placement made a second one. Cancelled through the member's own path, so the timeline
   * entry and the notice to the professional come with it.
   */
  check(
    'and the booking behind it is cancelled, not left live on the professional',
    releasedBooking?.state === 'CANCELLED',
    releasedBooking,
  );

  const proHeard = await prisma.notification.count({
    where: { userId: pro.id, title: { contains: 'cancelled' } },
  });

  check(
    'with the professional told, as any other cancellation tells them',
    proHeard >= 1,
    proHeard,
  );

  // Placed again, then accepted, to prove the other half of the rule.
  const placedAgain = await api(
    null,
    'POST',
    `/admin/managed/briefs/${briefId}/place`,
    { listingId, note: 'Second attempt.' },
    { ...asLead, ...key() },
  );

  check(
    'the brief can be placed again afterwards',
    placedAgain.status === 200,
    placedAgain.body?.error,
  );

  const accepted = await api(
    pro.token,
    'POST',
    `/bookings/${placedAgain.body?.data?.bookingId}/accept`,
    {},
    key(),
  );

  check('the professional accepts the second placement', accepted.status === 200, {
    status: accepted.status,
    error: accepted.body?.error,
  });

  const refusedReopen = await api(
    null,
    'PATCH',
    `/admin/managed/briefs/${briefId}`,
    { state: 'MATCHING', note: 'Changed my mind again.' },
    { ...asLead, ...key() },
  );

  check(
    'but once the professional has accepted, opening it again is refused rather than cancelling their work',
    refusedReopen.status === 409 && refusedReopen.body?.error?.code === 'INVALID_TRANSITION',
    {
      status: refusedReopen.status,
      code: refusedReopen.body?.error?.code,
      message: refusedReopen.body?.error?.message,
    },
  );

  // ── 5. Disputes ───────────────────────────────────────────────────────────
  heading('5. a disagreement, and a finding both of them read');

  const second = await api(
    member.token,
    'POST',
    '/professionals/bookings',
    { listingId, briefId: null, serviceId: null, details: 'A second job to fall out over.' },
    key(),
  );

  // A booking needs a service or a brief; this one gets the brief, through the member's own path.
  const dealBooking = await api(
    member.token,
    'POST',
    '/professionals/briefs',
    {
      categoryCode: 'BUSINESS_CONSULTING',
      description: 'Another piece of work, which is going to go wrong.',
      urgency: 'FLEXIBLE',
    },
    key(),
  );
  const secondBriefId = dealBooking.body?.data?.id;
  const chosen = await api(
    member.token,
    'POST',
    `/professionals/briefs/${secondBriefId}/choose`,
    { listingId },
    key(),
  );
  const bookingId = chosen.body?.data?.id;

  check('a second booking exists to disagree about', !!bookingId, {
    second: second.status,
    chosen: chosen.status,
    error: chosen.body?.error,
  });

  // Raised **with a photograph**, which is the case that was broken: the opening attachments are
  // owned by the dispute row rather than by an evidence row, so a staff screen reading evidence
  // rows alone showed none of them.
  const evidenceKey = await uploadPng(member.token, 'DISPUTE', 600, 400);

  const raised = await api(
    member.token,
    'POST',
    `/bookings/${bookingId}/disputes`,
    {
      reasonCode: 'COMMUNICATION',
      description: 'I have heard nothing for two weeks and the work has not started.',
      mediaKeys: evidenceKey ? [evidenceKey] : [],
    },
    key(),
  );
  const disputeId = raised.body?.data?.id;

  check('the member raises an issue', raised.status === 201 && !!disputeId, raised.body?.error);

  const disputes = await api(null, 'GET', '/admin/disputes', null, asLead);
  const disputeListed = (disputes.body?.data ?? []).find(row => row.id === disputeId);

  check('the queue answers', disputes.status === 200, disputes.status || disputes.body?.error);
  check(
    'and names **both** sides, which the dispute row itself does not',
    disputeListed?.raisedBy?.id === member.id && disputeListed?.otherParty?.id === pro.id,
    { raisedBy: disputeListed?.raisedBy?.id, other: disputeListed?.otherParty?.id },
  );

  /**
   * Both sides of a dispute can be offered it as a reason to read the thread.
   *
   * §5.6 accepts a dispute from either party — raiser, or the other side of the booking — but this
   * list only queried `raisedById`, so the professional whose work is being disputed had a valid
   * reason that was never shown. The only way through was to ask a colleague to take the grant.
   */
  for (const [who, id] of [
    ['the member who raised it', member.id],
    ['the professional it is about', pro.id],
  ]) {
    const options = await api(null, 'GET', `/admin/members/${id}/linkable-cases`, null, asLead);

    check(
      `the dispute is offered to a reviewer working with ${who}`,
      options.status === 200 &&
        (options.body?.data ?? []).some(row => row.type === 'DISPUTE' && row.id === disputeId),
      {
        status: options.status,
        offered: (options.body?.data ?? []).map(row => `${row.type}:${row.id}`),
      },
    );
  }

  const agentDispute = await api(null, 'GET', '/admin/disputes', null, asAgent);

  check(
    'support cannot see the disputes queue at all → 403',
    agentDispute.status === 403,
    agentDispute.status,
  );

  const disputeDetail = await api(null, 'GET', `/admin/disputes/${disputeId}`, null, asLead);

  check('the detail answers', disputeDetail.status === 200, disputeDetail.status);
  check(
    'with the booking and its timeline — what actually happened before the disagreement',
    typeof disputeDetail.body?.data?.subject?.title === 'string' &&
      Array.isArray(disputeDetail.body?.data?.subject?.events) &&
      disputeDetail.body.data.subject.events.length >= 1 &&
      disputeDetail.body.data.subject.events.every(event => !!event.label && !!event.at),
    disputeDetail.body?.data?.subject,
  );
  check(
    'with what they sent when they raised it, signed and attributed to them',
    (disputeDetail.body?.data?.evidence ?? []).some(
      item =>
        item.uploadedBy?.id === member.id &&
        typeof item.url === 'string' &&
        item.url.length > 0 &&
        item.type !== 'TEXT',
    ),
    (disputeDetail.body?.data?.evidence ?? []).map(item => [item.type, !!item.url]),
  );
  check(
    'and the conversation id, but never the conversation: that needs §5.6’s grant',
    typeof disputeDetail.body?.data?.conversationId === 'string' &&
      !('messages' in (disputeDetail.body?.data ?? {})),
    Object.keys(disputeDetail.body?.data ?? {}),
  );

  const inReview = await api(
    null,
    'PATCH',
    `/admin/disputes/${disputeId}`,
    {
      state: 'IN_REVIEW',
      assigneeId: lead.id,
      expectedResolutionAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    { ...asLead, ...key() },
  );

  check('taking it on works', inReview.status === 200, inReview.body?.error);
  check(
    'and both parties are told somebody is looking, with the date they were promised',
    inReview.body?.data?.state === 'IN_REVIEW' && !!inReview.body?.data?.expectedResolutionAt,
    inReview.body?.data,
  );

  const endWithPatch = await api(
    null,
    'PATCH',
    `/admin/disputes/${disputeId}`,
    { state: 'RESOLVED' },
    { ...asLead, ...key() },
  );

  check(
    'a PATCH cannot end a dispute: an ending needs an outcome and a note → 422',
    endWithPatch.status === 422,
    { status: endWithPatch.status, code: endWithPatch.body?.error?.code },
  );

  const resolved = await api(
    null,
    'POST',
    `/admin/disputes/${disputeId}/resolve`,
    {
      outcome: 'MUTUAL',
      resolutionNote:
        'Both of you had a point. The work starts Monday and the price stands as agreed.',
      reasonCode: 'CORRECTION',
      note: 'Spoke to both of them.',
    },
    { ...asLead, ...key() },
  );

  check('the finding lands', resolved.status === 200, resolved.status || resolved.body?.error);
  check(
    'with the outcome, the note and who made it',
    resolved.body?.data?.outcome === 'MUTUAL' &&
      resolved.body?.data?.resolvedBy?.id === lead.id &&
      /Both of you/.test(resolved.body?.data?.resolutionNote ?? ''),
    {
      outcome: resolved.body?.data?.outcome,
      by: resolved.body?.data?.resolvedBy?.id,
    },
  );

  const partyNotifications = await prisma.notification.findMany({
    where: { userId: { in: [member.id, pro.id] } },
    select: { userId: true, metadata: true },
    take: 100,
  });
  const bothTold = new Set(
    partyNotifications.filter(row => row.metadata?.disputeId === disputeId).map(row => row.userId),
  ).size;

  check(
    'and **both** of them hear it: a finding told to one is half a resolution',
    bothTold >= 2,
    bothTold,
  );

  const resolvedTwice = await api(
    null,
    'POST',
    `/admin/disputes/${disputeId}/resolve`,
    { outcome: 'NO_FINDING', resolutionNote: 'Again.', reasonCode: 'OTHER', note: 'Retry.' },
    { ...asLead, ...key() },
  );

  check(
    'resolving twice is a 409 ALREADY_DECIDED',
    resolvedTwice.status === 409 && resolvedTwice.body?.error?.code === 'ALREADY_DECIDED',
    { status: resolvedTwice.status, code: resolvedTwice.body?.error?.code },
  );

  // ── 6. Deal problems ──────────────────────────────────────────────────────
  heading('6. a deal somebody flagged');

  const conversationId = (
    await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { conversationId: true },
    })
  )?.conversationId;

  const proposed = await api(
    member.token,
    'POST',
    `/deals/conversation/${conversationId}`,
    {
      amount: 20000,
      currency: 'GBP',
      timing: 'ON_COMPLETION',
      summary: 'Company registration and the first year of filings.',
    },
    key(),
  );
  const dealId = proposed.body?.data?.id;

  check('the two of them record a deal', proposed.status === 201 && !!dealId, proposed.body?.error);

  // The other side marks AGREED: proposing deliberately does not, or the acceptor would have
  // nothing to tap. A deal has to be agreed before a problem can be flagged on it.
  const agreed = await api(pro.token, 'POST', `/deals/${dealId}/steps`, { stages: ['AGREED'] });

  check('and the other side agrees to it', agreed.status === 200, agreed.body?.error);

  const flagged = await api(
    member.token,
    'POST',
    `/deals/${dealId}/problem`,
    { note: 'The work is not what we agreed.' },
    key(),
  );

  check('and one of them flags a problem', flagged.status === 200 || flagged.status === 201, {
    status: flagged.status,
    error: flagged.body?.error,
  });

  const problems = await api(null, 'GET', '/admin/deals/problems', null, asLead);
  const problemRow = (problems.body?.data ?? []).find(row => row.dealId === dealId);

  check('the problems queue answers', problems.status === 200, problems.status);
  check(
    'with both parties, the amount in pence, and how far the deal had got',
    problemRow?.payer?.id === member.id &&
      problemRow?.provider?.id === pro.id &&
      problemRow?.amountPence === 20000 &&
      'lastStage' in (problemRow ?? {}) &&
      problemRow?.problemState === 'OPEN',
    problemRow,
  );

  const settled = await api(
    null,
    'POST',
    `/admin/deals/${dealId}/problem/resolve`,
    {
      resolutionNote: 'We have spoken to both of you and the scope is agreed in writing now.',
      reasonCode: 'CORRECTION',
      note: 'Scope clarified.',
    },
    { ...asLead, ...key() },
  );

  check('settling it works', settled.status === 200, settled.status || settled.body?.error);
  check(
    'the flag stays on the record, and the **staff** state is what changed',
    settled.body?.data?.hasProblem === true &&
      settled.body?.data?.problemState === 'RESOLVED' &&
      settled.body?.data?.problemResolvedBy?.id === lead.id,
    {
      hasProblem: settled.body?.data?.hasProblem,
      problemState: settled.body?.data?.problemState,
    },
  );

  const stillOpen = await api(null, 'GET', '/admin/deals/problems', null, asLead);

  check(
    'and it leaves the open queue',
    !(stillOpen.body?.data ?? []).some(row => row.dealId === dealId),
    (stillOpen.body?.data ?? []).map(row => row.dealId),
  );

  const dealNotifications = await prisma.notification.findMany({
    where: { userId: member.id },
    select: { metadata: true },
    take: 100,
  });
  const flaggerTold = dealNotifications.filter(row => row.metadata?.dealId === dealId).length;

  check('whoever flagged it hears the answer', flaggerTold >= 1, flaggerTold);

  const reflagged = await api(
    member.token,
    'POST',
    `/deals/${dealId}/problem`,
    { note: 'It has gone wrong again.' },
    key(),
  );

  if (reflagged.status === 200 || reflagged.status === 201) {
    const again = await api(null, 'GET', '/admin/deals/problems', null, asLead);

    check(
      'a deal flagged again is open work again, rather than staying settled',
      (again.body?.data ?? []).some(row => row.dealId === dealId),
      (again.body?.data ?? []).map(row => row.dealId),
    );
  } else {
    check('a deal flagged again is open work again, rather than staying settled', false, {
      status: reflagged.status,
      error: reflagged.body?.error,
    });
  }

  await prisma.role.deleteMany({ where: { code: { startsWith: 'e2e-md-' } } });
  await sweep('managed-disputes');
  await finish();
}

main().catch(fail);
