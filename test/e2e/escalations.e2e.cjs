/**
 * §5.10's second half: Support hands a member's problem to Trust & Safety.
 *
 * The thing worth testing here is what an escalation **is not**. A report case is grouped by
 * target, so three people reporting one post is one piece of work; an escalation is one colleague
 * asking another about a *member*, and two about the same person are two asks with two answers.
 * Get that wrong and the second ask disappears into the first — silently, because the endpoint
 * still answers 201.
 *
 * The other half is the staff report. An escalation with a target does not describe work, it
 * **files** it: the content goes into the report queue through the same path a member's report
 * takes, so §7.1's grouping, snapshotting and re-scan all apply, and `SAFETY` or `SCAM` makes that
 * case urgent. That is asserted through the queue rather than from the escalation's own payload,
 * because the payload would say `reportCaseId` whether or not a reviewer could ever see it.
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

async function main() {
  await sweep('pre-run');

  // Raised by Support, answered by Trust & Safety — deliberately two different people with two
  // different permissions, which is the arrangement the endpoints are built for.
  const support = await makeAdmin('esc-support', 'support');
  const safety = await makeAdmin('esc-safety', 'trust_safety');
  const supportHeaders = adminHeaders(support);
  const safetyHeaders = adminHeaders(safety);

  const member = await makeUser('esc-member', { cityId: 'BRISTOL' });
  const other = await makeUser('esc-other', { cityId: 'BRISTOL' });

  const key = prefix => ({ 'Idempotency-Key': `${prefix}-${Math.random().toString(36).slice(2)}` });

  // ── 0. Who may do what ────────────────────────────────────────────────────
  heading('0. raising and answering are different permissions');

  // The two halves are held by two roles, and neither holds both. Trust & Safety read and answer
  // escalations; they do not raise them, because `reports:escalate` is what somebody in front of a
  // member does when they need T&S to look. So the pair below is not an accident of the seed — it
  // is the separation the endpoints are built on, and a role gaining the other permission would
  // turn "ask a colleague" into "ask yourself".
  let r = await api(
    null,
    'POST',
    '/admin/escalations',
    {
      memberId: member.id,
      category: 'OTHER',
      note: 'Trust & Safety answer escalations rather than raising them.',
    },
    { ...safetyHeaders, ...key('esc-perm') },
  );

  check(
    'Trust & Safety cannot raise one: `reports:escalate` is for whoever is with the member',
    r.status === 403,
    { status: r.status, error: r.body?.error?.code },
  );

  r = await api(
    null,
    'POST',
    '/admin/escalations',
    {
      memberId: member.id,
      category: 'OTHER',
      note: 'Raised by Support, who cannot then close it themselves.',
    },
    { ...supportHeaders, ...key('esc-perm2') },
  );

  const supportRaised = r.body?.data?.id;

  check('Support can raise one → 201', r.status === 201 && !!supportRaised, r.body?.error);

  r = await api(
    null,
    'PATCH',
    `/admin/escalations/${supportRaised}`,
    { state: 'ACKNOWLEDGED' },
    { ...supportHeaders, ...key('esc-perm3') },
  );

  check('and cannot answer it: closing one is `moderation:decide`', r.status === 403, {
    status: r.status,
    error: r.body?.error?.code,
  });

  r = await api(null, 'GET', '/admin/escalations', null, supportHeaders);

  check(
    'but Support can read the list, to see what happened to theirs',
    r.status === 200,
    r.body?.error,
  );

  // ── 1. An escalation about a member, with no content ──────────────────────
  heading('1. an ask about a member, with no content attached');

  r = await api(
    null,
    'POST',
    '/admin/escalations',
    {
      memberId: member.id,
      category: 'ENFORCEMENT_REQUEST',
      note: 'Third complaint this month about the same behaviour. No single post is the problem.',
    },
    { ...supportHeaders, ...key('esc-one') },
  );

  const bare = r.body?.data;

  check('raised → 201', r.status === 201 && !!bare?.id, r.body?.error);
  check('it starts OPEN', bare?.state === 'OPEN', bare?.state);
  check(
    'carrying the member and the colleague who raised it',
    bare?.member?.id === member.id && bare?.raisedBy?.id === support.id,
    { member: bare?.member?.id, raisedBy: bare?.raisedBy?.id },
  );
  check(
    'and no case, because no content was named',
    bare?.reportCaseId === null,
    bare?.reportCaseId,
  );
  check('the note is kept whole', bare?.note?.startsWith('Third complaint'), bare?.note);

  // ── 2. Two asks about one member are two asks ─────────────────────────────
  heading('2. two escalations about one member are two escalations');

  const held = await prisma.escalation.count({ where: { memberId: member.id } });

  r = await api(
    null,
    'POST',
    '/admin/escalations',
    {
      memberId: member.id,
      category: 'HARASSMENT',
      note: 'Separate matter, raised the same day. This must not fold into the one above.',
    },
    { ...supportHeaders, ...key('esc-two') },
  );

  const second = r.body?.data;

  check('the second is its own record → 201', r.status === 201 && !!second?.id, r.body?.error);
  check('with its own id', second?.id !== bare?.id, { first: bare?.id, second: second?.id });
  // Counted as a delta rather than against a fixed number: the point is that a second ask about
  // one member adds a row instead of joining one, which a hardcoded total stops saying the moment
  // a section above raises one more.
  check(
    'and the member has one more escalation, not one grouped case',
    (await prisma.escalation.count({ where: { memberId: member.id } })) === held + 1,
    { before: held, after: await prisma.escalation.count({ where: { memberId: member.id } }) },
  );

  // ── 3. With a target, it files real work ──────────────────────────────────
  heading('3. with a target, it files work rather than describing it');

  const posted = await api(member.token, 'POST', '/community/requests', {
    title: 'A post for an escalation to be filed against',
    description:
      'Clean content on purpose, so the urgency below comes from the category rather than from ' +
      'anything the scanner found in it.',
    categoryCode: 'ACCOMMODATION',
    cityId: 'BRISTOL',
  });
  const targetId = posted.body?.data?.id;

  check('the member has a post', posted.status === 201 && !!targetId, posted.body?.error);

  r = await api(
    null,
    'POST',
    '/admin/escalations',
    {
      memberId: member.id,
      category: 'SCAM',
      note: 'The member sent this to four people in a day asking for a deposit up front.',
      targetType: 'REQUEST',
      targetId,
    },
    { ...supportHeaders, ...key('esc-target') },
  );

  const targeted = r.body?.data;

  check('raised with a target → 201', r.status === 201 && !!targeted?.id, r.body?.error);
  check('and it links to a case', !!targeted?.reportCaseId, targeted?.reportCaseId);

  const filedCase = await prisma.reportCase.findUnique({
    where: { id: targeted?.reportCaseId ?? '00000000-0000-0000-0000-000000000000' },
    select: { id: true, targetType: true, targetId: true, priority: true, reasonCodes: true },
  });

  check(
    'which is a real case about that content',
    filedCase?.targetType === 'REQUEST' && filedCase?.targetId === targetId,
    filedCase,
  );
  check(
    'SCAM makes it URGENT, on clean content, from the category alone',
    filedCase?.priority === 'URGENT',
    { priority: filedCase?.priority, reasons: filedCase?.reasonCodes },
  );

  // Through the queue a reviewer actually reads, not from the escalation's own payload — which
  // would report a `reportCaseId` whether or not anybody could ever see the case.
  //
  // Scoped to the member rather than read off the first page. The unscoped queue is capped at a
  // hundred rows and a sweep fills it, so "is my case in there" passed alone and failed in the
  // sweep — a check that tests the page size rather than the endpoint. `memberId` is the reported
  // member, and this one has exactly this case.
  const queue = await api(
    null,
    'GET',
    `/admin/reports/cases?memberId=${member.id}&state=OPEN,IN_REVIEW&perPage=100`,
    null,
    safetyHeaders,
  );

  check(
    'and Trust & Safety can see it in the report queue',
    (queue.body?.data ?? []).some(row => row.id === targeted?.reportCaseId),
    {
      looking: targeted?.reportCaseId,
      got: (queue.body?.data ?? []).map(row => row.id),
    },
  );
  check(
    'as urgent work, which is what the category was for',
    (queue.body?.data ?? []).find(row => row.id === targeted?.reportCaseId)?.priority === 'URGENT',
    (queue.body?.data ?? []).map(row => [row.id, row.priority]),
  );

  const staffReport = await prisma.report.findFirst({
    where: { reporterId: support.id, targetType: 'REQUEST', targetId },
    select: { caseId: true, note: true, snapshot: true },
  });

  check(
    'the report was filed by the escalating staff member, with a snapshot',
    staffReport?.caseId === targeted?.reportCaseId && !!staffReport?.snapshot,
    { caseId: staffReport?.caseId, hasSnapshot: !!staffReport?.snapshot },
  );

  // A second escalation about the **same** content by the same colleague. No second report is
  // filed — a member tapping report twice does not make two — but the link still has to point
  // somewhere, and it is the same case. This branch answered `null` until `report` was changed to
  // say where a duplicate landed, which would have left an escalation naming content with no case.
  r = await api(
    null,
    'POST',
    '/admin/escalations',
    {
      memberId: member.id,
      category: 'SCAM',
      note: 'Escalating the same post again, having heard from a fourth member about it.',
      targetType: 'REQUEST',
      targetId,
    },
    { ...supportHeaders, ...key('esc-again') },
  );

  check('escalating the same content again → 201', r.status === 201, r.body?.error);
  check(
    'and it links to the same case, not to nothing',
    r.body?.data?.reportCaseId === targeted?.reportCaseId,
    { first: targeted?.reportCaseId, second: r.body?.data?.reportCaseId },
  );
  check(
    'without filing a second report into it',
    (await prisma.report.count({
      where: { reporterId: support.id, targetType: 'REQUEST', targetId },
    })) === 1,
    await prisma.report.count({
      where: { reporterId: support.id, targetType: 'REQUEST', targetId },
    }),
  );

  // ── 4. A half-given target is refused ─────────────────────────────────────
  heading('4. a half-given target is refused, not half-used');

  r = await api(
    null,
    'POST',
    '/admin/escalations',
    {
      memberId: member.id,
      category: 'OTHER',
      note: 'A target type with no id, which cannot mean anything.',
      targetType: 'REQUEST',
    },
    { ...supportHeaders, ...key('esc-half') },
  );

  check(
    'targetType without targetId → 422, rather than an escalation with a dangling type',
    r.status === 422,
    { status: r.status, error: r.body?.error?.code },
  );

  r = await api(
    null,
    'POST',
    '/admin/escalations',
    {
      memberId: '00000000-0000-0000-0000-000000000000',
      category: 'OTHER',
      note: 'About a member who does not exist.',
    },
    { ...supportHeaders, ...key('esc-ghost') },
  );

  check('an unknown member → 404', r.status === 404, {
    status: r.status,
    error: r.body?.error?.code,
  });

  // ── 5. The transitions ───────────────────────────────────────────────────
  heading('5. acknowledged, resolved, and resolved is final');

  r = await api(
    null,
    'PATCH',
    `/admin/escalations/${bare?.id}`,
    { state: 'ACKNOWLEDGED' },
    { ...safetyHeaders, ...key('esc-ack') },
  );

  check('OPEN → ACKNOWLEDGED → 200', r.status === 200, r.body?.error);
  check('the state moved', r.body?.data?.state === 'ACKNOWLEDGED', r.body?.data?.state);

  const acked = await prisma.escalation.findUnique({
    where: { id: bare?.id },
    select: { acknowledgedById: true, acknowledgedAt: true, resolutionNote: true },
  });

  check(
    'with who answered recorded on the row, not only in the audit trail',
    acked?.acknowledgedById === safety.id && !!acked?.acknowledgedAt,
    acked,
  );

  r = await api(
    null,
    'PATCH',
    `/admin/escalations/${bare?.id}`,
    { state: 'OPEN' },
    { ...safetyHeaders, ...key('esc-back') },
  );

  check('and it cannot be put back to OPEN → 400 from the validator', r.status === 400, {
    status: r.status,
    error: r.body?.error?.code,
  });

  r = await api(
    null,
    'PATCH',
    `/admin/escalations/${bare?.id}`,
    { state: 'ACKNOWLEDGED' },
    { ...safetyHeaders, ...key('esc-reack') },
  );

  check(
    'nor acknowledged twice → 409 INVALID_TRANSITION',
    r.status === 409 && r.body?.error?.code === 'INVALID_TRANSITION',
    { status: r.status, error: r.body?.error?.code },
  );
  check(
    'the refusal says what it would accept',
    Array.isArray(r.body?.data?.allowed),
    r.body?.data,
  );

  r = await api(
    null,
    'PATCH',
    `/admin/escalations/${bare?.id}`,
    { state: 'RESOLVED', resolutionNote: 'Warned, and a strike issued. Watching the account.' },
    { ...safetyHeaders, ...key('esc-res') },
  );

  check('ACKNOWLEDGED → RESOLVED → 200', r.status === 200, r.body?.error);
  check(
    'and the resolution reaches the raiser’s own view of it',
    r.body?.data?.resolutionNote?.startsWith('Warned,'),
    r.body?.data?.resolutionNote,
  );

  r = await api(
    null,
    'PATCH',
    `/admin/escalations/${bare?.id}`,
    { state: 'RESOLVED' },
    { ...safetyHeaders, ...key('esc-res2') },
  );

  check(
    'RESOLVED is final → 409',
    r.status === 409 && r.body?.error?.code === 'INVALID_TRANSITION',
    { status: r.status, error: r.body?.error?.code },
  );

  // A note on an acknowledgement would be an answer attached to something still open.
  r = await api(
    null,
    'PATCH',
    `/admin/escalations/${second?.id}`,
    { state: 'ACKNOWLEDGED', resolutionNote: 'This should not be stored yet.' },
    { ...safetyHeaders, ...key('esc-ackn') },
  );

  check('a resolutionNote sent with ACKNOWLEDGED is accepted', r.status === 200, r.body?.error);
  check(
    'and not stored, because nothing has been resolved',
    r.body?.data?.resolutionNote === null,
    r.body?.data?.resolutionNote,
  );

  // ── 6. The lists, and `mine` ─────────────────────────────────────────────
  heading('6. the lists: outstanding by default, and mine means I raised it');

  r = await api(null, 'GET', '/admin/escalations?perPage=100', null, safetyHeaders);

  const open = (r.body?.data ?? []).map(row => row.id);

  check('the default list → 200', r.status === 200, r.body?.error);
  check('it holds the ACKNOWLEDGED one, which is not an answer', open.includes(second?.id), {
    looking: second?.id,
    got: open.length,
  });
  check('and not the RESOLVED one', !open.includes(bare?.id), bare?.id);
  check(
    'oldest first, because this is a list of people waiting',
    (r.body?.data ?? []).every(
      (row, index, rows) => index === 0 || rows[index - 1].createdAt <= row.createdAt,
    ),
    (r.body?.data ?? []).slice(0, 3).map(row => row.createdAt),
  );

  r = await api(null, 'GET', '/admin/escalations?mine=true&perPage=100', null, supportHeaders);

  const mine = (r.body?.data ?? []).map(row => row.raisedBy?.id);

  check('`mine` is the ones I raised', mine.length > 0 && mine.every(id => id === support.id), {
    count: mine.length,
    raisers: [...new Set(mine)],
  });

  r = await api(null, 'GET', '/admin/escalations?mine=true&perPage=100', null, safetyHeaders);

  check(
    'and somebody else’s `mine` is a different list',
    !(r.body?.data ?? []).some(row => row.id === second?.id),
    (r.body?.data ?? []).map(row => row.id),
  );

  r = await api(
    null,
    'GET',
    `/admin/escalations?state=RESOLVED&memberId=${member.id}&perPage=100`,
    null,
    safetyHeaders,
  );

  check(
    'state and memberId filter together',
    (r.body?.data ?? []).length === 1 && r.body?.data?.[0]?.id === bare?.id,
    (r.body?.data ?? []).map(row => [row.id, row.state]),
  );

  r = await api(null, 'GET', `/admin/escalations/${targeted?.id}`, null, safetyHeaders);

  check('one by its own id → 200', r.status === 200 && r.body?.data?.id === targeted?.id, {
    status: r.status,
  });

  r = await api(
    null,
    'GET',
    '/admin/escalations/00000000-0000-0000-0000-000000000000',
    null,
    safetyHeaders,
  );

  check('an unknown id → 404', r.status === 404, r.status);

  // ── 7. The dashboard and the picker ──────────────────────────────────────
  heading('7. the dashboard count, and the thread-access picker');

  const attention = await api(null, 'GET', '/admin/dashboard/attention', null, safetyHeaders);
  const escalationItem = (attention.body?.data ?? []).find(item => item.id === 'openEscalations');

  check(
    '`openEscalations` is on the dashboard for `moderation:decide`',
    !!escalationItem,
    (attention.body?.data ?? []).map(item => item.id),
  );
  check(
    'counting OPEN and ACKNOWLEDGED together, so picking something up does not hide it',
    escalationItem?.count >= 2,
    { count: escalationItem?.count },
  );

  const supportAttention = await api(
    null,
    'GET',
    '/admin/dashboard/attention',
    null,
    supportHeaders,
  );

  check(
    'and omitted — not nulled — for Support, who cannot answer them',
    !(supportAttention.body?.data ?? []).some(item => item.id === 'openEscalations'),
    (supportAttention.body?.data ?? []).map(item => item.id),
  );

  const linkable = await api(
    null,
    'GET',
    `/admin/members/${member.id}/linkable-cases`,
    null,
    safetyHeaders,
  );
  const kinds = (linkable.body?.data ?? []).map(row => row.type);

  check('the thread-access picker offers the escalations', kinds.includes('ESCALATION'), [
    ...new Set(kinds),
  ]);
  check(
    'and the report case the escalation filed, which it never used to',
    kinds.includes('REPORT_CASE'),
    [...new Set(kinds)],
  );

  // ── 8. The audit trail ───────────────────────────────────────────────────
  heading('8. both halves are in the trail, under safety');

  const trail = await prisma.auditLog.findMany({
    where: { action: { in: ['escalation.created', 'escalation.updated'] }, targetId: member.id },
    select: { action: true, area: true, before: true, after: true },
    orderBy: { occurredAt: 'asc' },
  });

  check(
    'raising is recorded',
    trail.some(row => row.action === 'escalation.created'),
    trail.map(row => row.action),
  );
  check(
    'and answering, with the transition on the entry',
    trail.some(
      row =>
        row.action === 'escalation.updated' &&
        row.before?.state === 'ACKNOWLEDGED' &&
        row.after?.state === 'RESOLVED',
    ),
    trail.filter(row => row.action === 'escalation.updated').map(row => [row.before, row.after]),
  );
  check(
    'filed under SAFETY, which is who reads it',
    trail.every(row => row.area === 'SAFETY'),
    [...new Set(trail.map(row => row.area))],
  );

  // ── 9. A member with nothing to do with it ───────────────────────────────
  heading('9. scoped to the member it is about');

  r = await api(
    null,
    'GET',
    `/admin/escalations?memberId=${other.id}&state=OPEN,ACKNOWLEDGED,RESOLVED&perPage=100`,
    null,
    safetyHeaders,
  );

  check(
    'another member has none of them',
    (r.body?.data ?? []).length === 0,
    (r.body?.data ?? []).map(row => row.id),
  );

  await sweep('escalations');
  await finish();
}

main().catch(fail);
