/**
 * §5.15: the support inbox.
 *
 * The first section is the reason this suite exists. Until this stage the two support endpoints
 * admitted **any** conversation whose `contextType` was `SUPPORT` — and a safeguarding disclosure
 * is one of those (D36: Guard, deal problems and plain support all share one conversation key), so
 * `support:read` was enough to read a member's private disclosure and `support:manage` enough to
 * answer it. `guard:read` being held by fewer people was the whole protection and the endpoint
 * never consulted it. Nothing but `SupportThread.type` distinguishes the two, which is why every
 * path in the inbox goes through one loader that reads it.
 *
 * So: the Guard thread below is a real one, opened by a real member through `POST /guard/threads`,
 * and every support-side request for it has to come back 404 — not 403, which would confirm that
 * this member has a safeguarding case.
 *
 * The non-Guard threads are real too, opened through `POST /managed-requests`, which is the one
 * member path that produces a support thread Circl starts rather than the member. That turns out
 * to matter for `firstResponseAt`: a thread with no member message in it has no response time, and
 * the first staff line is not a reply to anything.
 */
const {
  adminHeaders,
  api,
  check,
  clearRateLimits,
  fail,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);

const threadFor = conversationId => prisma.supportThread.findUnique({ where: { conversationId } });

const clientId = () => `sup-${Math.random().toString(36).slice(2)}`;

async function main() {
  await sweep('pre-run');
  await clearRateLimits();

  const support = await makeAdmin('inbox-support', 'support');
  const safety = await makeAdmin('inbox-safety', 'trust_safety');
  const otherAgent = await makeAdmin('inbox-agent2', 'support');
  const supportHeaders = adminHeaders(support);
  const safetyHeaders = adminHeaders(safety);

  // ── 1. A Guard disclosure is not the support team's to read ───────────────
  heading('1. R7: a disclosure is invisible to support, and a 404 rather than a 403');

  const discloser = await makeUser('inbox-discloser', { cityId: 'MANCHESTER' });

  let r = await api(discloser.token, 'POST', '/guard/threads', {
    subject: 'Something I cannot post publicly',
    message: 'My landlord has kept my passport since March and says I owe him for it.',
    categoryCode: 'SAFETY',
  });

  const guardConversation = r.body?.data?.conversationId;

  check('a member discloses → 201', r.status === 201 && !!guardConversation, r.body?.error);
  check(
    'and the thread is typed GUARD',
    (await threadFor(guardConversation))?.type === 'GUARD',
    await threadFor(guardConversation),
  );

  r = await api(
    null,
    'GET',
    `/admin/support/threads?memberId=${discloser.id}`,
    null,
    supportHeaders,
  );

  check('support’s inbox does not list it', r.status === 200 && (r.body?.data ?? []).length === 0, {
    status: r.status,
    rows: r.body?.data?.length,
  });

  r = await api(null, 'GET', `/admin/support/threads/${guardConversation}`, null, supportHeaders);

  check('support cannot open it → 404', r.status === 404, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(
    null,
    'GET',
    `/admin/support/threads/${guardConversation}/messages`,
    null,
    supportHeaders,
  );

  check('support cannot read the messages → 404', r.status === 404, { status: r.status });

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${guardConversation}/messages`,
    { clientId: clientId(), body: 'This should never reach them.' },
    supportHeaders,
  );

  check('support cannot reply → 404', r.status === 404, { status: r.status });

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${guardConversation}/assign`,
    { assigneeId: support.id },
    supportHeaders,
  );

  check('support cannot take it → 404', r.status === 404, { status: r.status });

  r = await api(
    null,
    'PATCH',
    `/admin/support/threads/${guardConversation}`,
    { state: 'RESOLVED' },
    supportHeaders,
  );

  check('support cannot resolve it → 404', r.status === 404, { status: r.status });

  r = await api(
    null,
    'GET',
    `/admin/support/threads?type=GUARD&memberId=${discloser.id}`,
    null,
    supportHeaders,
  );

  check(
    'asking for Guard threads narrows to nothing rather than refusing',
    r.status === 200 && (r.body?.data ?? []).length === 0,
    { status: r.status, rows: r.body?.data?.length },
  );

  r = await api(null, 'GET', `/admin/support/threads/${guardConversation}`, null, safetyHeaders);

  check(
    'trust & safety can open the same thread → 200',
    r.status === 200 && r.body?.data?.type === 'GUARD',
    { status: r.status, type: r.body?.data?.type, error: r.body?.error?.code },
  );
  check(
    'and it carries the Guard case it belongs to',
    !!r.body?.data?.linked?.guardCaseId,
    r.body?.data?.linked,
  );

  r = await api(
    null,
    'GET',
    `/admin/support/threads?type=GUARD&memberId=${discloser.id}`,
    null,
    safetyHeaders,
  );

  check('and it is in their inbox', r.status === 200 && (r.body?.data ?? []).length === 1, {
    status: r.status,
    rows: r.body?.data?.length,
  });

  // ── 1b. The trail a disclosure leaves is the safety trail ─────────────────
  heading('1b. reading one through the inbox is still a Guard read');

  r = await api(
    null,
    'GET',
    `/admin/support/threads/${guardConversation}/messages`,
    null,
    safetyHeaders,
  );

  check('trust & safety read it through the inbox → 200', r.status === 200, r.body?.error);

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${guardConversation}/messages`,
    { clientId: clientId(), body: 'Thank you for telling us. Somebody will call you today.' },
    safetyHeaders,
  );

  check('and answered it → 201', r.status === 201, r.body?.error);

  const trail = await prisma.auditLog.findMany({
    where: { targetId: guardConversation, actorId: safety.id },
    select: { action: true, area: true },
    orderBy: { occurredAt: 'desc' },
  });
  const actions = trail.map(entry => entry.action);

  check(
    'the read is logged as a Guard read, not a support one',
    actions.includes('guard.thread_read') && !actions.includes('thread.read'),
    actions,
  );
  check(
    'and the reply as a Guard reply',
    actions.includes('guard.replied') && !actions.includes('support.replied'),
    actions,
  );
  check(
    'both in the SAFETY area, which is the one trust & safety can read',
    trail
      .filter(entry => entry.action.startsWith('guard.'))
      .every(entry => entry.area === 'SAFETY'),
    trail,
  );

  // ── 2. Notes on a thread follow the thread, not the endpoint ──────────────
  heading('2. notes on a disclosure are as private as the disclosure');

  r = await api(
    null,
    'POST',
    '/admin/notes',
    {
      subjectType: 'SUPPORT_THREAD',
      subjectId: guardConversation,
      body: 'A note support should never be able to read.',
    },
    supportHeaders,
  );

  check('support cannot annotate a Guard thread → 404', r.status === 404, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(
    null,
    'POST',
    '/admin/notes',
    {
      subjectType: 'SUPPORT_THREAD',
      subjectId: guardConversation,
      body: 'Spoke to the member; housing team informed.',
    },
    safetyHeaders,
  );

  check('trust & safety can → 201', r.status === 201, {
    status: r.status,
    error: r.body?.error,
  });

  r = await api(
    null,
    'GET',
    `/admin/notes?subjectType=SUPPORT_THREAD&subjectId=${guardConversation}`,
    null,
    supportHeaders,
  );

  check('and support cannot read it back → 404', r.status === 404, { status: r.status });

  // ── 3. The inbox row ──────────────────────────────────────────────────────
  heading('3. the row the inbox draws');

  const asker = await makeUser('inbox-asker', { cityId: 'BRISTOL' });

  r = await api(asker.token, 'POST', '/managed-requests', {
    subjectType: 'STOREFRONT',
    notes: 'I would like Circl to run my store while I am travelling.',
  });

  check('a managed request → 201', r.status === 201, r.body?.error);

  const managed = await prisma.managedRequest.findFirst({
    where: { userId: asker.id },
    select: { id: true, conversationId: true },
  });
  const conversation = managed?.conversationId;

  check('with a conversation of its own', !!conversation, managed);

  let thread = await threadFor(conversation);

  check('typed MANAGED from its context', thread?.type === 'MANAGED', thread?.type);
  check('starting NEW', thread?.state === 'NEW', thread?.state);
  check(
    'with no member message yet, so nothing is waiting on us',
    thread?.waitingSince === null && thread?.firstMemberMessageAt === null,
    { waitingSince: thread?.waitingSince, first: thread?.firstMemberMessageAt },
  );

  r = await api(null, 'GET', `/admin/support/threads?memberId=${asker.id}`, null, supportHeaders);

  const row = (r.body?.data ?? [])[0];

  check('support sees it', r.status === 200 && !!row, { status: r.status, body: r.body?.error });
  check('addressed by its conversation id', row?.conversationId === conversation, row);
  check('naming the member', row?.member?.id === asker.id, row?.member);
  check(
    'with the subject the member sees',
    row?.subject === 'Circl running your store',
    row?.subject,
  );
  check(
    'and the context it came from',
    row?.context?.type === 'MANAGED_REQUEST' && row?.context?.id === asker.id,
    row?.context,
  );
  check('unassigned', row?.assignedTo === null, row?.assignedTo);
  check('not overdue, because nobody has asked us anything', row?.overdue === false, row?.overdue);
  check('with a preview of the last thing said', typeof row?.lastMessagePreview === 'string', {
    preview: row?.lastMessagePreview,
  });
  check(
    'and the four counts beside it',
    ['unassigned', 'mine', 'open', 'waiting'].every(
      key => typeof r.body?.meta?.counts?.[key] === 'number',
    ),
    r.body?.meta?.counts,
  );

  const supportCounts = r.body?.meta?.counts;
  const safetyList = await api(null, 'GET', '/admin/support/threads', null, safetyHeaders);

  // Everything live, rather than `open` alone: by this point the disclosure has been answered and
  // sits in `waiting`, and an assertion on one bucket would have been an assertion about which
  // state it happened to be in.
  const live = counts => (counts?.open ?? 0) + (counts?.waiting ?? 0);

  check(
    'and trust & safety’s counts are the larger ones: they include the disclosure',
    live(safetyList.body?.meta?.counts) > live(supportCounts),
    { support: supportCounts, safety: safetyList.body?.meta?.counts },
  );

  // ── 4. Answering ──────────────────────────────────────────────────────────
  heading('4. a reply, and what it does to the thread');

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/messages`,
    { clientId: clientId(), body: 'Of course — which parts would you like us to take on?' },
    supportHeaders,
  );

  const firstReply = r.body?.data?.id;

  check('a staff reply → 201', r.status === 201 && !!firstReply, r.body?.error);

  thread = await threadFor(conversation);

  check('hands the thread to the member', thread?.state === 'WAITING_ON_MEMBER', thread?.state);
  check('and takes it for the replier (§7.6)', thread?.assignedToId === support.id, {
    assigned: thread?.assignedToId,
    replier: support.id,
  });
  check(
    'but sets no response time: there was nothing to respond to yet',
    thread?.firstResponseAt === null,
    thread?.firstResponseAt,
  );
  check('while recording when staff last wrote', !!thread?.lastStaffMessageAt, thread);

  r = await api(asker.token, 'GET', `/messages/${conversation}/messages`);

  check(
    'the member has it in the thread they already had open',
    r.status === 200 && (r.body?.data ?? []).some(message => message.id === firstReply),
    { status: r.status, count: r.body?.data?.length },
  );

  r = await api(asker.token, 'POST', `/messages/${conversation}/messages`, {
    clientId: clientId(),
    body: 'Listings and replies, please. I am away for six weeks.',
  });

  check('the member answers → 201', r.status === 201, r.body?.error);

  thread = await threadFor(conversation);

  check('which reopens it as ours', thread?.state === 'OPEN', thread?.state);
  check('starts the wait', !!thread?.waitingSince, thread?.waitingSince);
  check('and counts as unread for staff', thread?.unreadForStaff === 1, thread?.unreadForStaff);

  r = await api(
    null,
    'GET',
    `/admin/support/threads/${conversation}/messages`,
    null,
    supportHeaders,
  );

  check('reading the thread → 200', r.status === 200, r.body?.error);
  check(
    'marks it read for staff',
    (await threadFor(conversation))?.unreadForStaff === 0,
    await threadFor(conversation),
  );

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/messages`,
    { clientId: clientId(), body: 'Six weeks is fine. We will set that up today.' },
    supportHeaders,
  );

  check('the second reply → 201', r.status === 201, r.body?.error);

  thread = await threadFor(conversation);

  check(
    'now sets the response time, because there was a member message to answer',
    !!thread?.firstResponseAt,
    thread?.firstResponseAt,
  );
  check('and clears the wait', thread?.waitingSince === null, thread?.waitingSince);

  const responseAt = thread?.firstResponseAt;

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/messages`,
    { clientId: clientId(), body: 'One more thing we noticed.', keepOpen: true },
    supportHeaders,
  );

  thread = await threadFor(conversation);

  check('a reply with keepOpen stays in our queue', thread?.state === 'OPEN', thread?.state);
  check(
    'and the response time is not re-stamped by it',
    thread?.firstResponseAt?.getTime() === responseAt?.getTime(),
    { was: responseAt, now: thread?.firstResponseAt },
  );
  check(
    'with no wait, because the member has not written since',
    thread?.waitingSince === null,
    thread?.waitingSince,
  );

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/messages`,
    { clientId: clientId() },
    supportHeaders,
  );

  check('a reply with no body and no canned reply is refused', r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });

  const idempotent = clientId();

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/messages`,
    { clientId: idempotent, body: 'Sent twice by a retry.' },
    supportHeaders,
  );
  const once = r.body?.data?.id;

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/messages`,
    { clientId: idempotent, body: 'Sent twice by a retry.' },
    supportHeaders,
  );

  check(
    'the same clientId twice is one message, as on the member side',
    r.body?.data?.id === once,
    { first: once, second: r.body?.data?.id },
  );

  // ── 5. Canned replies ─────────────────────────────────────────────────────
  heading('5. a reply written once and sent by the team');

  r = await api(
    null,
    'POST',
    '/admin/support/canned-replies',
    {
      title: 'Managed store: what we need',
      body: 'Thanks for asking. To get started we need your opening hours and a photo of each item.',
    },
    supportHeaders,
  );

  const canned = r.body?.data;

  check('creating one → 201', r.status === 201 && !!canned?.id, r.body?.error);
  check('attributed to its author', canned?.createdBy?.id === support.id, canned?.createdBy);
  check('and active', canned?.isActive === true, canned);

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/messages`,
    { clientId: clientId(), cannedReplyId: canned.id },
    supportHeaders,
  );

  check(
    'sending it by id alone sends the stored text verbatim',
    r.status === 201 && r.body?.data?.body === canned.body,
    { status: r.status, sent: r.body?.data?.body, error: r.body?.error },
  );

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/messages`,
    { clientId: clientId(), cannedReplyId: canned.id, body: 'Edited before sending.' },
    supportHeaders,
  );

  check(
    'an edited one sends what the agent actually wrote',
    r.status === 201 && r.body?.data?.body === 'Edited before sending.',
    r.body?.data?.body,
  );

  r = await api(
    null,
    'PATCH',
    `/admin/support/canned-replies/${canned.id}`,
    { isActive: false },
    supportHeaders,
  );

  check('retiring one → 200', r.status === 200 && r.body?.data?.isActive === false, r.body?.error);

  r = await api(null, 'GET', '/admin/support/canned-replies', null, supportHeaders);

  check(
    'and the reply box stops offering it',
    r.status === 200 && !(r.body?.data ?? []).some(reply => reply.id === canned.id),
    { status: r.status, ids: (r.body?.data ?? []).map(reply => reply.id) },
  );

  r = await api(null, 'GET', '/admin/support/canned-replies?isActive=false', null, supportHeaders);

  check(
    'while still being there to be read',
    (r.body?.data ?? []).some(reply => reply.id === canned.id),
    { ids: (r.body?.data ?? []).map(reply => reply.id) },
  );

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/messages`,
    { clientId: clientId(), cannedReplyId: canned.id },
    supportHeaders,
  );

  check('a retired reply cannot be sent by id → 422', r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/messages`,
    { clientId: clientId(), cannedReplyId: canned.id, body: 'My own words, from a retired start.' },
    supportHeaders,
  );

  check('but an agent’s own words are not lost with it → 201', r.status === 201, {
    status: r.status,
    error: r.body?.error?.code,
  });

  // ── 6. Assignment ─────────────────────────────────────────────────────────
  heading('6. handing work to somebody who can do it');

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/assign`,
    { assigneeId: otherAgent.id },
    supportHeaders,
  );

  check(
    'assigning to another agent → 200',
    r.status === 200 && r.body?.data?.assignedTo?.id === otherAgent.id,
    { status: r.status, assigned: r.body?.data?.assignedTo, error: r.body?.error },
  );

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/assign`,
    { assigneeId: safety.id },
    supportHeaders,
  );

  check(
    'but not to trust & safety, who hold support read-only',
    r.status === 400 || r.status === 422,
    { status: r.status, code: r.body?.error?.code },
  );

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/assign`,
    { assigneeId: asker.id },
    supportHeaders,
  );

  check('nor to a member', r.status === 400 || r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${guardConversation}/assign`,
    { assigneeId: support.id },
    safetyHeaders,
  );

  check(
    'a Guard thread cannot be handed to somebody without `guard:manage` (B29)',
    r.status === 400 || r.status === 422,
    { status: r.status, code: r.body?.error?.code },
  );

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${guardConversation}/assign`,
    { assigneeId: safety.id },
    safetyHeaders,
  );

  check('but to trust & safety it can → 200', r.status === 200, {
    status: r.status,
    error: r.body?.error,
  });

  r = await api(
    null,
    'POST',
    `/admin/support/threads/${conversation}/assign`,
    { assigneeId: null },
    supportHeaders,
  );

  check(
    'and it can be put back in the unassigned queue',
    r.status === 200 && r.body?.data?.assignedTo === null,
    { status: r.status, assigned: r.body?.data?.assignedTo },
  );

  // ── 7. States by hand ─────────────────────────────────────────────────────
  heading('7. resolving, reopening and tagging');

  r = await api(
    null,
    'PATCH',
    `/admin/support/threads/${conversation}`,
    { state: 'RESOLVED', tags: [' Managed store ', 'managed store', 'MANAGED STORE'] },
    supportHeaders,
  );

  check('resolving → 200', r.status === 200 && r.body?.data?.state === 'RESOLVED', {
    status: r.status,
    state: r.body?.data?.state,
    error: r.body?.error,
  });
  check(
    'three spellings of one tag are one tag',
    JSON.stringify(r.body?.data?.tags) === JSON.stringify(['managed store']),
    r.body?.data?.tags,
  );

  thread = await threadFor(conversation);

  check('with the time it was settled', !!thread?.resolvedAt, thread?.resolvedAt);
  check('and no wait on a settled thread', thread?.waitingSince === null, thread?.waitingSince);

  r = await api(
    null,
    'PATCH',
    `/admin/support/threads/${conversation}`,
    { state: 'RESOLVED' },
    supportHeaders,
  );

  check('resolving it again → 409', r.status === 409, {
    status: r.status,
    code: r.body?.error?.code,
  });
  check(
    'saying what it would have been allowed instead',
    JSON.stringify(r.body?.data?.allowed) === JSON.stringify(['OPEN']),
    r.body?.data,
  );

  r = await api(
    null,
    'PATCH',
    `/admin/support/threads/${conversation}`,
    { state: 'WAITING_ON_MEMBER' },
    supportHeaders,
  );

  check('a resolved thread cannot be put back on the member → 409', r.status === 409, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(
    null,
    'PATCH',
    `/admin/support/threads/${conversation}`,
    { state: 'OPEN' },
    supportHeaders,
  );

  check('but it can be reopened → 200', r.status === 200 && r.body?.data?.state === 'OPEN', {
    status: r.status,
    state: r.body?.data?.state,
  });

  thread = await threadFor(conversation);

  check('which is counted', thread?.reopenCount === 1, thread?.reopenCount);
  check('and clears the resolution', thread?.resolvedAt === null, thread?.resolvedAt);

  r = await api(null, 'PATCH', `/admin/support/threads/${conversation}`, {}, supportHeaders);

  check('a PATCH that changes nothing → 422', r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(
    null,
    'PATCH',
    `/admin/support/threads/${conversation}`,
    { state: 'CLOSED' },
    supportHeaders,
  );

  check('and CLOSED cannot be set by hand → 400', r.status === 400, {
    status: r.status,
    code: r.body?.error?.code,
  });

  // ── 8. Filters and order ──────────────────────────────────────────────────
  heading('8. the views somebody actually works down');

  const waiters = [];

  for (const tag of ['w1', 'w2', 'w3']) {
    const member = await makeUser(`inbox-${tag}`, { cityId: 'BRISTOL' });

    await api(member.token, 'POST', '/managed-requests', {
      subjectType: 'STOREFRONT',
      notes: `Waiting member ${tag}.`,
    });

    const request = await prisma.managedRequest.findFirst({
      where: { userId: member.id },
      select: { conversationId: true },
    });

    waiters.push({ member, conversationId: request?.conversationId });
  }

  // Stamped backwards so the three have an order to be in, and so the oldest is past the SLA.
  // The column and the serialised value are both set from the same timestamps, which is the thing
  // worth checking: a sort key written by `MessageService` and a `waitingSince` recomputed on read
  // must agree about which of these is the longest wait.
  const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000);

  for (const [index, waiter] of waiters.entries()) {
    const at = minutesAgo([600, 120, 30][index]);

    await prisma.supportThread.update({
      where: { conversationId: waiter.conversationId },
      data: {
        state: 'OPEN',
        firstMemberMessageAt: at,
        lastMemberMessageAt: at,
        waitingSince: at,
      },
    });
  }

  r = await api(
    null,
    'GET',
    '/admin/support/threads?sort=waitingSince&view=unassigned&perPage=100',
    null,
    supportHeaders,
  );

  const waitingOrder = (r.body?.data ?? [])
    .filter(item => waiters.some(waiter => waiter.conversationId === item.conversationId))
    .map(item => item.conversationId);

  check(
    'sorting by the wait puts the longest first',
    JSON.stringify(waitingOrder) === JSON.stringify(waiters.map(waiter => waiter.conversationId)),
    { got: waitingOrder, want: waiters.map(waiter => waiter.conversationId) },
  );

  const answered = (r.body?.data ?? []).filter(item => item.waitingSince === null);

  check(
    'and threads nobody is waiting on sort after every one that is',
    answered.every(
      item =>
        (r.body?.data ?? []).findIndex(row => row.conversationId === item.conversationId) >=
        waitingOrder.length,
    ),
    { waiting: waitingOrder.length, answered: answered.length },
  );

  r = await api(
    null,
    'GET',
    '/admin/support/threads?overdue=true&perPage=100',
    null,
    supportHeaders,
  );

  const overdueIds = (r.body?.data ?? []).map(item => item.conversationId);

  check(
    'the overdue tab holds the one past the SLA',
    overdueIds.includes(waiters[0].conversationId),
    { overdue: overdueIds.length },
  );
  check('and not the ones still inside it', !overdueIds.includes(waiters[2].conversationId), {
    overdue: overdueIds.length,
  });
  check(
    'with every row it does return flagged as overdue',
    (r.body?.data ?? []).every(item => item.overdue === true),
    (r.body?.data ?? []).map(item => item.overdue),
  );

  // A resolved thread stopped the clock, however long it went unanswered.
  await prisma.supportThread.update({
    where: { conversationId: waiters[1].conversationId },
    data: { state: 'RESOLVED', firstMemberMessageAt: minutesAgo(5000), firstResponseAt: null },
  });

  r = await api(
    null,
    'GET',
    '/admin/support/threads?overdue=true&perPage=100',
    null,
    supportHeaders,
  );

  check(
    'a resolved thread is never overdue, whatever its clock says',
    !(r.body?.data ?? []).some(item => item.conversationId === waiters[1].conversationId),
    { ids: (r.body?.data ?? []).map(item => item.conversationId) },
  );

  r = await api(
    null,
    `GET`,
    `/admin/support/threads?view=mine&perPage=100`,
    null,
    adminHeaders(otherAgent),
  );

  check(
    '`mine` is empty for an agent who holds nothing',
    r.status === 200 && (r.body?.data ?? []).length === 0,
    { status: r.status, rows: r.body?.data?.length },
  );

  await prisma.supportThread.update({
    where: { conversationId: waiters[2].conversationId },
    data: { assignedToId: otherAgent.id, assignedAt: new Date() },
  });

  r = await api(
    null,
    'GET',
    '/admin/support/threads?view=mine&perPage=100',
    null,
    adminHeaders(otherAgent),
  );

  check(
    'and holds exactly what they were given',
    (r.body?.data ?? []).length === 1 &&
      r.body.data[0].conversationId === waiters[2].conversationId,
    { rows: (r.body?.data ?? []).map(item => item.conversationId) },
  );

  r = await api(
    null,
    'GET',
    '/admin/support/threads?view=unassigned&perPage=100',
    null,
    supportHeaders,
  );

  check(
    'while the unassigned view has stopped offering it',
    !(r.body?.data ?? []).some(item => item.conversationId === waiters[2].conversationId),
    { ids: (r.body?.data ?? []).length },
  );

  r = await api(
    null,
    'GET',
    // By the tag, which is in their email address: the harness gives every member the same first
    // name, so a name search would match the whole suite.
    `/admin/support/threads?q=${encodeURIComponent('inbox-w1')}&perPage=100`,
    null,
    supportHeaders,
  );

  check(
    'searching by the member’s contact details finds their thread',
    r.status === 200 &&
      (r.body?.data ?? []).some(item => item.conversationId === waiters[0].conversationId),
    { status: r.status, error: r.body?.error, rows: r.body?.data?.length },
  );

  r = await api(
    null,
    'GET',
    '/admin/support/threads?state=RESOLVED,CLOSED&perPage=100',
    null,
    supportHeaders,
  );

  check(
    'the done tab holds the settled ones and nothing open',
    r.status === 200 &&
      (r.body?.data ?? []).every(item => ['RESOLVED', 'CLOSED'].includes(item.state)),
    { status: r.status, states: (r.body?.data ?? []).map(item => item.state) },
  );

  // ── 9. The detail page ────────────────────────────────────────────────────
  heading('9. one thread, with everything attached to it');

  r = await api(null, 'GET', `/admin/support/threads/${conversation}`, null, supportHeaders);

  const detail = r.body?.data;

  check('opening it → 200', r.status === 200 && !!detail, {
    status: r.status,
    error: r.body?.error,
  });
  check('with the member panel', detail?.memberSummary?.id === asker.id, detail?.memberSummary?.id);
  check(
    'carrying what a support agent needs and no more',
    typeof detail?.memberSummary?.openCases === 'number' &&
      typeof detail?.memberSummary?.activeStrikes === 'number' &&
      Array.isArray(detail?.memberSummary?.pinnedNotes),
    {
      openCases: detail?.memberSummary?.openCases,
      strikes: detail?.memberSummary?.activeStrikes,
    },
  );
  check(
    'masking their email, as every admin payload does (S8.4)',
    (detail?.memberSummary?.emailMasked ?? '').includes('•'),
    detail?.memberSummary?.emailMasked,
  );
  check(
    'the managed request it came from',
    detail?.linked?.managedRequestId === managed?.id,
    detail?.linked,
  );
  check(
    'no Guard case, because this is not one',
    detail?.linked?.guardCaseId === null,
    detail?.linked,
  );
  check('and the notes written on it', Array.isArray(detail?.notes), detail?.notes);

  r = await api(
    null,
    'POST',
    '/admin/notes',
    {
      subjectType: 'SUPPORT_THREAD',
      subjectId: conversation,
      body: 'Member is travelling from the 12th; keep listings live.',
    },
    supportHeaders,
  );

  check('a note on an ordinary support thread → 201', r.status === 201, {
    status: r.status,
    error: r.body?.error,
  });

  r = await api(null, 'GET', `/admin/support/threads/${conversation}`, null, supportHeaders);

  check(
    'and it comes back with the thread',
    (r.body?.data?.notes ?? []).length === 1,
    r.body?.data?.notes?.length,
  );

  r = await api(
    null,
    'POST',
    '/admin/escalations',
    {
      memberId: asker.id,
      category: 'OTHER',
      note: 'Member asked us to take over the store while they travel; needs a second opinion.',
      conversationId: conversation,
    },
    { ...supportHeaders, 'Idempotency-Key': `inbox-esc-${Math.random().toString(36).slice(2)}` },
  );

  check('raising an escalation from the thread → 201', r.status === 201, r.body?.error);

  r = await api(null, 'GET', `/admin/support/threads/${conversation}`, null, supportHeaders);

  check(
    'which the thread then carries',
    (r.body?.data?.linked?.escalations ?? []).length === 1,
    r.body?.data?.linked?.escalations?.length,
  );

  // ── 10. A thread that is not a support thread ─────────────────────────────
  heading('10. the inbox is not a way into member conversations');

  const first = await makeUser('inbox-dm1', { cityId: 'BRISTOL' });
  const second = await makeUser('inbox-dm2', { cityId: 'BRISTOL' });

  r = await api(first.token, 'POST', '/messages', { recipientUserId: second.id });

  const dm = r.body?.data?.id ?? r.body?.data?.conversationId;

  if (dm) {
    r = await api(null, 'GET', `/admin/support/threads/${dm}`, null, supportHeaders);

    check(
      'a member conversation is refused with the access grant it needs',
      r.status === 403 && r.body?.error?.code === 'THREAD_ACCESS_REQUIRED',
      { status: r.status, code: r.body?.error?.code },
    );
  } else {
    check('a direct conversation could be created for the check', false, r.body?.error);
  }

  r = await api(
    null,
    'GET',
    '/admin/support/threads/00000000-0000-4000-8000-000000000000',
    null,
    supportHeaders,
  );

  check('and an id that is nobody’s is a 404', r.status === 404, { status: r.status });

  // ── 11. The dashboard ─────────────────────────────────────────────────────
  heading('11. the attention item, which counts no disclosures');

  r = await api(null, 'GET', '/admin/dashboard/attention', null, supportHeaders);

  const item = (r.body?.data ?? []).find(entry => entry.id === 'unassignedSupportThreads');

  check(
    'support sees the unassigned item',
    !!item,
    (r.body?.data ?? []).map(entry => entry.id),
  );
  check('counting the threads nobody has', item?.count >= 1, item);

  const before = item?.count;
  const extraDiscloser = await makeUser('inbox-discloser2', { cityId: 'MANCHESTER' });

  await api(extraDiscloser.token, 'POST', '/guard/threads', {
    subject: 'Another thing I cannot post',
    message: 'Somebody from a group has been following me home and I do not know what to do.',
    categoryCode: 'SAFETY',
  });

  r = await api(null, 'GET', '/admin/dashboard/attention', null, supportHeaders);

  const after = (r.body?.data ?? []).find(entry => entry.id === 'unassignedSupportThreads');

  check(
    'and a new disclosure does not move it: the count would be a disclosure of its own',
    after?.count === before,
    { before, after: after?.count },
  );

  await sweep('post-run');
  await finish();
}

main().catch(fail);
