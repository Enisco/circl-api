/* §5.11 Appeals: the other half of a decision — the member's right to argue with it.
 *
 * Two things make this unlike the other queues, and most of these checks are about them.
 *
 * An appeal is **logged by staff**: it arrives through Support in the member's words and somebody
 * writes it down, so a row carries two people and the statement is a record of what was said.
 *
 * And R6: whoever took the decision cannot review the appeal against it — checked when the appeal
 * is claimed, not only when it is decided, because by then the reviewer has read the member's
 * statement and formed a view about their own decision.
 *
 * The rest is what `OVERTURNED` has to undo. Upholding is a sentence; overturning has to reach the
 * content, the strike and the suspension, each of which comes back a different way.
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

const roleWith = async (label, codes) => {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const code = `e2e_ap_${label}_${stamp}`;
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
      name: `E2E appeals ${label} ${stamp}`,
      code,
      isSystem: false,
      isAdmin: true,
      rolePermissions: { create: permissions.map(permission => ({ permissionId: permission.id })) },
    },
  });

  return role.code;
};

(async () => {
  await sweep('pre-run');

  const roles = [];
  const register = async (label, codes) => {
    const code = await roleWith(label, codes);

    roles.push(code);

    return code;
  };

  const reviewerRole = await register('reviewer', [
    'reports:read',
    'reports:escalate',
    'moderation:decide',
    'members:read',
  ]);
  const supportRole = await register('support', ['reports:read', 'reports:escalate']);

  const decider = await makeAdmin('ap-decider', reviewerRole);
  const reviewer = await makeAdmin('ap-reviewer', reviewerRole);
  const support = await makeAdmin('ap-support', supportRole);

  const asDecider = adminHeaders(decider);
  const asReviewer = adminHeaders(reviewer);
  const asSupport = adminHeaders(support);

  const author = await makeUser('ap-author', { cityId: 'BRISTOL' });
  const reporter = await makeUser('ap-reporter', { cityId: 'BRISTOL' });

  const post = async title => {
    const res = await api(author.token, 'POST', '/community/requests', {
      title,
      description: 'Nothing here for a lexicon to find.',
      categoryCode: 'ACCOMMODATION',
      cityId: 'BRISTOL',
    });

    return res.body?.data?.id;
  };

  /** A decided case, with the content removed and the author struck. */
  const decidedCase = async title => {
    const target = await post(title);

    await api(reporter.token, 'POST', '/moderation/reports', {
      targetType: 'REQUEST',
      targetId: target,
      reasonCode: 'SPAM',
      note: 'Reported for the appeals e2e.',
    });

    const row = await prisma.reportCase.findFirst({
      where: { targetType: 'REQUEST', targetId: target },
      orderBy: { createdAt: 'desc' },
    });

    const claimed = await api(null, 'POST', `/admin/reports/cases/${row.id}/claim`, {}, asDecider);

    check(`${title}: the case is claimed`, claimed.status === 200, claimed.body?.error);

    const settled = await api(
      null,
      'POST',
      `/admin/reports/cases/${row.id}/decide`,
      {
        decision: 'REMOVE_AND_WARN',
        reasonCode: 'POLICY_VIOLATION',
        policySubtype: 'SPAM',
        note: 'Removed and warned.',
        memberMessage: 'Your post was removed.',
      },
      asDecider,
    );

    check(`${title}: the case is decided`, settled.status === 200, settled.body?.error);

    return { caseId: row.id, target };
  };

  console.log('\n── An appeal is logged, not filed ─────────────────────────');

  const first = await decidedCase('A post removed, then appealed');

  let res = await api(
    null,
    'POST',
    '/admin/appeals',
    {
      memberId: author.id,
      subjectType: 'REPORT_CASE',
      subjectId: first.caseId,
      statement: 'I was not selling anything, I was asking for help with a deposit.',
      reasonCode: 'MEMBER_REQUEST',
      note: 'Member rang Support.',
    },
    asSupport,
  );

  check('Support logs what the member said', res.status === 201, res.body?.error);

  const appeal = res.body?.data;

  check(
    'the row keeps both people: whose words they are, and who took them',
    appeal?.member?.id === author.id && appeal?.loggedBy?.id === support.id,
    { member: appeal?.member?.id, loggedBy: appeal?.loggedBy?.id },
  );
  check(
    'and who made the decision being appealed (R6’s input)',
    appeal?.originalDecider?.id === decider.id,
    appeal?.originalDecider,
  );
  check(
    'the statement is kept verbatim',
    appeal?.statement?.includes('deposit'),
    appeal?.statement,
  );
  check('it is OPEN, with an SLA', appeal?.state === 'OPEN' && !!appeal?.dueAt, {
    state: appeal?.state,
    dueAt: appeal?.dueAt,
  });

  const queued = await prisma.moderationQueueItem.findFirst({
    where: { type: 'APPEAL', subjectUserId: author.id },
  });

  check(
    'a reviewer has something to pick up',
    queued?.payload?.appealId === appeal.id && queued?.state === 'PENDING',
    { payload: queued?.payload, state: queued?.state },
  );

  res = await api(
    null,
    'POST',
    '/admin/appeals',
    {
      memberId: author.id,
      subjectType: 'REPORT_CASE',
      subjectId: first.caseId,
      statement: 'Saying it again.',
      reasonCode: 'MEMBER_REQUEST',
    },
    asSupport,
  );

  check('a second appeal about the same decision → 409', res.status === 409, [
    res.status,
    res.body?.error?.code,
  ]);

  console.log('\n── There has to be something to appeal ───────────────────');

  const undecided = await post('A post reported but not decided');

  await api(reporter.token, 'POST', '/moderation/reports', {
    targetType: 'REQUEST',
    targetId: undecided,
    reasonCode: 'SPAM',
    note: 'Open case.',
  });

  const openCase = await prisma.reportCase.findFirst({
    where: { targetType: 'REQUEST', targetId: undecided },
  });

  res = await api(
    null,
    'POST',
    '/admin/appeals',
    {
      memberId: author.id,
      subjectType: 'REPORT_CASE',
      subjectId: openCase.id,
      statement: 'Appealing something nobody has decided.',
      reasonCode: 'MEMBER_REQUEST',
    },
    asSupport,
  );

  check(
    'an undecided case cannot be appealed → 400',
    res.status === 400 && res.body?.error?.code === 'VALIDATION_FAILED',
    [res.status, res.body?.error?.message],
  );

  res = await api(
    null,
    'POST',
    '/admin/appeals',
    {
      memberId: reporter.id,
      subjectType: 'REPORT_CASE',
      subjectId: first.caseId,
      statement: 'Appealing somebody else’s decision.',
      reasonCode: 'MEMBER_REQUEST',
    },
    asSupport,
  );

  check('nor can a member appeal a decision about somebody else → 400', res.status === 400, [
    res.status,
    res.body?.error?.message,
  ]);

  console.log('\n── R6: not the person who decided it ─────────────────────');

  res = await api(null, 'POST', `/admin/appeals/${appeal.id}/claim`, {}, asDecider);

  check(
    'the original decider cannot claim it → 403 APPEAL_REVIEWER_CONFLICT',
    res.status === 403 && res.body?.error?.code === 'APPEAL_REVIEWER_CONFLICT',
    [res.status, res.body?.error?.code],
  );

  res = await api(
    null,
    'POST',
    `/admin/appeals/${appeal.id}/decide`,
    { outcome: 'UPHELD', decisionNote: 'Standing by my own decision.', reasonCode: 'CORRECTION' },
    asDecider,
  );

  check('nor decide it, even unclaimed → 403', res.status === 403, [
    res.status,
    res.body?.error?.code,
  ]);

  res = await api(null, 'POST', `/admin/appeals/${appeal.id}/claim`, {}, asReviewer);

  check('somebody else can', res.status === 200, res.body?.error);
  check(
    'and it is IN_REVIEW with them on it',
    res.body?.data?.state === 'IN_REVIEW' && res.body?.data?.reviewer?.id === reviewer.id,
    { state: res.body?.data?.state, reviewer: res.body?.data?.reviewer?.id },
  );

  const claimed = await prisma.moderationQueueItem.findFirst({
    where: { type: 'APPEAL', payload: { path: ['appealId'], equals: appeal.id } },
  });

  check(
    'the queue item moved with it — one claim, two views of one job',
    claimed?.state === 'IN_REVIEW' && claimed?.assignedToId === reviewer.id,
    { state: claimed?.state, assignedToId: claimed?.assignedToId },
  );

  console.log('\n── Overturning undoes what the decision did ──────────────');

  const detail = await api(null, 'GET', `/admin/appeals/${appeal.id}`, null, asReviewer);

  check('the review page gets what it is about', detail.status === 200, detail.body?.error);
  check(
    'described in a line, so it need not fetch the case itself',
    detail.body?.data?.subject?.summary?.includes('REMOVE_AND_WARN'),
    detail.body?.data?.subject,
  );

  const strikeBefore = await prisma.strike.findFirst({
    where: { userId: author.id, sourceId: first.caseId, revokedAt: null },
  });

  check('the author has the strike the decision gave them', !!strikeBefore, strikeBefore?.id);

  res = await api(
    null,
    'POST',
    `/admin/appeals/${appeal.id}/decide`,
    {
      outcome: 'OVERTURNED',
      decisionNote: 'Reading it again, this was a request for help, not spam.',
      memberMessage: 'We’ve put your post back. Sorry about that.',
      reasonCode: 'CORRECTION',
    },
    asReviewer,
  );

  check('the appeal is overturned', res.status === 200, res.body?.error);
  check(
    'and says who decided it and when',
    res.body?.data?.state === 'OVERTURNED' && !!res.body?.data?.decidedAt,
    { state: res.body?.data?.state, decidedAt: res.body?.data?.decidedAt },
  );

  const restored = await prisma.communityRequest.findUnique({ where: { id: first.target } });

  check(
    'the post comes back',
    restored?.deletedAt === null && restored?.visibilityState === 'VISIBLE',
    { deletedAt: restored?.deletedAt, visibilityState: restored?.visibilityState },
  );

  const verdict = await prisma.contentSafety.findUnique({
    where: { targetType_targetId: { targetType: 'REQUEST', targetId: first.target } },
  });

  check(
    'its verdict says a person published it again',
    verdict?.visibilityState === 'VISIBLE' && verdict?.reviewDecision === 'APPROVE',
    { visibilityState: verdict?.visibilityState, reviewDecision: verdict?.reviewDecision },
  );

  const strikeAfter = await prisma.strike.findUnique({ where: { id: strikeBefore.id } });

  check(
    'the strike is withdrawn, and the row stays: it was issued and then withdrawn',
    strikeAfter?.revokedAt !== null,
    { revokedAt: strikeAfter?.revokedAt },
  );

  const reopened = await prisma.reportCase.findUnique({ where: { id: first.caseId } });

  check(
    'the case records that it was reversed rather than being deleted or reopened',
    reopened?.state === 'DISMISSED' && reopened?.decision === 'NO_ACTION',
    { state: reopened?.state, decision: reopened?.decision },
  );

  const told = await prisma.notification.findFirst({
    where: { userId: author.id, body: { contains: 'put your post back' } },
  });

  check('the member is told, in the reviewer’s words', !!told, told?.body);

  const resolvedItem = await prisma.moderationQueueItem.findFirst({
    where: { type: 'APPEAL', payload: { path: ['appealId'], equals: appeal.id } },
  });

  check('and the queue item is resolved', resolvedItem?.state === 'RESOLVED', resolvedItem?.state);

  res = await api(
    null,
    'POST',
    `/admin/appeals/${appeal.id}/decide`,
    { outcome: 'UPHELD', decisionNote: 'Again.', reasonCode: 'CORRECTION' },
    asReviewer,
  );

  check('a decided appeal cannot be decided twice → 409', res.status === 409, [
    res.status,
    res.body?.error?.code,
  ]);

  console.log('\n── Upholding leaves everything where it is ──────────────');

  const second = await decidedCase('A post removed, appealed, and upheld');

  res = await api(
    null,
    'POST',
    '/admin/appeals',
    {
      memberId: author.id,
      subjectType: 'REPORT_CASE',
      subjectId: second.caseId,
      statement: 'I still think this was unfair.',
      reasonCode: 'MEMBER_REQUEST',
    },
    asSupport,
  );

  check('a second appeal is logged', res.status === 201, res.body?.error);

  const upheld = res.body?.data;

  await api(null, 'POST', `/admin/appeals/${upheld.id}/claim`, {}, asReviewer);

  res = await api(
    null,
    'POST',
    `/admin/appeals/${upheld.id}/decide`,
    {
      outcome: 'UPHELD',
      decisionNote: 'Looked again: the original decision was right.',
      reasonCode: 'CORRECTION',
    },
    asReviewer,
  );

  check('the appeal is upheld', res.status === 200 && res.body?.data?.state === 'UPHELD', [
    res.status,
    res.body?.data?.state,
  ]);

  const stillGone = await prisma.communityRequest.findUnique({ where: { id: second.target } });

  check('the post stays down', stillGone?.deletedAt !== null, stillGone?.deletedAt);
  check(
    'the strike stays',
    (await prisma.strike.count({
      where: { userId: author.id, sourceId: second.caseId, revokedAt: null },
    })) === 1,
  );
  check(
    'and the member is told it was looked at again',
    !!(await prisma.notification.findFirst({
      where: { userId: author.id, body: { contains: 'original decision stands' } },
    })),
  );

  console.log('\n── A strike appealed on its own ─────────────────────────');

  const ownStrike = await prisma.strike.findFirst({
    where: { userId: author.id, sourceId: second.caseId, revokedAt: null },
  });

  res = await api(
    null,
    'POST',
    '/admin/appeals',
    {
      memberId: author.id,
      subjectType: 'STRIKE',
      subjectId: ownStrike.id,
      statement: 'The post is gone, but the strike should not stand.',
      reasonCode: 'MEMBER_REQUEST',
    },
    asSupport,
  );

  check('a strike can be appealed by itself', res.status === 201, res.body?.error);

  const strikeAppeal = res.body?.data;

  await api(null, 'POST', `/admin/appeals/${strikeAppeal.id}/claim`, {}, asReviewer);

  res = await api(
    null,
    'POST',
    `/admin/appeals/${strikeAppeal.id}/decide`,
    {
      outcome: 'OVERTURNED',
      decisionNote: 'The removal stands; the strike does not.',
      reasonCode: 'CORRECTION',
    },
    asReviewer,
  );

  check('and overturned on its own', res.status === 200, res.body?.error);
  check(
    'the strike goes',
    (await prisma.strike.findUnique({ where: { id: ownStrike.id } }))?.revokedAt !== null,
  );
  check(
    'and the post stays down, because that is not what was appealed',
    (await prisma.communityRequest.findUnique({ where: { id: second.target } }))?.deletedAt !==
      null,
  );

  console.log('\n── The queue, and who may see it ────────────────────────');

  res = await api(null, 'GET', `/admin/appeals?memberId=${author.id}`, null, asReviewer);

  check('the list answers', res.status === 200, res.body?.error);
  check(
    'and defaults to the work still to do',
    (res.body?.data ?? []).every(row => ['OPEN', 'IN_REVIEW'].includes(row.state)),
    res.body?.data?.map(row => row.state),
  );

  res = await api(
    null,
    'GET',
    `/admin/appeals?memberId=${author.id}&state=UPHELD,OVERTURNED`,
    null,
    asReviewer,
  );

  check(
    'decided ones are there when asked for',
    (res.body?.data ?? []).length === 3,
    res.body?.data?.map(row => row.state),
  );

  res = await api(null, 'POST', `/admin/appeals/${upheld.id}/claim`, {}, asSupport);

  check('Support can log an appeal but not review one → 403', res.status === 403, [
    res.status,
    res.body?.error?.code,
  ]);

  await prisma.role.deleteMany({ where: { code: { in: roles } } });

  await sweep('appeals');
  await finish();
})().catch(async error => {
  await fail(error);
});
