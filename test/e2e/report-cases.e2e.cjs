/* §7.1 Report intake: reports are the evidence, a case is the job.
 *
 * Three people reporting one post is one thing for a reviewer to read and one answer for all
 * three. That grouping is what this suite is about, along with the three rules that decide what
 * happens when a report arrives about something that has already been dealt with — the
 * lost-report bug §9 names, where a second report created work nobody could act on.
 *
 * The scanner is in it too: the priority of a case is the reason somebody gave *and* what the
 * lexicon made of the content, which is why some of the posts below are deliberately clean and
 * others deliberately are not.
 */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');

const SLA = { URGENT: 60, HIGH: 240, NORMAL: 1440 };

const caseFor = targetId =>
  prisma.reportCase.findFirst({
    where: { targetType: 'REQUEST', targetId },
    orderBy: { createdAt: 'desc' },
  });

const casesFor = targetId =>
  prisma.reportCase.findMany({ where: { targetType: 'REQUEST', targetId } });

(async () => {
  await sweep('pre-run');

  const author = await makeUser('rc-author', { cityId: 'BRISTOL' });
  const first = await makeUser('rc-first', { cityId: 'BRISTOL' });
  const second = await makeUser('rc-second', { cityId: 'BRISTOL' });
  const third = await makeUser('rc-third', { cityId: 'BRISTOL' });

  const post = async (title, description) => {
    const res = await api(author.token, 'POST', '/community/requests', {
      title,
      description,
      categoryCode: 'ACCOMMODATION',
      cityId: 'BRISTOL',
    });

    check('a request is posted', res.status === 201, res.body?.error);

    return res.body?.data?.id;
  };

  const report = (reporter, targetId, reasonCode, note) =>
    api(reporter.token, 'POST', '/moderation/reports', {
      targetType: 'REQUEST',
      targetId,
      reasonCode,
      note,
    });

  console.log('\n── Three reports, one case ─────────────────────────────────');

  const target = await post('A room in a shared flat', 'Nothing here for a lexicon to find.');

  let res = await report(first, target, 'SPAM', 'This looks like spam to me.');

  check('the first report is accepted', res.status === 202, res.body?.error);

  let item = await caseFor(target);

  check('a case is opened for it', !!item, item);
  check(
    'about the right target, and the member who posted it',
    item?.targetId === target && item?.targetUserId === author.id,
    { targetId: item?.targetId, targetUserId: item?.targetUserId },
  );
  check(
    'NORMAL: an ordinary complaint about ordinary content',
    item?.priority === 'NORMAL',
    item?.priority,
  );
  check(
    'due a day later, wall clock from the first report (§7.1)',
    Math.abs(item.dueAt - item.firstReportedAt - SLA.NORMAL * 60_000) < 2_000,
    { dueAt: item?.dueAt, firstReportedAt: item?.firstReportedAt },
  );
  check(
    'counted as one report from one person',
    item?.reportCount === 1 && item?.uniqueReporterCount === 1,
    {
      reportCount: item?.reportCount,
      uniqueReporterCount: item?.uniqueReporterCount,
    },
  );
  check(
    'and the report is filed under it',
    (await prisma.report.findFirst({ where: { reporterId: first.id, targetId: target } }))
      ?.caseId === item.id,
  );

  res = await report(second, target, 'HARASSMENT', 'Second person, same post.');
  check('a second report is accepted', res.status === 202, res.body?.error);

  res = await report(third, target, 'HATE_SPEECH', 'Third person, same post.');
  check('and a third', res.status === 202, res.body?.error);

  item = await caseFor(target);

  check('still one case, not three', (await casesFor(target)).length === 1, await casesFor(target));
  check(
    'counting three reports from three people',
    item?.reportCount === 3 && item?.uniqueReporterCount === 3,
    { reportCount: item?.reportCount, uniqueReporterCount: item?.uniqueReporterCount },
  );
  check(
    'and remembering every reason given, not only the first',
    ['SPAM', 'HARASSMENT', 'HATE_SPEECH'].every(code => item.reasonCodes.includes(code)),
    item?.reasonCodes,
  );
  check(
    'one queue item for the reviewer, linked to the case',
    !!item?.queueItemId &&
      (await prisma.moderationQueueItem.count({
        where: { targetType: 'REQUEST', targetId: target },
      })) === 1,
    item?.queueItemId,
  );

  console.log('\n── One person tapping twice is still one person ────────────');

  res = await report(first, target, 'SPAM', 'This looks like spam to me.');
  check('the repeat tap is accepted', res.status === 202, res.body?.error);

  item = await caseFor(target);

  check(
    'and changes nothing: the same reporter is folded, as it always was (G2)',
    item?.reportCount === 3 && item?.uniqueReporterCount === 3,
    { reportCount: item?.reportCount, uniqueReporterCount: item?.uniqueReporterCount },
  );

  console.log('\n── The reason and the scanner decide the priority ──────────');

  const scam = await post('Guaranteed visa, no questions', 'Message me to sort your paperwork.');

  res = await report(first, scam, 'SCAM', 'Looks like a scam.');
  item = await caseFor(scam);

  check('a scam report is URGENT whatever it scored', item?.priority === 'URGENT', item?.priority);
  check(
    'and due in an hour',
    Math.abs(item.dueAt - item.firstReportedAt - SLA.URGENT * 60_000) < 2_000,
    { dueAt: item?.dueAt },
  );

  const nasty = await post('A warning', 'I was trafficked here and told to say nothing.');

  res = await report(first, nasty, 'SPAM', 'Reported as spam, of all things.');
  item = await caseFor(nasty);

  check(
    'content the scanner calls serious is HIGH even when reported as spam',
    item?.priority === 'HIGH',
    { priority: item?.priority, risk: item?.riskLevel },
  );

  const mild = await post('A question about deposits', 'Nothing here for a lexicon to find.');

  res = await report(first, mild, 'NUDITY', 'Reported with a serious chip, on a clean post.');
  item = await caseFor(mild);

  check(
    'but a serious chip on clean content is not promoted on the reporter’s word alone',
    item?.priority === 'NORMAL',
    item?.priority,
  );

  console.log('\n── A case is never demoted under a reviewer ───────────────');

  res = await report(second, scam, 'SPAM', 'Milder reason, same post.');
  item = await caseFor(scam);

  check(
    'the urgent case stays urgent (§7.1: escalation only raises)',
    item?.priority === 'URGENT' && item?.reportCount === 2,
    { priority: item?.priority, reportCount: item?.reportCount },
  );

  console.log('\n── A dismissal stands for a week ──────────────────────────');

  const dismissed = await post('A perfectly fine post', 'Nothing here for a lexicon to find.');

  await report(first, dismissed, 'SPAM', 'First complaint.');

  const toDismiss = await caseFor(dismissed);

  await prisma.reportCase.update({
    where: { id: toDismiss.id },
    data: { state: 'DISMISSED', decision: 'NO_ACTION', decidedAt: new Date() },
  });

  res = await report(second, dismissed, 'SPAM', 'Same complaint, a day later.');
  check('a late report is accepted', res.status === 202, res.body?.error);

  check(
    'it does not reopen the argument by itself',
    (await casesFor(dismissed)).length === 1,
    await casesFor(dismissed),
  );

  item = await caseFor(dismissed);

  check(
    'it is attached to the dismissed case, where a reviewer can see it',
    item?.state === 'DISMISSED' && item?.reportCount === 2,
    { state: item?.state, reportCount: item?.reportCount },
  );

  res = await report(third, dismissed, 'SPAM', 'And a third person.');
  check('a third person is accepted', res.status === 202, res.body?.error);

  check(
    'but two new people after a dismissal is new information: a fresh case',
    (await casesFor(dismissed)).length === 2,
    (await casesFor(dismissed)).map(row => ({ state: row.state, count: row.reportCount })),
  );

  item = await caseFor(dismissed);

  check('and the fresh one is open', item?.state === 'OPEN', item?.state);
  check(
    'with the queue item handed over to it, because two cases cannot hold one item',
    !!item?.queueItemId &&
      (await prisma.reportCase.count({
        where: { targetId: dismissed, queueItemId: item.queueItemId },
      })) === 1,
    item?.queueItemId,
  );
  check(
    'and the item is back on the pile rather than left resolved',
    (await prisma.moderationQueueItem.findUnique({ where: { id: item.queueItemId } }))?.state ===
      'PENDING',
  );

  console.log('\n── An urgent report is heard straight away ────────────────');

  const urgent = await post('Another fine post', 'Nothing here for a lexicon to find.');

  await report(first, urgent, 'SPAM', 'First complaint.');

  const alsoDismissed = await caseFor(urgent);

  await prisma.reportCase.update({
    where: { id: alsoDismissed.id },
    data: { state: 'DISMISSED', decision: 'NO_ACTION', decidedAt: new Date() },
  });

  res = await report(second, urgent, 'SAFETY_CONCERN', 'Somebody is in danger.');
  check('the urgent report is accepted', res.status === 202, res.body?.error);

  check(
    'a dismissal does not stand in the way of a safeguarding report',
    (await casesFor(urgent)).length === 2,
    (await casesFor(urgent)).map(row => row.state),
  );
  check(
    'and it is urgent',
    (await caseFor(urgent))?.priority === 'URGENT',
    (await caseFor(urgent))?.priority,
  );

  console.log('\n── A decision on removed content answers the next report ──');

  const gone = await post('A post that was taken down', 'Nothing here for a lexicon to find.');

  await report(first, gone, 'SPAM', 'First complaint.');

  const actioned = await caseFor(gone);

  await prisma.reportCase.update({
    where: { id: actioned.id },
    data: { state: 'ACTIONED', decision: 'REMOVE_CONTENT', decidedAt: new Date() },
  });
  // What the decision did, by hand: §5.10's decide path is the next stage.
  await prisma.communityRequest.update({ where: { id: gone }, data: { deletedAt: new Date() } });

  res = await report(second, gone, 'SPAM', 'Reported from a screen that had not refreshed.');
  check('the report is accepted rather than refused', res.status === 202, res.body?.error);

  check(
    'no new case: the answer is the one already given',
    (await casesFor(gone)).length === 1,
    await casesFor(gone),
  );

  const answered = await prisma.report.findFirst({
    where: { reporterId: second.id, targetId: gone },
  });

  check(
    'and the report itself carries that answer, so the reporter can be told (§7.3)',
    answered?.state === 'ACTIONED' && answered?.decision === 'REMOVE_CONTENT',
    { state: answered?.state, decision: answered?.decision },
  );
  check('filed under the case that decided it', answered?.caseId === actioned.id, answered?.caseId);

  console.log('\n── Reporting a member works the same way ──────────────────');

  res = await api(first.token, 'POST', '/moderation/reports', {
    targetType: 'USER',
    targetId: author.id,
    reasonCode: 'IMPERSONATION',
    note: 'This is not who they say they are.',
  });

  check('a report about a member is accepted', res.status === 202, res.body?.error);

  const aboutMember = await prisma.reportCase.findFirst({
    where: { targetType: 'USER', targetId: author.id },
  });

  check(
    'with a case of its own, though there is no content to scan',
    !!aboutMember && aboutMember.priority === 'NORMAL',
    aboutMember,
  );

  await sweep('report-cases');
  await finish();
})().catch(async error => {
  await fail(error);
});
