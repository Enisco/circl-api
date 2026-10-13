/**
 * §4.8 and §7.6: the staff side of a support conversation.
 *
 * The thing this suite is really about is **who may read a safeguarding disclosure**. A Guard
 * thread and a deal problem are created with the same conversation key — `contextType: SUPPORT`
 * with a null context id — so for a member who has had both they are *one conversation*, by design
 * (D36: a second disclosure continues the first thread rather than opening another beside it).
 *
 * §5.15 then excludes `type = GUARD` threads from the support inbox for anybody without
 * `guard:read`, and lists every other type to the whole support team. So the type that one
 * conversation settles on decides whether a disclosure is private — and if the *later* claim won,
 * a member reporting a late parcel would publish their own disclosure to the support team.
 *
 * The rest is §7.6's state machine, which has to run on the **member's** send path: a reply that
 * reopens a resolved thread and does not say so is a thread nobody is watching with a question
 * sitting in it.
 */
const {
  adminHeaders,
  api,
  check,
  fail,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);

const threadFor = conversationId => prisma.supportThread.findUnique({ where: { conversationId } });

async function main() {
  await sweep('pre-run');

  // ── 1. Every support conversation gets its staff row ──────────────────────
  heading('1. a support conversation arrives with its staff row');

  const discloser = await makeUser('st-discloser', { cityId: 'MANCHESTER' });

  let r = await api(discloser.token, 'POST', '/guard/threads', {
    subject: 'Something I cannot post publicly',
    message: 'My landlord has kept my passport since March and says I owe him for it.',
    categoryCode: 'SAFETY',
  });

  const guardConversation = r.body?.data?.conversationId;

  check('a Guard thread opens → 201', r.status === 201 && !!guardConversation, r.body?.error);

  const guardThread = await threadFor(guardConversation);

  check('with a support thread row beside it', !!guardThread, guardThread);
  check(
    'typed GUARD, which is what keeps it out of the support inbox',
    guardThread?.type === 'GUARD',
    guardThread?.type,
  );
  check('belonging to the member who disclosed', guardThread?.memberId === discloser.id, {
    got: guardThread?.memberId,
    want: discloser.id,
  });
  check(
    'and created at the conversation’s own age, not backfilled as new',
    !!guardThread?.createdAt,
    guardThread?.createdAt,
  );

  // The member's opening message is a member message, so the clock has started and nothing has
  // answered it yet.
  check(
    'the member’s own words start the SLA clock',
    !!guardThread?.firstMemberMessageAt && guardThread?.firstResponseAt === null,
    {
      firstMember: guardThread?.firstMemberMessageAt,
      firstResponse: guardThread?.firstResponseAt,
    },
  );
  check(
    'and the thread is NEW: nobody has answered it',
    guardThread?.state === 'NEW',
    guardThread?.state,
  );

  // ── 2. A member writing again does not make it answered ───────────────────
  heading('2. NEW survives a second member message');

  r = await api(discloser.token, 'POST', `/messages/${guardConversation}/messages`, {
    body: 'I forgot to say that he has my bank card as well.',
    clientId: `st-${Date.now()}-a`,
  });

  check('the member writes again → 201', r.status === 201, r.body?.error);

  let after = await threadFor(guardConversation);

  check(
    'still NEW, because nobody has answered — the unanswered count depends on it',
    after?.state === 'NEW',
    after?.state,
  );
  check(
    'the last member message moved, the first did not',
    after?.lastMemberMessageAt > after?.firstMemberMessageAt &&
      after?.firstMemberMessageAt?.getTime() === guardThread?.firstMemberMessageAt?.getTime(),
    { first: after?.firstMemberMessageAt, last: after?.lastMemberMessageAt },
  );
  check(
    'and no response time was invented',
    after?.firstResponseAt === null,
    after?.firstResponseAt,
  );

  // ── 3. The leak, through the path that raises ─────────────────────────────
  heading('3. a Guard disclosure cannot be relabelled');

  const shared = await prisma.conversation.findUnique({
    where: { id: guardConversation },
    select: { contextType: true, contextId: true },
  });

  check(
    'the Guard thread uses the very key a deal problem would use',
    shared?.contextType === 'SUPPORT' && shared?.contextId === null,
    shared,
  );

  // The "deal problem first, Guard second" order, through the real factory. The prior state is
  // set directly — a deal fixture is not what is being tested — and then a genuine
  // `POST /guard/threads` for the same member must raise the row back to GUARD. If the later
  // claim won, or if the factory simply left an existing row alone, this stays DEAL_PROBLEM and
  // §5.15 lists the disclosure to the whole support team.
  //
  // The other order, and every other pair, is covered exhaustively in
  // `support-thread-rules.spec.ts`: the rule is a pure function, and this is the wiring.
  await prisma.supportThread.update({
    where: { conversationId: guardConversation },
    data: { type: 'DEAL_PROBLEM' },
  });

  const beforeRaise = await threadFor(guardConversation);

  check(
    'the row is DEAL_PROBLEM to begin with',
    beforeRaise?.type === 'DEAL_PROBLEM',
    beforeRaise?.type,
  );

  r = await api(discloser.token, 'POST', '/guard/threads', {
    subject: 'More about the same thing',
    message: 'He came back last night and I want to add that to what I told you.',
    categoryCode: 'SAFETY',
  });

  check('a second disclosure from the same member → 201', r.status === 201, r.body?.error);
  check(
    'landing in the same conversation (D36) rather than a second one',
    r.body?.data?.conversationId === guardConversation,
    { got: r.body?.data?.conversationId, want: guardConversation },
  );

  after = await threadFor(guardConversation);

  check(
    'and the row is raised back to GUARD, not left as the support team can read',
    after?.type === 'GUARD',
    after?.type,
  );
  check(
    'with nothing else about the thread reset by the second claim',
    after?.createdAt?.getTime() === beforeRaise?.createdAt?.getTime() &&
      after?.firstMemberMessageAt?.getTime() === beforeRaise?.firstMemberMessageAt?.getTime() &&
      after?.reopenCount === beforeRaise?.reopenCount,
    {
      createdAt: [beforeRaise?.createdAt, after?.createdAt],
      firstMember: [beforeRaise?.firstMemberMessageAt, after?.firstMemberMessageAt],
    },
  );

  const second = await makeUser('st-second', { cityId: 'MANCHESTER' });

  r = await api(second.token, 'POST', '/guard/threads', {
    subject: 'A disclosure from somebody else entirely',
    message: 'I am being threatened by somebody I used to live with and I need advice.',
    categoryCode: 'SAFETY',
  });

  check(
    'another member’s disclosure is its own conversation, not shared',
    r.status === 201 && r.body?.data?.conversationId !== guardConversation,
    { first: guardConversation, second: r.body?.data?.conversationId },
  );
  check(
    'and its own GUARD row',
    (await threadFor(r.body?.data?.conversationId))?.type === 'GUARD',
    await threadFor(r.body?.data?.conversationId),
  );

  // ── 4. A staff reply answers it and hands it back ─────────────────────────
  heading('4. a staff reply sets the response time and hands it back');

  const safety = await makeAdmin('st-safety', 'trust_safety');
  const guardCase = await prisma.guardThread.findFirst({
    where: { conversationId: guardConversation },
    select: { id: true },
  });

  check('the Guard case is findable by its conversation', !!guardCase, guardCase);

  const answered = await threadFor(guardConversation);

  r = await api(
    null,
    'POST',
    `/admin/guard/cases/${guardCase?.id}/messages`,
    {
      body: 'We have read this and somebody is looking at it now. You are not in trouble.',
      clientId: `st-staff-${Math.random().toString(36).slice(2)}`,
    },
    adminHeaders(safety),
  );

  check('Trust & Safety reply → 201', r.status === 201, r.body?.error);

  after = await threadFor(guardConversation);

  check(
    'the response time is set, from the first staff message after the member’s first',
    !!after?.firstResponseAt && answered?.firstResponseAt === null,
    { before: answered?.firstResponseAt, after: after?.firstResponseAt },
  );
  check(
    'and the thread is handed back to the member',
    after?.state === 'WAITING_ON_MEMBER',
    after?.state,
  );
  check(
    'with the staff timestamp recorded',
    !!after?.lastStaffMessageAt,
    after?.lastStaffMessageAt,
  );

  const responseAt = after?.firstResponseAt;

  r = await api(
    null,
    'POST',
    `/admin/guard/cases/${guardCase?.id}/messages`,
    {
      body: 'One more thing, so that a second reply can be seen not to move the first response.',
      clientId: `st-staff2-${Math.random().toString(36).slice(2)}`,
    },
    adminHeaders(safety),
  );

  check('a second staff reply → 201', r.status === 201, r.body?.error);

  after = await threadFor(guardConversation);

  check(
    'the response time is the **first** reply, and does not move',
    after?.firstResponseAt?.getTime() === responseAt?.getTime(),
    { was: responseAt, now: after?.firstResponseAt },
  );

  // ── 5. The member comes back, and a resolved thread reopens ───────────────
  heading('5. the member comes back, and a settled thread reopens');

  r = await api(discloser.token, 'POST', `/messages/${guardConversation}/messages`, {
    body: 'Thank you. He has gone to his brother’s so I am alright for tonight.',
    clientId: `st-${Date.now()}-b`,
  });

  check('the member answers → 201', r.status === 201, r.body?.error);

  after = await threadFor(guardConversation);

  check('a thread waiting on the member comes back to OPEN', after?.state === 'OPEN', after?.state);
  check('and that is not a reopen', after?.reopenCount === 0, after?.reopenCount);

  await prisma.supportThread.update({
    where: { conversationId: guardConversation },
    data: { state: 'RESOLVED', resolvedAt: new Date() },
  });

  r = await api(discloser.token, 'POST', `/messages/${guardConversation}/messages`, {
    body: 'It has started again and I did not know who else to tell about it.',
    clientId: `st-${Date.now()}-c`,
  });

  check('the member writes into a resolved thread → 201', r.status === 201, r.body?.error);

  after = await threadFor(guardConversation);

  check('which reopens it', after?.state === 'OPEN', after?.state);
  check('counts the reopen', after?.reopenCount === 1, after?.reopenCount);
  check(
    'and clears the resolution, because it is not resolved any more',
    after?.resolvedAt === null,
    after?.resolvedAt,
  );

  // ── 6. Only support conversations get a row ───────────────────────────────
  heading('6. and nothing else on the platform grows one');

  const ordinary = await prisma.conversation.findFirst({
    where: { kind: { not: 'SUPPORT' }, supportThread: { isNot: null } },
    select: { id: true, kind: true },
  });

  check('no conversation of any other kind has a support thread row', ordinary === null, ordinary);

  const orphan = await prisma.conversation.count({
    where: { kind: 'SUPPORT', supportThread: null },
  });

  check(
    'and no support conversation is missing one, which would make it invisible to the inbox',
    orphan === 0,
    orphan,
  );

  await sweep('support-threads');
  await finish();
}

main().catch(fail);
