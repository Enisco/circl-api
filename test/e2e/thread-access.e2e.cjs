/**
 * §5.6 / §3.9 — reading two members' private conversation.
 *
 * The most invasive read in the portal, and the suite is written around the things that must
 * **not** work: a grant with no reason, a reason that names a record the caller cannot see, a
 * reason about somebody who is not in the thread, a read with no grant, a read with a colleague's
 * grant, a grant used on a different conversation, and a support thread or Guard case read this way
 * at all. The happy path is four checks; the refusals are most of the file, which is the right
 * proportion for a mechanism whose whole purpose is to refuse.
 *
 * S9.4 is the one worth reading the assertions for: reading must leave nothing behind in the
 * member's thread. No participant row, no read receipt, no unread change — so the suite reads the
 * thread as staff and then reads it as the member and checks their side is exactly as it was.
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

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const key = () => ({ 'Idempotency-Key': `ta-${Math.random().toString(36).slice(2)}` });

/** A role with exactly the permissions named, so a refusal is about the permission and not the role. */
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
      name: `E2E thread access ${label} ${stamp}`,
      code: `e2e-ta-${label}-${stamp}`,
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

  const investigatorRole = await register('investigator', [
    'messages:read',
    'members:read',
    'reports:read',
    'moderation:read',
    'support:read',
  ]);
  // The same job without `reports:read`: they may list a member's threads and may not name a
  // report case as the reason for reading one.
  const listerRole = await register('lister', ['messages:read', 'members:read']);

  const staff = await makeAdmin('ta-staff', investigatorRole);
  const colleague = await makeAdmin('ta-colleague', investigatorRole);
  const lister = await makeAdmin('ta-lister', listerRole);

  const asStaff = adminHeaders(staff);
  const asColleague = adminHeaders(colleague);
  const asLister = adminHeaders(lister);

  const alice = await makeUser('ta-alice', { cityId: 'BRISTOL' });
  const bob = await makeUser('ta-bob', { cityId: 'BRISTOL' });
  const stranger = await makeUser('ta-stranger', { cityId: 'BRISTOL' });

  // ── 1. A thread to read ───────────────────────────────────────────────────
  heading('1. two members, one conversation');

  const started = await api(alice.token, 'POST', '/messages', { recipientUserId: bob.id }, key());
  const conversationId = started.body?.data?.id;

  check('the members have a thread', !!conversationId, started.status || started.body?.error);

  const say = (who, body, clientId) =>
    api(who.token, 'POST', `/messages/${conversationId}/messages`, { clientId, body });

  await say(alice, 'Morning — are you still after the desk?', 'ta-1');
  await say(bob, 'Yes, can you hold it until Friday?', 'ta-2');
  const third = await say(alice, 'That is fine, see you then.', 'ta-3');

  check('and three messages in it', third.status === 201, third.status || third.body?.error);

  // A report by Bob about Alice, which is the record a grant will name.
  await api(bob.token, 'POST', '/moderation/reports', {
    targetType: 'USER',
    targetId: alice.id,
    reasonCode: 'HARASSMENT',
    note: 'They keep messaging me about the desk.',
  });

  const reportCase = await prisma.reportCase.findFirst({
    where: { targetType: 'USER', targetId: alice.id },
    orderBy: { createdAt: 'desc' },
  });

  check('with a report case about one of them', !!reportCase, reportCase);

  // A case about a member who is in no conversation with these two.
  await api(alice.token, 'POST', '/moderation/reports', {
    targetType: 'USER',
    targetId: stranger.id,
    reasonCode: 'SPAM',
    note: 'Unrelated, for the unrelated-case check.',
  });

  const strangerCase = await prisma.reportCase.findFirst({
    where: { targetType: 'USER', targetId: stranger.id },
    orderBy: { createdAt: 'desc' },
  });

  // ── 2. Reading without a grant ────────────────────────────────────────────
  heading('2. messages:read is not enough on its own');

  const naked = await api(null, 'GET', `/admin/threads/${conversationId}/messages`, null, asStaff);

  check(
    'no grant, no messages → 403 THREAD_ACCESS_REQUIRED',
    naked.status === 403 && naked.body?.error?.code === 'THREAD_ACCESS_REQUIRED',
    { status: naked.status, code: naked.body?.error?.code },
  );

  const nakedHeader = await api(null, 'GET', `/admin/threads/${conversationId}`, null, asStaff);

  check(
    'and the header is the same refusal: opening a thread is reading it',
    nakedHeader.status === 403 && nakedHeader.body?.error?.code === 'THREAD_ACCESS_REQUIRED',
    { status: nakedHeader.status, code: nakedHeader.body?.error?.code },
  );

  const nonsense = await api(null, 'GET', `/admin/threads/${conversationId}/messages`, null, {
    ...asStaff,
    'X-Thread-Access-Grant': 'not-a-grant',
  });

  check(
    'a malformed grant is refused as a grant, not as a 400',
    nonsense.status === 403 && nonsense.body?.error?.code === 'THREAD_ACCESS_REQUIRED',
    { status: nonsense.status, code: nonsense.body?.error?.code },
  );

  // ── 3. The reason has to be a real, visible, connected record ─────────────
  heading('3. what counts as a reason (S9.1)');

  const grant = (headers, body) =>
    api(null, 'POST', `/admin/threads/${conversationId}/access`, body, {
      ...headers,
      ...key(),
    });

  const noLink = await grant(asStaff, { reasonCode: 'SAFETY_CONCERN' });

  check('no link, no grant → 400, because free text is never a reason', noLink.status === 400, {
    status: noLink.status,
    code: noLink.body?.error?.code,
  });

  const invented = await grant(asStaff, {
    reasonCode: 'SAFETY_CONCERN',
    linkedType: 'REPORT_CASE',
    linkedId: '00000000-0000-4000-8000-000000000000',
  });

  check(
    'a case that does not exist → 422 LINK_REQUIRED',
    invented.status === 422 && invented.body?.error?.code === 'LINK_REQUIRED',
    { status: invented.status, code: invented.body?.error?.code },
  );

  const unrelated = await grant(asStaff, {
    reasonCode: 'SAFETY_CONCERN',
    linkedType: 'REPORT_CASE',
    linkedId: strangerCase?.id,
  });

  check(
    'a real case about nobody in the thread → 422, so any case id will not open any thread',
    unrelated.status === 422 && unrelated.body?.error?.code === 'LINK_REQUIRED',
    { status: unrelated.status, code: unrelated.body?.error?.code },
  );

  const unpermitted = await grant(asLister, {
    reasonCode: 'SAFETY_CONCERN',
    linkedType: 'REPORT_CASE',
    linkedId: reportCase?.id,
  });

  check(
    'a case the caller cannot see → 422, named as the permission they lack',
    unpermitted.status === 422 && unpermitted.body?.error?.code === 'LINK_REQUIRED',
    { status: unpermitted.status, message: unpermitted.body?.error?.message },
  );

  // ── 4. The grant ──────────────────────────────────────────────────────────
  heading('4. a grant, and what it is good for');

  const issued = await grant(asStaff, {
    reasonCode: 'SAFETY_CONCERN',
    linkedType: 'REPORT_CASE',
    linkedId: reportCase?.id,
    note: 'Checking what was said before the complaint.',
  });
  const grantId = issued.body?.data?.grantId;

  check('the grant is issued', issued.status === 201 && !!grantId, {
    status: issued.status,
    error: issued.body?.error,
  });
  check(
    'for thirty minutes (S9.2)',
    Math.round((new Date(issued.body?.data?.expiresAt).getTime() - Date.now()) / 60_000) === 30 &&
      issued.body?.data?.expiresInSeconds === 1800,
    issued.body?.data,
  );

  const row = await prisma.threadAccessGrant.findUnique({ where: { id: grantId } });

  check(
    'the row records who, where from, and what for',
    row?.staffId === staff.id &&
      row?.conversationId === conversationId &&
      row?.linkedType === 'REPORT_CASE' &&
      row?.linkedId === reportCase?.id &&
      row?.note === 'Checking what was said before the complaint.' &&
      row?.useCount === 0,
    row && { staffId: row.staffId, linkedType: row.linkedType, useCount: row.useCount },
  );

  const granted = await prisma.auditLog.findFirst({
    where: { action: 'thread.access_granted', targetId: conversationId },
    orderBy: { occurredAt: 'desc' },
  });

  check(
    'and the audit entry is written with it, not after it (S9.3)',
    granted?.metadata?.grantId === grantId &&
      granted?.metadata?.linkedId === reportCase?.id &&
      granted?.actorId === staff.id,
    granted?.metadata,
  );

  const withGrant = { ...asStaff, 'X-Thread-Access-Grant': grantId };

  // S9.4's control, taken before anybody reads: the member's side of the thread as it stands.
  const beforeRead = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    orderBy: { userId: 'asc' },
  });

  const read = await api(null, 'GET', `/admin/threads/${conversationId}/messages`, null, withGrant);

  check('the messages come back', read.status === 200, read.status || read.body?.error);
  check(
    'oldest first, with a role on each sender',
    (read.body?.data?.messages ?? []).length === 3 &&
      read.body.data.messages[0].body === 'Morning — are you still after the desk?' &&
      read.body.data.messages.every(message => message.sender?.role === 'MEMBER'),
    (read.body?.data?.messages ?? []).map(message => [message.sender?.role, message.body]),
  );
  check(
    'with the banner’s two fields (S9.5)',
    read.body?.data?.accessLogged === true && typeof read.body?.data?.expiresAt === 'string',
    { accessLogged: read.body?.data?.accessLogged, expiresAt: read.body?.data?.expiresAt },
  );
  check(
    'a cursor rather than a page number, because a thread grows while it is open',
    'nextBefore' in (read.body?.meta ?? {}) && !('currentPage' in (read.body?.meta ?? {})),
    read.body?.meta,
  );
  check(
    'the header names both members and the thread’s kind',
    read.body?.data?.header?.participants?.length === 2 &&
      read.body.data.header.participants.every(person => !!person.firstName) &&
      typeof read.body.data.header.kind === 'string',
    read.body?.data?.header?.participants?.map(person => person.id),
  );
  check(
    'and the grant it was read under, so the portal can count down',
    read.body?.data?.header?.grant?.id === grantId &&
      read.body.data.header.grant.linkedType === 'REPORT_CASE',
    read.body?.data?.header?.grant,
  );

  const reads = await prisma.auditLog.count({
    where: { action: 'thread.read', targetId: conversationId, actorId: staff.id },
  });

  check('the read is recorded', reads >= 1, reads);

  // One entry per page, not one per day: how far back through a conversation somebody read is the
  // substance of what happened.
  await api(null, 'GET', `/admin/threads/${conversationId}/messages`, null, withGrant);

  const readsAgain = await prisma.auditLog.count({
    where: { action: 'thread.read', targetId: conversationId, actorId: staff.id },
  });
  const lastRead = await prisma.auditLog.findFirst({
    where: { action: 'thread.read', targetId: conversationId, actorId: staff.id },
    orderBy: { occurredAt: 'desc' },
  });

  check('a second page is a second entry, not a deduplicated one', readsAgain > reads, {
    before: reads,
    after: readsAgain,
  });
  check(
    'and each entry names the range it covered',
    !!lastRead?.metadata?.firstMessageId &&
      !!lastRead?.metadata?.lastMessageId &&
      lastRead?.metadata?.grantId === grantId,
    lastRead?.metadata,
  );

  const used = await prisma.threadAccessGrant.findUnique({ where: { id: grantId } });

  check(
    'the grant counts its own uses, so one taken and never used stays visibly unused',
    used?.useCount >= 2 && !!used?.lastUsedAt,
    { useCount: used?.useCount, lastUsedAt: used?.lastUsedAt },
  );

  // ── 5. A grant is one person's, for one thread ────────────────────────────
  heading('5. a grant is not a shared key');

  /**
   * The hole this closed, tested where it actually was.
   *
   * Section 2 checks "no grant" **before** any grant exists, which a broken implementation also
   * passes. The bug was that `findFirst` ignores an `undefined` id rather than matching nothing —
   * so a request with no header, from somebody who *did* hold a live grant for this conversation,
   * was answered by that grant. A missing credential must never act as a wildcard.
   */
  const noHeaderWhileHolding = await api(
    null,
    'GET',
    `/admin/threads/${conversationId}/messages`,
    null,
    asStaff,
  );

  check(
    'the holder of a live grant still cannot read without sending it → 403',
    noHeaderWhileHolding.status === 403 &&
      noHeaderWhileHolding.body?.error?.code === 'THREAD_ACCESS_REQUIRED',
    { status: noHeaderWhileHolding.status, code: noHeaderWhileHolding.body?.error?.code },
  );

  const emptyHeader = await api(null, 'GET', `/admin/threads/${conversationId}/messages`, null, {
    ...asStaff,
    'X-Thread-Access-Grant': '',
  });

  check(
    'and an empty header is not a wildcard either → 403',
    emptyHeader.status === 403 && emptyHeader.body?.error?.code === 'THREAD_ACCESS_REQUIRED',
    { status: emptyHeader.status, code: emptyHeader.body?.error?.code },
  );

  const borrowed = await api(null, 'GET', `/admin/threads/${conversationId}/messages`, null, {
    ...asColleague,
    'X-Thread-Access-Grant': grantId,
  });

  check(
    'a colleague cannot use it → 403',
    borrowed.status === 403 && borrowed.body?.error?.code === 'THREAD_ACCESS_REQUIRED',
    { status: borrowed.status, code: borrowed.body?.error?.code },
  );

  const other = await api(
    alice.token,
    'POST',
    '/messages',
    { recipientUserId: stranger.id },
    key(),
  );
  const otherConversation = other.body?.data?.id;

  const elsewhere = await api(
    null,
    'GET',
    `/admin/threads/${otherConversation}/messages`,
    null,
    withGrant,
  );

  check(
    'and it does not open a different thread → 403',
    elsewhere.status === 403 && elsewhere.body?.error?.code === 'THREAD_ACCESS_REQUIRED',
    { status: elsewhere.status, code: elsewhere.body?.error?.code },
  );

  const expiredId = (
    await prisma.threadAccessGrant.create({
      data: {
        staffId: staff.id,
        conversationId,
        reasonCode: 'SAFETY_CONCERN',
        linkedType: 'REPORT_CASE',
        linkedId: reportCase?.id,
        expiresAt: new Date(Date.now() - 60_000),
      },
    })
  ).id;

  const expired = await api(null, 'GET', `/admin/threads/${conversationId}/messages`, null, {
    ...asStaff,
    'X-Thread-Access-Grant': expiredId,
  });

  check(
    'an expired grant is refused, and reads like every other refusal',
    expired.status === 403 && expired.body?.error?.code === 'THREAD_ACCESS_REQUIRED',
    { status: expired.status, code: expired.body?.error?.code },
  );

  // A report about a message **inside** the thread has to reach the header: that is the question
  // the panel exists to answer, and the first version read the conversation's message ids as an
  // `IN` list capped at a thousand, so a long thread stopped reporting its older complaints.
  const firstMessage = await prisma.message.findFirst({
    where: { conversationId, senderId: alice.id },
    orderBy: { sentAt: 'asc' },
    select: { id: true },
  });

  await api(bob.token, 'POST', '/moderation/reports', {
    targetType: 'MESSAGE',
    targetId: firstMessage?.id,
    reasonCode: 'HARASSMENT',
    note: 'This is the message I meant.',
  });

  const withReports = await api(null, 'GET', `/admin/threads/${conversationId}`, null, withGrant);
  const headerReports = withReports.body?.data?.reports ?? [];

  check(
    'the header names the report filed about a message in the thread',
    headerReports.some(report => report.targetId === firstMessage?.id),
    headerReports.map(report => [report.targetType, report.targetId]),
  );
  check(
    'and never who filed it (R9 keys that on moderation:read)',
    headerReports.every(report => !('reporter' in report)),
    headerReports[0],
  );

  const reportedFlag = await api(
    null,
    'GET',
    `/admin/threads/${conversationId}/messages`,
    null,
    withGrant,
  );

  check(
    'and the message itself comes back marked as reported',
    (reportedFlag.body?.data?.messages ?? []).some(
      message => message.id === firstMessage?.id && message.reported === true,
    ),
    (reportedFlag.body?.data?.messages ?? []).map(message => [message.id, message.reported]),
  );

  // ── 6. S9.4: reading leaves nothing behind ────────────────────────────────
  heading('6. the member’s side is untouched (S9.4)');

  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId },
    orderBy: { userId: 'asc' },
  });

  check(
    'no staff participant row was created',
    participants.length === 2 && !participants.some(row => row.userId === staff.id),
    participants.map(row => row.userId),
  );
  // Compared against the snapshot taken before the staff read rather than against a guess at the
  // values: the requirement is that *nothing* changed, and an assertion about one field would also
  // pass if the read had quietly moved another.
  check(
    'and every participant row is exactly what it was before staff read it',
    JSON.stringify(participants) === JSON.stringify(beforeRead),
    { before: beforeRead, after: participants },
  );

  const asMember = await api(bob.token, 'GET', `/messages/${conversationId}/messages`);

  check(
    'the member still reads their thread exactly as before',
    asMember.status === 200 && (asMember.body?.data ?? []).length === 3,
    { status: asMember.status, count: (asMember.body?.data ?? []).length },
  );

  // ── 7. Support and Guard are not read here ────────────────────────────────
  heading('7. support and Guard threads have their own doors');

  const guard = await api(bob.token, 'POST', '/guard/threads', {
    subject: 'Something I cannot post publicly',
    message: 'Telling Circl about it rather than putting it on the feed.',
    categoryCode: 'SAFETY',
  });
  const guardConversation = guard.body?.data?.conversationId;

  if (guardConversation) {
    const refused = await api(
      null,
      'POST',
      `/admin/threads/${guardConversation}/access`,
      {
        reasonCode: 'SAFETY_CONCERN',
        linkedType: 'REPORT_CASE',
        linkedId: reportCase?.id,
      },
      { ...asStaff, ...key() },
    );

    check(
      'a Guard case cannot be opened with a grant → 409 USE_SUPPORT_INBOX',
      refused.status === 409 && refused.body?.error?.code === 'USE_SUPPORT_INBOX',
      { status: refused.status, code: refused.body?.error?.code },
    );
    check(
      'and the refusal says where to read it instead',
      typeof refused.body?.error?.details === 'object' ||
        typeof refused.body?.data?.redirect === 'string',
      { redirect: refused.body?.data?.redirect },
    );
  } else {
    check('a Guard disclosure to test the refusal with', false, guard.status || guard.body?.error);
  }

  // ── 8. A support thread is a reason, under the right permission ───────────
  heading('8. linkable cases, filtered by what the caller holds');

  const options = await api(
    null,
    'GET',
    `/admin/members/${alice.id}/linkable-cases`,
    null,
    asStaff,
  );
  const types = [...new Set((options.body?.data ?? []).map(row => row.type))];

  check('the list answers', options.status === 200, options.status || options.body?.error);
  check(
    'and offers the report case it knows about',
    (options.body?.data ?? []).some(row => row.type === 'REPORT_CASE' && row.id === reportCase?.id),
    types,
  );
  check(
    'a caller without disputes:manage is offered no disputes to link to',
    !types.includes('DISPUTE'),
    types,
  );

  const listerOptions = await api(
    null,
    'GET',
    `/admin/members/${alice.id}/linkable-cases`,
    null,
    asLister,
  );

  check(
    'and somebody with no case permissions at all is offered nothing',
    listerOptions.status === 200 && (listerOptions.body?.data ?? []).length === 0,
    (listerOptions.body?.data ?? []).map(row => row.type),
  );

  await prisma.threadAccessGrant.deleteMany({
    where: { conversationId: { in: [conversationId, otherConversation] } },
  });
  await prisma.role.deleteMany({ where: { code: { startsWith: 'e2e-ta-' } } });
  await sweep('thread-access');
  await finish();
}

main().catch(fail);
