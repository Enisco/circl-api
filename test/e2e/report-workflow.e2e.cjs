/* §5.10 and §7.2: the screen a reviewer works a report case from.
 *
 * The intake half — reports grouping into cases — is `report-cases.e2e.cjs`. This is what happens
 * after: the queue a reviewer sees, who may claim what, and what a decision actually does. The
 * decision is the part with teeth, so most of these checks are about its side effects reaching
 * the places they have to reach: the content, the reports, the queue item, the member's record,
 * and the people who reported it.
 *
 * The permission matrix is four roles, because the seeded ones cannot express it: deciding needs
 * a claim unless the caller is a manager, and the only way to test that is to have somebody who
 * is not one.
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
  const code = `e2e_rw_${label}_${stamp}`;
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
      name: `E2E report workflow ${label} ${stamp}`,
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

  // `moderation:read` travels with `moderation:decide` in every real role (§4.13), and R9 keys the
  // reporter's identity on it — so a synthetic role with the decide permission and not the read one
  // is a combination the platform never grants, and testing against it would be testing a role
  // that cannot exist.
  const reviewerRole = await register('reviewer', [
    'reports:read',
    'moderation:read',
    'moderation:decide',
  ]);
  const managerRole = await register('manager', [
    'reports:read',
    'moderation:read',
    'moderation:decide',
    'moderation:assign',
  ]);
  // Support's shape: the reports, and nothing about moderation. R9's subject.
  const readerRole = await register('reader', ['reports:read']);

  const reviewer = await makeAdmin('rw-reviewer', reviewerRole);
  const other = await makeAdmin('rw-other', reviewerRole);
  const manager = await makeAdmin('rw-manager', managerRole);
  const reader = await makeAdmin('rw-reader', readerRole);

  const asReviewer = adminHeaders(reviewer);
  const asOther = adminHeaders(other);
  const asManager = adminHeaders(manager);
  const asReader = adminHeaders(reader);

  const author = await makeUser('rw-author', { cityId: 'BRISTOL' });
  const reporter = await makeUser('rw-reporter', { cityId: 'BRISTOL' });
  const second = await makeUser('rw-second', { cityId: 'BRISTOL' });

  const post = async (title, description = 'Nothing here for a lexicon to find.') => {
    const res = await api(author.token, 'POST', '/community/requests', {
      title,
      description,
      categoryCode: 'ACCOMMODATION',
      cityId: 'BRISTOL',
    });

    return res.body?.data?.id;
  };

  const report = (who, targetId, reasonCode = 'SPAM', note = 'Reported for the e2e.') =>
    api(who.token, 'POST', '/moderation/reports', {
      targetType: 'REQUEST',
      targetId,
      reasonCode,
      note,
    });

  const caseFor = async targetId =>
    prisma.reportCase.findFirst({
      where: { targetType: 'REQUEST', targetId },
      orderBy: { createdAt: 'desc' },
    });

  console.log('\n── The queue a reviewer opens ──────────────────────────────');

  const plain = await post('A post reported once');

  await report(reporter, plain);

  const scam = await post('Guaranteed visa, no questions');

  await report(reporter, scam, 'SCAM', 'This is a scam.');
  await report(second, scam, 'SCAM', 'Agreed, a scam.');

  // Filtered to this author, because the queue is shared: the demo dataset and every other suite
  // put cases in it, and an assertion about "the first row" would be an assertion about them.
  let res = await api(null, 'GET', `/admin/reports/cases?memberId=${author.id}`, null, asReviewer);

  check('the case list answers', res.status === 200, res.body?.error);

  const rows = res.body?.data ?? [];
  const scamRow = rows.find(row => row.target?.targetId === scam);
  const plainRow = rows.find(row => row.target?.targetId === plain);

  check('both cases are in it', !!scamRow && !!plainRow, rows.length);
  check(
    'the urgent one is first: open work sorts by what to do next',
    rows.findIndex(row => row.id === scamRow?.id) < rows.findIndex(row => row.id === plainRow?.id),
    rows.map(row => row.priority),
  );
  check(
    'a row carries the counts a reviewer triages on',
    scamRow?.reportCount === 2 && scamRow?.uniqueReporterCount === 2,
    { reportCount: scamRow?.reportCount, uniqueReporterCount: scamRow?.uniqueReporterCount },
  );
  check(
    'and the reported member, but never a reporter',
    scamRow?.targetMember?.id === author.id && !('reports' in scamRow),
    Object.keys(scamRow ?? {}),
  );
  check(
    'with a line from the content itself, so the row is recognisable',
    typeof scamRow?.target?.title === 'string' && scamRow.target.title.length > 0,
    scamRow?.target,
  );
  check(
    'the meta says what needs attention now',
    typeof res.body?.meta?.urgentUnclaimed === 'number' &&
      typeof res.body?.meta?.overdueCount === 'number',
    res.body?.meta,
  );

  res = await api(
    null,
    'GET',
    `/admin/reports/cases?state=ACTIONED&memberId=${author.id}`,
    null,
    asReviewer,
  );
  check('a decided-state filter answers too', res.status === 200, res.body?.error);
  check('and is empty, because nothing has been decided yet', res.body?.data?.length === 0);

  console.log('\n── What the detail shows, and to whom ─────────────────────');

  const scamCase = await caseFor(scam);

  res = await api(null, 'GET', `/admin/reports/cases/${scamCase.id}`, null, asReviewer);

  check('the detail answers', res.status === 200, res.body?.error);
  check(
    'with both reports and their server-side snapshots',
    res.body?.data?.reports?.length === 2 &&
      res.body.data.reports.every(row => !!row.snapshot?.capturedAt),
    res.body?.data?.reports?.map(row => Object.keys(row.snapshot ?? {})),
  );
  check(
    'naming the reporters, for a caller allowed to see them',
    res.body?.data?.reports?.some(row => row.reporter?.id === reporter.id),
    res.body?.data?.reports?.map(row => row.reporter?.id),
  );
  check(
    'what else is known about the reported member',
    res.body?.data?.targetMemberHistory?.accountAgeDays >= 0 &&
      res.body.data.targetMemberHistory.activeStrikes === 0,
    res.body?.data?.targetMemberHistory,
  );
  check(
    'the history of this target, scans included',
    Array.isArray(res.body?.data?.history) &&
      res.body.data.history.some(entry => entry.kind === 'SCAN') &&
      res.body.data.history.some(entry => entry.kind === 'REPORT'),
    res.body?.data?.history?.map(entry => entry.kind),
  );
  // `liveContent` was permanently null and `appeals` permanently empty, so the reviewer's screen
  // could not show the post as it stands today — only the snapshots taken when each report was
  // filed, which is exactly what an author editing their way out of a report relies on.
  check(
    'the content as it is **now**, which is §5.7’s page',
    res.body?.data?.liveContent?.targetId === scam &&
      res.body.data.liveContent.targetType === 'REQUEST' &&
      typeof res.body.data.liveContent.body?.text === 'string' &&
      res.body.data.liveContent.adminUrl === `/content/requests/${scam}`,
    res.body?.data?.liveContent && {
      targetId: res.body.data.liveContent.targetId,
      adminUrl: res.body.data.liveContent.adminUrl,
      bodyKeys: Object.keys(res.body.data.liveContent.body ?? {}),
    },
  );
  check(
    'with the author’s strikes and account age beside it, as the content page has them',
    typeof res.body?.data?.liveContent?.author?.activeStrikes === 'number' &&
      typeof res.body.data.liveContent.author.accountAgeDays === 'number',
    res.body?.data?.liveContent?.author,
  );
  check(
    'the scanner’s category on the case, rather than a permanent null',
    'category' in (res.body?.data?.risk ?? {}) &&
      res.body?.data?.risk?.level !== undefined &&
      typeof res.body?.data?.risk?.finalScore === 'number',
    res.body?.data?.risk,
  );
  check(
    'and appeals, which are a real lookup now (none against an undecided case)',
    Array.isArray(res.body?.data?.appeals) && res.body.data.appeals.length === 0,
    res.body?.data?.appeals,
  );
  check(
    'every snapshot carries `text`, whatever the writer called the field',
    res.body?.data?.reports?.every(row => 'text' in (row.snapshot ?? {})),
    res.body?.data?.reports?.map(row => Object.keys(row.snapshot ?? {})),
  );
  check(
    'a report in the history never names who filed it',
    res.body.data.history.filter(entry => entry.kind === 'REPORT').every(entry => !entry.actor),
    res.body.data.history.filter(entry => entry.kind === 'REPORT'),
  );

  console.log('\n── Claiming, and not having it taken ─────────────────────');

  res = await api(null, 'POST', `/admin/reports/cases/${scamCase.id}/claim`, {}, asReviewer);

  check('the reviewer takes the case', res.status === 200, res.body?.error);
  check(
    'it is IN_REVIEW and has their name on it',
    res.body?.data?.state === 'IN_REVIEW' && res.body?.data?.assignedTo?.id === reviewer.id,
    { state: res.body?.data?.state, assignedTo: res.body?.data?.assignedTo?.id },
  );

  res = await api(null, 'POST', `/admin/reports/cases/${scamCase.id}/claim`, {}, asOther);

  check(
    'somebody else cannot take it from under them → 409',
    res.status === 409 && res.body?.error?.code === 'CLAIMED_BY_OTHER',
    [res.status, res.body?.error],
  );

  res = await api(null, 'POST', `/admin/reports/cases/${scamCase.id}/release`, {}, asOther);

  check('nor release it: that is a manager’s call', res.status === 403, [
    res.status,
    res.body?.error?.message,
  ]);

  res = await api(null, 'POST', `/admin/reports/cases/${scamCase.id}/release`, {}, asManager);

  check('a manager can', res.status === 200, res.body?.error);
  check(
    'and it goes back to the pile',
    res.body?.data?.state === 'OPEN' && res.body?.data?.assignedTo === null,
    { state: res.body?.data?.state, assignedTo: res.body?.data?.assignedTo },
  );

  console.log('\n── Assigning it to somebody who can act on it ────────────');

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${scamCase.id}/assign`,
    { assigneeId: other.id, reasonCode: 'SAFETY_CONCERN', note: 'You know this one.' },
    asReviewer,
  );

  check('a reviewer cannot hand work to somebody else', res.status === 403, [
    res.status,
    res.body?.error?.message,
  ]);

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${scamCase.id}/assign`,
    { assigneeId: reader.id, reasonCode: 'SAFETY_CONCERN', note: 'Over to you.' },
    asManager,
  );

  check(
    'and a manager cannot hand it to somebody who could not decide it → 422',
    res.status === 422,
    [res.status, res.body?.error?.message],
  );

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${scamCase.id}/assign`,
    { assigneeId: other.id, reasonCode: 'SAFETY_CONCERN', note: 'Over to you.' },
    asManager,
  );

  check('but can hand it to a reviewer', res.status === 200, res.body?.error);
  check(
    'who now holds it',
    res.body?.data?.assignedTo?.id === other.id && res.body?.data?.state === 'IN_REVIEW',
    res.body?.data?.assignedTo,
  );

  console.log('\n── Deciding needs the case in your hands ─────────────────');

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${scamCase.id}/decide`,
    { decision: 'NO_ACTION', reasonCode: 'CORRECTION', note: 'Not mine to decide.' },
    asReviewer,
  );

  check('a reviewer cannot decide a case somebody else holds → 409', res.status === 409, [
    res.status,
    res.body?.error?.message,
  ]);

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${scamCase.id}/decide`,
    {
      decision: 'REMOVE_AND_WARN',
      reasonCode: 'SCAM_FRAUD',
      note: 'Visa fraud, removed and warned.',
      memberMessage: 'Your post offered guaranteed visas, which we do not allow.',
    },
    asManager,
  );

  check('but a manager can step in on any case (§7.2)', res.status === 200, res.body?.error);

  const decided = res.body?.data;

  check(
    'the case is ACTIONED and carries the decision',
    decided?.state === 'ACTIONED' && decided?.decision === 'REMOVE_AND_WARN',
    { state: decided?.state, decision: decided?.decision },
  );
  check(
    'and is no longer overdue, whatever its SLA was',
    decided?.overdue === false,
    decided?.dueAt,
  );

  const removed = await prisma.communityRequest.findUnique({ where: { id: scam } });

  check('the content is taken down', removed?.deletedAt !== null, removed?.deletedAt);

  const verdict = await prisma.contentSafety.findUnique({
    where: { targetType_targetId: { targetType: 'REQUEST', targetId: scam } },
  });

  check(
    'its verdict says a person decided, and what they decided',
    verdict?.visibilityState === 'REJECTED' &&
      verdict?.reviewDecision === 'REMOVE_AND_WARN' &&
      verdict?.reviewedById === manager.id,
    {
      visibilityState: verdict?.visibilityState,
      reviewDecision: verdict?.reviewDecision,
      heldReason: verdict?.heldReason,
    },
  );

  const answered = await prisma.report.findMany({ where: { caseId: scamCase.id } });

  check(
    'both reports get the same answer, which is what grouping them was for',
    answered.length === 2 &&
      answered.every(row => row.state === 'ACTIONED' && row.decision === 'REMOVE_AND_WARN'),
    answered.map(row => ({ state: row.state, decision: row.decision })),
  );
  check(
    'and both reporters were told, once',
    answered.every(row => row.outcomeNotifiedAt !== null),
    answered.map(row => row.outcomeNotifiedAt),
  );

  const notices = await prisma.notification.findMany({
    where: { userId: { in: [reporter.id, second.id] }, title: 'About your report' },
  });

  check('each of them has a notice', notices.length === 2, notices.length);
  check(
    'that says nothing about the other member',
    notices.every(
      notice =>
        !notice.body.includes(author.firstName) &&
        !/warn|suspend|strike|removed their/i.test(notice.body),
    ),
    notices.map(notice => notice.body),
  );

  const strikes = await prisma.strike.findMany({ where: { userId: author.id } });

  check(
    'the author has a strike that says where it came from',
    strikes.length === 1 &&
      strikes[0].sourceType === 'REPORT_CASE' &&
      strikes[0].sourceId === scamCase.id,
    strikes.map(row => ({ sourceType: row.sourceType, sourceId: row.sourceId })),
  );

  const warned = await prisma.notification.findFirst({
    where: { userId: author.id, title: { contains: 'warning' } },
  });

  check(
    'and was told, in the reviewer’s own words',
    warned?.body?.includes('guaranteed visas'),
    warned?.body,
  );

  const item = await prisma.moderationQueueItem.findUnique({
    where: { id: scamCase.queueItemId },
  });

  check(
    'the queue item the reviewer came in through is resolved',
    item?.state === 'RESOLVED' && item?.decision === 'REMOVE_AND_WARN',
    { state: item?.state, decision: item?.decision },
  );

  const action = await prisma.moderationAction.findFirst({
    where: { targetType: 'REQUEST', targetId: scam },
  });

  check(
    'and the append-only record names the case it came from',
    action?.decision === 'REMOVE_AND_WARN' && action?.metadata?.caseId === scamCase.id,
    action?.metadata,
  );

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${scamCase.id}/decide`,
    { decision: 'NO_ACTION', reasonCode: 'CORRECTION', note: 'Changed my mind.' },
    asManager,
  );

  check('a decided case cannot be decided twice → 409', res.status === 409, [
    res.status,
    res.body?.error?.message,
  ]);

  console.log('\n── A dismissal publishes what the scanner was holding ─────');

  const held = await post('A post the scanner held', 'I was trafficked and told to keep quiet.');

  await report(reporter, held, 'OTHER', 'Reported, though it reads like a disclosure.');

  const heldCase = await caseFor(held);
  const beforeDismissal = await prisma.communityRequest.findUnique({ where: { id: held } });

  check(
    'the scanner had it held',
    beforeDismissal?.visibilityState === 'HELD',
    beforeDismissal?.visibilityState,
  );

  await api(null, 'POST', `/admin/reports/cases/${heldCase.id}/claim`, {}, asReviewer);

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${heldCase.id}/decide`,
    {
      decision: 'NO_ACTION',
      reasonCode: 'CORRECTION',
      note: 'A disclosure, not a breach. Published.',
    },
    asReviewer,
  );

  check('the reviewer dismisses it', res.status === 200, res.body?.error);
  check('the case is DISMISSED', res.body?.data?.state === 'DISMISSED', res.body?.data?.state);

  const published = await prisma.communityRequest.findUnique({ where: { id: held } });

  check(
    'and the post is published, which is the only answer "it is fine" can mean (§6.6)',
    published?.visibilityState === 'VISIBLE' && published?.deletedAt === null,
    published?.visibilityState,
  );

  const dismissedReport = await prisma.report.findFirst({ where: { caseId: heldCase.id } });

  check(
    'the reporter is told it was reviewed, not ignored',
    dismissedReport?.state === 'DISMISSED' && dismissedReport?.outcomeNotifiedAt !== null,
    { state: dismissedReport?.state, notified: dismissedReport?.outcomeNotifiedAt },
  );
  check(
    'and no strike was issued for a post that broke nothing',
    (await prisma.strike.count({ where: { userId: author.id } })) === 1,
    await prisma.strike.count({ where: { userId: author.id } }),
  );

  console.log('\n── A warning the reviewer asked not to strike for ─────────');

  const noStrike = await post('A post warned about but not struck');

  await report(reporter, noStrike);

  const noStrikeCase = await caseFor(noStrike);

  await api(null, 'POST', `/admin/reports/cases/${noStrikeCase.id}/claim`, {}, asReviewer);

  const strikesBefore = await prisma.strike.count({ where: { userId: author.id } });

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${noStrikeCase.id}/decide`,
    {
      decision: 'WARN_AUTHOR',
      reasonCode: 'POLICY_VIOLATION',
      policySubtype: 'TONE',
      note: 'A word about tone, no strike.',
      memberMessage: 'Please keep it civil.',
      issueStrike: false,
    },
    asReviewer,
  );

  check('the case is decided', res.status === 200, res.body?.error);
  check(
    'no strike was issued, as asked',
    (await prisma.strike.count({ where: { userId: author.id } })) === strikesBefore,
    await prisma.strike.count({ where: { userId: author.id } }),
  );
  check(
    'but the member was still told — a warning nobody hears is not one',
    !!(await prisma.notification.findFirst({
      where: { userId: author.id, body: { contains: 'keep it civil' } },
    })),
    await prisma.notification.findMany({
      where: { userId: author.id },
      select: { title: true },
    }),
  );

  console.log('\n── Overdue narrows the states, it does not replace them ───');

  // An open case past its SLA, which is the only thing `overdue` can be about. Without one in
  // the data both halves of this block would answer "nothing" and pass whatever the filter did.
  const plainCase = await caseFor(plain);

  await prisma.reportCase.update({
    where: { id: plainCase.id },
    data: { dueAt: new Date(Date.now() - 3_600_000) },
  });

  res = await api(
    null,
    'GET',
    `/admin/reports/cases?overdue=true&memberId=${author.id}`,
    null,
    asReviewer,
  );

  check('overdue on its own finds the case past its SLA', res.status === 200, res.body?.error);
  check(
    'and says so on the row',
    res.body?.data?.length === 1 &&
      res.body.data[0].id === plainCase.id &&
      res.body.data[0].overdue === true,
    res.body?.data?.map(row => ({ id: row.id, state: row.state, overdue: row.overdue })),
  );

  res = await api(
    null,
    'GET',
    `/admin/reports/cases?overdue=true&state=ACTIONED&memberId=${author.id}`,
    null,
    asReviewer,
  );

  check('asking for overdue *decided* cases answers', res.status === 200, res.body?.error);
  check(
    'with nothing, because a decided case cannot be overdue — and not with the open one',
    res.body?.data?.length === 0,
    res.body?.data?.map(row => ({ id: row.id, state: row.state })),
  );

  console.log('\n── Reopening, and the window on it ───────────────────────');

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${heldCase.id}/reopen`,
    { reasonCode: 'CORRECTION', note: 'A second look, on request.' },
    asReviewer,
  );

  check('a decided case can be reopened', res.status === 200, res.body?.error);
  check(
    'it comes back assigned to whoever reopened it',
    res.body?.data?.state === 'IN_REVIEW' && res.body?.data?.assignedTo?.id === reviewer.id,
    { state: res.body?.data?.state, assignedTo: res.body?.data?.assignedTo?.id },
  );
  check('with the decision cleared', res.body?.data?.decision === null, res.body?.data?.decision);

  await prisma.reportCase.update({
    where: { id: heldCase.id },
    data: {
      state: 'DISMISSED',
      decision: 'NO_ACTION',
      decidedAt: new Date(Date.now() - 31 * 86_400_000),
    },
  });

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${heldCase.id}/reopen`,
    { reasonCode: 'CORRECTION', note: 'Too late.' },
    asReviewer,
  );

  check(
    'but not thirty-one days later → 409 INVALID_TRANSITION',
    res.status === 409 && res.body?.error?.code === 'INVALID_TRANSITION',
    [res.status, res.body?.error?.code],
  );

  await prisma.reportCase.update({
    where: { id: heldCase.id },
    data: { state: 'ESCALATED', decidedAt: new Date() },
  });

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${heldCase.id}/reopen`,
    { reasonCode: 'CORRECTION', note: 'Not ours any more.' },
    asReviewer,
  );

  check(
    'and never an escalated one: Guard owns that',
    res.status === 409 && /Guard/.test(res.body?.error?.message ?? ''),
    [res.status, res.body?.error?.message],
  );

  console.log('\n── Who may see what ──────────────────────────────────────');

  res = await api(null, 'GET', '/admin/reports/cases', null, asReader);
  check('a reader can see the queue', res.status === 200, res.body?.error);

  res = await api(null, 'POST', `/admin/reports/cases/${scamCase.id}/claim`, {}, asReader);
  check('but cannot claim a case → 403', res.status === 403, [res.status, res.body?.error?.code]);

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${scamCase.id}/decide`,
    { decision: 'NO_ACTION', reasonCode: 'CORRECTION', note: 'Not allowed.' },
    asReader,
  );
  check('nor decide one → 403', res.status === 403, [res.status, res.body?.error?.code]);

  // R9, on the two endpoints that carry a reporter: with `reports:read` and no `moderation:read`,
  // the reporter and their note are withheld. Support hold exactly that pair of permissions, and
  // this gate read `reports:read` until today — so a support agent answering an angry member had
  // the name of whoever reported them on the same screen, which is the one fact that turns a
  // report into a reprisal.
  res = await api(null, 'GET', `/admin/reports/cases/${scamCase.id}`, null, asReader);

  check('a reader can open the case', res.status === 200, res.body?.error);
  check(
    'but is told how many reports there are without being told who filed them (R9)',
    (res.body?.data?.reports ?? []).length === 2 &&
      res.body.data.reports.every(row => row.reporter === null && row.note === null),
    res.body?.data?.reports?.map(row => ({ reporter: row.reporter, note: row.note })),
  );
  check(
    'while the snapshot of what was reported is still there, because that is the work',
    (res.body?.data?.reports ?? []).every(row => !!row.snapshot?.capturedAt),
    res.body?.data?.reports?.map(row => Object.keys(row.snapshot ?? {})),
  );

  res = await api(null, 'GET', '/admin/reports', null, asReader);

  check(
    'and the raw log withholds them there too, one page further along',
    res.status === 200 && (res.body?.data ?? []).every(row => row.reporter === null),
    (res.body?.data ?? []).slice(0, 3).map(row => row.reporter),
  );

  res = await api(null, 'GET', '/admin/reports', null, asReviewer);

  check('the raw report log answers', res.status === 200, res.body?.error);
  check(
    'with every report filed in this suite',
    (res.body?.data ?? []).filter(row => [reporter.id, second.id].includes(row.reporter?.id))
      .length >= 3,
    res.body?.data?.length,
  );

  console.log('\n── A reason is not optional ──────────────────────────────');

  const last = await post('A post decided without a reason');

  await report(reporter, last);

  const lastCase = await caseFor(last);

  await api(null, 'POST', `/admin/reports/cases/${lastCase.id}/claim`, {}, asReviewer);

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${lastCase.id}/decide`,
    { decision: 'NO_ACTION' },
    asReviewer,
  );

  check(
    'a decision with no reason is refused → 422',
    res.status === 422 && res.body?.error?.code === 'REASON_REQUIRED',
    [res.status, res.body?.error?.code],
  );

  res = await api(
    null,
    'POST',
    `/admin/reports/cases/${lastCase.id}/decide`,
    { decision: 'POLICY_VIOLATION_BUT_NOT_A_DECISION', reasonCode: 'CORRECTION', note: 'No.' },
    asReviewer,
  );

  check('and a decision that is not one is refused → 400', res.status === 400, [
    res.status,
    res.body?.error?.code,
  ]);

  await prisma.role.deleteMany({ where: { code: { in: roles } } });

  await sweep('report-workflow');
  await finish();
})().catch(async error => {
  await fail(error);
});
