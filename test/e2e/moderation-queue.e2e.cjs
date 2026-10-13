'use strict';

/**
 * §5.9 — the moderation queue a reviewer actually works.
 *
 * The old queue took one `type` and one `state`, reported `reportCount` as `1` for anything
 * reported at all, had no deadline and no priority, offered no detail endpoint, and let the portal
 * guess the buttons. Three of its decisions did nothing: `WARN_AUTHOR` issued no strike and sent
 * no notification, `APPROVE` left held content held, and `REJECT` did nothing to an anonymous
 * post — the item closed and the trail said a decision had been taken.
 *
 * So most of what is asserted here is that something now *happens*.
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

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const key = () => ({
  'Idempotency-Key': `e2e-q-${Date.now()}-${Math.random().toString(36).slice(2)}`,
});

async function main() {
  console.log('═══ test moderation-queue ═══');

  const author = await makeUser('queue-author', { cityId: 'BRISTOL' });
  const reporter1 = await makeUser('queue-reporter-1');
  const reporter2 = await makeUser('queue-reporter-2');
  const lead = await makeAdmin('queue-lead', 'super_admin');
  const reviewer = await makeAdmin('queue-reviewer', 'trust_safety');
  const other = await makeAdmin('queue-other', 'trust_safety');
  const support = await makeAdmin('queue-support', 'support');
  const leadHeaders = adminHeaders(lead);
  const reviewerHeaders = adminHeaders(reviewer);

  // ── 1. An anonymous post raises an item with a priority and a deadline ────
  heading('1. an item arrives with a band and a deadline');

  const posted = await api(author.token, 'POST', '/community/updates', {
    content: 'An ordinary anonymous post, waiting for somebody to read it.',
    cityId: 'BRISTOL',
    visibility: 'ANONYMOUS',
  });

  check('the anonymous post is accepted', posted.status === 201, posted.status || posted.body);

  const postId = posted.body?.data?.id;
  const itemRow = await prisma.moderationQueueItem.findFirst({
    where: { targetId: postId, type: 'ANONYMOUS_POST' },
    select: { id: true, priority: true, dueAt: true, createdAt: true },
  });

  check('it raises an ANONYMOUS_POST item', !!itemRow, itemRow);
  check('with a band', itemRow?.priority === 'NORMAL', itemRow?.priority);
  // The column is non-nullable precisely so a producer cannot forget: an item with no deadline can
  // never be overdue and sorts last in a queue ordered by urgency.
  check('and a deadline, which is not nullable', !!itemRow?.dueAt, itemRow?.dueAt);
  // A second of slack, because the two timestamps come from **different clocks**: `dueAt` is four
  // hours from the `now` the deadline service captured, and `createdAt` is Postgres' `now()` a few
  // milliseconds later. A strict `>=` is off by that gap and flakes — it failed once at
  // 3.9999994 hours, which is nothing about the rule and everything about which clock went first.
  // The rule being tested is four *working* hours rather than four wall-clock ones, and a second
  // of tolerance cannot hide a weekend.
  const slackMs = 1_000;

  check(
    'four working hours, not four wall-clock ones (§13.5)',
    itemRow && itemRow.dueAt.getTime() - itemRow.createdAt.getTime() >= 4 * 3_600_000 - slackMs,
    itemRow && (itemRow.dueAt.getTime() - itemRow.createdAt.getTime()) / 3_600_000,
  );

  const itemId = itemRow?.id;

  // ── 2. The list ──────────────────────────────────────────────────────────
  heading('2. the list, with CSV filters and real counts');

  const list = await api(
    null,
    'GET',
    '/admin/moderation/queue?perPage=100',
    undefined,
    leadHeaders,
  );

  check('the queue answers', list.status === 200, list.status || list.body);

  const row = (list.body?.data ?? []).find(entry => entry.id === itemId);

  check('the new item is in the default view', !!row, (list.body?.data ?? []).length);
  check('rows carry a priority', row?.priority === 'NORMAL', row?.priority);
  check('rows carry a deadline and whether it has passed', !!row?.dueAt && row?.overdue === false, {
    dueAt: row?.dueAt,
    overdue: row?.overdue,
  });
  check(
    'and the content, so a decision needs no second screen',
    !!row?.content?.title,
    row?.content,
  );
  check(
    'meta counts what should never sit, and what is late',
    typeof list.body?.meta?.urgentCount === 'number' &&
      typeof list.body?.meta?.overdueCount === 'number',
    list.body?.meta,
  );
  check(
    'and counts every type, so the tab badges do not move as you change tabs',
    typeof list.body?.meta?.countsByType?.ANONYMOUS_POST === 'number' &&
      typeof list.body?.meta?.countsByType?.REPORTED_CONTENT === 'number',
    list.body?.meta?.countsByType,
  );

  const reported = await api(
    null,
    'GET',
    '/admin/moderation/queue?perPage=100&type=REPORTED_CONTENT',
    undefined,
    leadHeaders,
  );

  check('REPORTED_CONTENT can be asked for explicitly', reported.status === 200, reported.status);
  check(
    'but is not in the default set, because it is decided on the case',
    !(list.body?.data ?? []).some(entry => entry.type === 'REPORTED_CONTENT'),
    (list.body?.data ?? []).map(entry => entry.type).filter((t, i, a) => a.indexOf(t) === i),
  );

  const csv = await api(
    null,
    'GET',
    '/admin/moderation/queue?perPage=100&type=ANONYMOUS_POST,GUARD_RISK&state=PENDING,IN_REVIEW',
    undefined,
    leadHeaders,
  );

  check('several types and states in one request', csv.status === 200, csv.status || csv.body);
  check(
    'and nothing outside them',
    (csv.body?.data ?? []).every(entry => ['ANONYMOUS_POST', 'GUARD_RISK'].includes(entry.type)),
    (csv.body?.data ?? []).map(entry => entry.type),
  );

  const unassigned = await api(
    null,
    'GET',
    '/admin/moderation/queue?perPage=100&unassigned=true',
    undefined,
    leadHeaders,
  );

  check(
    'unassigned filters to what nobody is holding',
    (unassigned.body?.data ?? []).every(entry => entry.assignedTo === null),
    (unassigned.body?.data ?? []).filter(entry => entry.assignedTo).length,
  );

  // ── 3. allowedDecisions ──────────────────────────────────────────────────
  heading('3. the buttons come from the server');

  check(
    'an anonymous post offers approve, reject and escalate',
    JSON.stringify(row?.allowedDecisions) ===
      JSON.stringify(['APPROVE', 'REJECT', 'ESCALATE_GUARD']),
    row?.allowedDecisions,
  );

  const summary = await api(null, 'GET', '/admin/moderation/summary', undefined, leadHeaders);

  // Declared above `queue/:id`, which carries a ParseUUIDPipe — below it this is a 400 on a URL
  // that looks perfectly correct.
  check('the summary is not parsed as an item id', summary.status === 200, summary.status);
  check(
    'and reports per type: waiting, in review, late, and the oldest open one',
    typeof summary.body?.data?.byType?.ANONYMOUS_POST?.pending === 'number' &&
      'oldestAt' in (summary.body?.data?.byType?.ANONYMOUS_POST ?? {}),
    summary.body?.data?.byType?.ANONYMOUS_POST,
  );

  // ── 4. The detail ────────────────────────────────────────────────────────
  heading('4. the detail, with the text the offsets refer to');

  const detail = await api(
    null,
    'GET',
    `/admin/moderation/queue/${itemId}`,
    undefined,
    leadHeaders,
  );

  check('the detail answers', detail.status === 200, detail.status || detail.body);
  check(
    'it carries the scanned text field by field',
    typeof detail.body?.data?.contentDetail?.body?.content === 'string',
    detail.body?.data?.contentDetail,
  );
  // `contentDetail` was six hand-picked fields, so the reviewer's screen had the scanned text and
  // nothing else — no title, no media, no author strikes, no date, no link. It is §5.7's page now,
  // which is what the spec says it is, and `body.text` comes with it because the risk signals'
  // offsets are relative to that string.
  check(
    'and it is §5.7’s whole page, the same object the content screen serves',
    typeof detail.body?.data?.contentDetail?.body?.text === 'string' &&
      Array.isArray(detail.body?.data?.contentDetail?.media) &&
      typeof detail.body?.data?.contentDetail?.adminUrl === 'string' &&
      'deletedBy' in (detail.body?.data?.contentDetail ?? {}) &&
      'openQueueItemId' in (detail.body?.data?.contentDetail ?? {}),
    detail.body?.data?.contentDetail && Object.keys(detail.body.data.contentDetail),
  );
  check(
    'the author’s record, so a decision can be proportionate',
    detail.body?.data?.authorHistory?.activeStrikes === 0 &&
      typeof detail.body?.data?.authorHistory?.accountAgeDays === 'number',
    detail.body?.data?.authorHistory,
  );
  // §5.9's `ModerationHistoryItem[]`: scans, reports and decisions, oldest first. It used to be
  // decisions only, newest first, under its own field names — a second timeline shape for the
  // portal to special-case.
  check(
    'and the trail of past decisions',
    Array.isArray(detail.body?.data?.history),
    detail.body?.data?.history,
  );
  check(
    'in §5.9’s shape — kind, actor, summary, details — oldest first',
    (detail.body?.data?.history ?? []).every(
      entry =>
        typeof entry.kind === 'string' &&
        typeof entry.summary === 'string' &&
        'actor' in entry &&
        'details' in entry,
    ) &&
      (detail.body?.data?.history ?? []).every(
        (entry, index, all) => index === 0 || all[index - 1].at.localeCompare(entry.at) <= 0,
      ),
    detail.body?.data?.history,
  );
  check(
    'and a scan in it carries where each phrase matched, for the highlight',
    (detail.body?.data?.risk?.signals ?? []).every(
      signal =>
        'start' in signal &&
        'end' in signal &&
        (signal.start === null || typeof signal.start === 'number'),
    ),
    detail.body?.data?.risk?.signals,
  );

  // ── 5. Claim, release, assign ────────────────────────────────────────────
  heading('5. who holds what');

  const claimed = await api(
    null,
    'POST',
    `/admin/moderation/queue/${itemId}/claim`,
    {},
    reviewerHeaders,
  );

  check('a reviewer can claim it', claimed.status === 200, claimed.status || claimed.body);
  check(
    'which puts it in review',
    claimed.body?.data?.state === 'IN_REVIEW',
    claimed.body?.data?.state,
  );
  check(
    'with their name on it',
    claimed.body?.data?.assignedTo?.id === reviewer.id,
    claimed.body?.data?.assignedTo,
  );

  const stolen = await api(
    null,
    'POST',
    `/admin/moderation/queue/${itemId}/claim`,
    {},
    adminHeaders(other),
  );

  check('somebody else cannot take it', stolen.status === 409, stolen.status);
  check(
    'and is told who has it, by name rather than buried in a message',
    stolen.body?.error?.code === 'CLAIMED_BY_OTHER' &&
      stolen.body?.data?.assignedToId === reviewer.id,
    stolen.body?.error,
  );

  const supportClaim = await api(
    null,
    'POST',
    `/admin/moderation/queue/${itemId}/claim`,
    {},
    adminHeaders(support),
  );

  // Claim moved from `moderation:read` to `moderation:decide`: reading a queue and taking an item
  // out of it are not the same right.
  check(
    'support can read the queue but not claim from it',
    supportClaim.status === 403,
    supportClaim.status,
  );

  const theirRelease = await api(
    null,
    'POST',
    `/admin/moderation/queue/${itemId}/release`,
    {},
    adminHeaders(other),
  );

  check(
    'another reviewer cannot release somebody else’s claim',
    theirRelease.status === 403,
    theirRelease.status,
  );

  const released = await api(
    null,
    'POST',
    `/admin/moderation/queue/${itemId}/release`,
    {},
    leadHeaders,
  );

  check('a lead can', released.status === 200, released.status || released.body);
  check(
    'and it goes back on the pile',
    released.body?.data?.state === 'PENDING',
    released.body?.data?.state,
  );
  check(
    'with nobody holding it',
    released.body?.data?.assignedTo === null,
    released.body?.data?.assignedTo,
  );

  const reviewerAssign = await api(
    null,
    'POST',
    `/admin/moderation/queue/${itemId}/assign`,
    { assigneeId: other.id },
    { ...reviewerHeaders, ...key() },
  );

  check(
    'a reviewer cannot hand work to somebody else',
    reviewerAssign.status === 403,
    reviewerAssign.status,
  );

  const toSupport = await api(
    null,
    'POST',
    `/admin/moderation/queue/${itemId}/assign`,
    { assigneeId: support.id },
    { ...leadHeaders, ...key() },
  );

  // Checked here rather than discovered at decide time by somebody who cannot press the button.
  check(
    'and a lead cannot assign it to somebody who could not decide it',
    toSupport.status === 400,
    toSupport.status,
  );
  check(
    'naming the field',
    (toSupport.body?.error?.details ?? []).some(entry => entry.field === 'assigneeId'),
    toSupport.body?.error,
  );

  const assigned = await api(
    null,
    'POST',
    `/admin/moderation/queue/${itemId}/assign`,
    { assigneeId: reviewer.id },
    { ...leadHeaders, ...key() },
  );

  check(
    'a lead can assign it to a reviewer',
    assigned.status === 200,
    assigned.status || assigned.body,
  );
  check(
    'and it reads as theirs',
    assigned.body?.data?.assignedTo?.id === reviewer.id,
    assigned.body?.data?.assignedTo,
  );

  // ── 6. A rejection the author can read ───────────────────────────────────
  heading('6. REJECT does something now');

  const bare = await api(
    null,
    'POST',
    `/admin/moderation/queue/${itemId}/decide`,
    { decision: 'REJECT', reasonCode: 'SAFETY_CONCERN', note: 'Not suitable.' },
    { ...reviewerHeaders, ...key() },
  );

  check('rejecting with no words for the author is refused', bare.status === 422, bare.status);
  check(
    'with its own code, not a generic validation error',
    bare.body?.error?.code === 'MEMBER_MESSAGE_REQUIRED',
    bare.body?.error,
  );

  const wrong = await api(
    null,
    'POST',
    `/admin/moderation/queue/${itemId}/decide`,
    { decision: 'RESTORE_REACH', reasonCode: 'OTHER', memberMessage: 'x' },
    { ...reviewerHeaders, ...key() },
  );

  check('a decision outside the allowed set is refused', wrong.status === 422, wrong.status);
  check(
    'and the refusal says what was allowed',
    wrong.body?.error?.code === 'INVALID_DECISION' &&
      Array.isArray(wrong.body?.data?.allowedDecisions),
    wrong.body?.error ?? wrong.body?.data,
  );

  const rejected = await api(
    null,
    'POST',
    `/admin/moderation/queue/${itemId}/decide`,
    {
      decision: 'REJECT',
      reasonCode: 'SAFETY_CONCERN',
      note: 'Names somebody who has not consented.',
      memberMessage: 'We could not publish this because it names somebody else.',
    },
    { ...reviewerHeaders, ...key() },
  );

  check('the rejection lands', rejected.status === 200, rejected.status || rejected.body);
  check(
    'the item is resolved',
    rejected.body?.data?.state === 'RESOLVED',
    rejected.body?.data?.state,
  );
  check(
    'with no buttons left',
    JSON.stringify(rejected.body?.data?.allowedDecisions) === '[]',
    rejected.body?.data?.allowedDecisions,
  );
  check(
    'and the decide response tells the portal where the author stands',
    typeof rejected.body?.meta?.authorActiveStrikes === 'number' &&
      typeof rejected.body?.meta?.suggestSuspension === 'boolean',
    rejected.body?.meta,
  );

  const afterReject = await prisma.communityUpdate.findUnique({
    where: { id: postId },
    select: { visibilityState: true },
  });

  // This is the part that did nothing before: the item closed and the post stayed PENDING_APPROVAL
  // for ever, invisible with no decision recorded against it.
  check(
    'the post is actually rejected now',
    afterReject?.visibilityState === 'REJECTED',
    afterReject,
  );
  check(
    'and the author was told, in the reviewer’s words',
    (await prisma.notification.count({
      where: { userId: author.id, body: { contains: 'names somebody else' } },
    })) > 0,
  );

  const twice = await api(
    null,
    'POST',
    `/admin/moderation/queue/${itemId}/decide`,
    { decision: 'APPROVE', reasonCode: 'OTHER' },
    { ...reviewerHeaders, ...key() },
  );

  check('deciding twice is refused', twice.status === 409, twice.status);
  check('as already decided', twice.body?.error?.code === 'ALREADY_DECIDED', twice.body?.error);

  // ── 7. APPROVE publishes ─────────────────────────────────────────────────
  heading('7. APPROVE publishes what was held');

  const second = await api(author.token, 'POST', '/community/updates', {
    content: 'A second anonymous post, this one perfectly fine.',
    cityId: 'BRISTOL',
    visibility: 'ANONYMOUS',
  });
  const secondId = second.body?.data?.id;
  const secondItem = await prisma.moderationQueueItem.findFirst({
    where: { targetId: secondId, type: 'ANONYMOUS_POST' },
    select: { id: true },
  });

  check('it is held', second.status === 201 && !!secondItem, second.status);

  const beforeApprove = await prisma.communityUpdate.findUnique({
    where: { id: secondId },
    select: { visibilityState: true },
  });

  check(
    'and invisible while it waits',
    beforeApprove?.visibilityState === 'PENDING_APPROVAL',
    beforeApprove,
  );

  const unclaimed = await api(
    null,
    'POST',
    `/admin/moderation/queue/${secondItem.id}/decide`,
    { decision: 'APPROVE', reasonCode: 'OTHER', note: 'Read it, it is fine.' },
    { ...reviewerHeaders, ...key() },
  );

  check('a reviewer must claim before deciding', unclaimed.status === 409, unclaimed.status);
  check(
    'and is told which',
    unclaimed.body?.error?.code === 'CLAIM_REQUIRED',
    unclaimed.body?.error,
  );

  const byLead = await api(
    null,
    'POST',
    `/admin/moderation/queue/${secondItem.id}/decide`,
    { decision: 'APPROVE', reasonCode: 'OTHER', note: 'Read it, it is fine.' },
    { ...leadHeaders, ...key() },
  );

  // A lead may step in on an unclaimed item, and the trail records them as the holder.
  check('a lead may step in', byLead.status === 200, byLead.status || byLead.body);
  check(
    'and is recorded as the holder',
    byLead.body?.data?.assignedTo?.id === lead.id,
    byLead.body?.data?.assignedTo,
  );

  const afterApprove = await prisma.communityUpdate.findUnique({
    where: { id: secondId },
    select: { visibilityState: true },
  });

  check('the post is published', afterApprove?.visibilityState === 'VISIBLE', afterApprove);
  check(
    'and the author was told it is live',
    (await prisma.notification.count({
      where: { userId: author.id, title: { contains: 'anonymous post is live' } },
    })) > 0,
  );

  // ── 8. WARN_AUTHOR actually warns ────────────────────────────────────────
  heading('8. WARN_AUTHOR issues a strike and tells them');

  const flagged = await makeUser('queue-warned');
  const message = await prisma.moderationQueueItem.create({
    data: {
      type: 'FLAGGED_CONTENT',
      targetType: 'MESSAGE',
      targetId: `e2e-msg-${Date.now()}`,
      subjectUserId: flagged.id,
      riskLevel: 'HIGH',
      riskScore: 60,
      summary: 'Flagged message',
      priority: 'HIGH',
      dueAt: new Date(Date.now() + 4 * 3_600_000),
    },
    select: { id: true },
  });

  const msgDetail = await api(
    null,
    'GET',
    `/admin/moderation/queue/${message.id}`,
    undefined,
    leadHeaders,
  );

  // §6.8: a private message is never hidden, so there is nothing to approve or remove — only the
  // sender to act on. Offering REMOVE_CONTENT here would be a button that cannot work.
  check(
    'a flagged message offers only what can be done to the sender',
    JSON.stringify(msgDetail.body?.data?.allowedDecisions) ===
      JSON.stringify(['NO_ACTION', 'WARN_AUTHOR', 'SUSPEND_AUTHOR', 'ESCALATE_GUARD']),
    msgDetail.body?.data?.allowedDecisions,
  );

  const warned = await api(
    null,
    'POST',
    `/admin/moderation/queue/${message.id}/decide`,
    {
      decision: 'WARN_AUTHOR',
      reasonCode: 'SAFETY_CONCERN',
      note: 'Pressuring somebody for money.',
      memberMessage: 'Please do not ask other members for money.',
    },
    { ...leadHeaders, ...key() },
  );

  check('the warning lands', warned.status === 200, warned.status || warned.body);

  const strikes = await prisma.strike.count({ where: { userId: flagged.id, revokedAt: null } });

  // §9's B6: this issued no strike and sent no notification. The reviewer pressed "warn the
  // author" and the author was never warned.
  check('a strike exists', strikes === 1, strikes);
  check(
    'the member was told',
    (await prisma.notification.count({
      where: { userId: flagged.id, body: { contains: 'ask other members for money' } },
    })) > 0,
  );
  check(
    'and the response reports where they now stand',
    warned.body?.meta?.authorActiveStrikes === 1,
    warned.body?.meta,
  );

  const quiet = await prisma.moderationQueueItem.create({
    data: {
      type: 'FLAGGED_CONTENT',
      targetType: 'MESSAGE',
      targetId: `e2e-msg2-${Date.now()}`,
      subjectUserId: flagged.id,
      riskLevel: 'HIGH',
      riskScore: 60,
      priority: 'HIGH',
      dueAt: new Date(Date.now() + 4 * 3_600_000),
    },
    select: { id: true },
  });

  await api(
    null,
    'POST',
    `/admin/moderation/queue/${quiet.id}/decide`,
    {
      decision: 'WARN_AUTHOR',
      reasonCode: 'CORRECTION',
      note: 'A first offence, a quiet word.',
      memberMessage: 'A quiet word about that message.',
      issueStrike: false,
    },
    { ...leadHeaders, ...key() },
  );

  check(
    'a warning without a strike still reaches the member',
    (await prisma.strike.count({ where: { userId: flagged.id, revokedAt: null } })) === 1 &&
      (await prisma.notification.count({
        where: { userId: flagged.id, body: { contains: 'quiet word' } },
      })) > 0,
  );

  // ── 9. reportCount is a real number ──────────────────────────────────────
  heading('9. reportCount counts people, not one');

  const victimPost = await api(author.token, 'POST', '/community/updates', {
    content: 'A post two people are about to report for the same reason.',
    cityId: 'BRISTOL',
  });
  const victimId = victimPost.body?.data?.id;

  for (const [who, reason] of [
    [reporter1, 'SPAM'],
    [reporter2, 'SPAM'],
  ]) {
    await api(who.token, 'POST', '/moderation/reports', {
      targetType: 'UPDATE',
      targetId: victimId,
      reasonCode: reason,
      note: 'Reported by an e2e script.',
    });
  }

  const caseItem = await prisma.moderationQueueItem.findFirst({
    where: { targetId: victimId, type: 'REPORTED_CONTENT' },
    select: { id: true, priority: true, dueAt: true },
  });

  check('the reports raise one item, not two', !!caseItem, caseItem);
  check(
    'with the case’s own band and deadline',
    !!caseItem?.priority && !!caseItem?.dueAt,
    caseItem,
  );

  const reportedRow = await api(
    null,
    'GET',
    `/admin/moderation/queue/${caseItem.id}`,
    undefined,
    leadHeaders,
  );

  // The old row said `1` for anything reported at all — the number a reviewer uses to decide what
  // to open first.
  check(
    'reportCount is two',
    reportedRow.body?.data?.reportCount === 2,
    reportedRow.body?.data?.reportCount,
  );
  check(
    'and the item carries no buttons, because the case owns the decision',
    JSON.stringify(reportedRow.body?.data?.allowedDecisions) === '[]',
    reportedRow.body?.data?.allowedDecisions,
  );

  const delegated = await api(
    null,
    'POST',
    `/admin/moderation/queue/${caseItem.id}/decide`,
    { decision: 'REMOVE_CONTENT', reasonCode: 'SAFETY_CONCERN', note: 'Trying the wrong door.' },
    { ...leadHeaders, ...key() },
  );

  check('deciding it here is refused', delegated.status === 409, delegated.status);
  check(
    'and the refusal says where to go instead',
    delegated.body?.error?.code === 'INVALID_TRANSITION' &&
      /reports\/cases/.test(delegated.body?.error?.message ?? ''),
    delegated.body?.error,
  );

  // ── 10. Content on every kind, not six of them ───────────────────────────
  heading('10. a flagged guide is not a blank row');

  const guide = await prisma.guide.create({
    data: {
      title: 'An e2e guide waiting for review',
      intro: 'Something a reviewer should be able to read from the queue row.',
      topicCode: 'FINANCE',
      isAutoGenerated: true,
      blocks: [],
      // §1.8: an auto-generated guide with no sources is never published, whoever asks. Without
      // one here, APPROVE is refused — which is the next check.
      sources: {
        create: [{ type: 'REQUEST', refId: 'e2e-source', label: 'An answered question' }],
      },
    },
    select: { id: true },
  });
  const sourceless = await prisma.guide.create({
    data: {
      title: 'An e2e guide with nothing behind it',
      intro: 'No sources, so it may never be published.',
      topicCode: 'FINANCE',
      isAutoGenerated: true,
      blocks: [],
    },
    select: { id: true },
  });
  const sourcelessItem = await prisma.moderationQueueItem.create({
    data: {
      type: 'AUTO_GUIDE',
      targetType: 'GUIDE',
      targetId: sourceless.id,
      summary: 'An e2e guide with nothing behind it',
      priority: 'NORMAL',
      dueAt: new Date(Date.now() + 24 * 3_600_000),
    },
    select: { id: true },
  });
  const guideItem = await prisma.moderationQueueItem.create({
    data: {
      type: 'AUTO_GUIDE',
      targetType: 'GUIDE',
      targetId: guide.id,
      summary: 'An e2e guide waiting for review',
      priority: 'NORMAL',
      dueAt: new Date(Date.now() + 24 * 3_600_000),
    },
    select: { id: true },
  });

  const guideRow = await api(
    null,
    'GET',
    `/admin/moderation/queue/${guideItem.id}`,
    undefined,
    leadHeaders,
  );

  // The old resolver covered six of twenty target types by hand, so a flagged guide, shop, listing
  // or Connect post arrived as "something was flagged" and nothing else.
  check(
    'a guide row carries its content',
    !!guideRow.body?.data?.content?.title,
    guideRow.body?.data?.content,
  );
  check(
    'and offers publish or reject',
    JSON.stringify(guideRow.body?.data?.allowedDecisions) === JSON.stringify(['APPROVE', 'REJECT']),
    guideRow.body?.data?.allowedDecisions,
  );

  const published = await api(
    null,
    'POST',
    `/admin/moderation/queue/${guideItem.id}/decide`,
    { decision: 'APPROVE', reasonCode: 'OTHER', note: 'Reads well and the sources check out.' },
    { ...leadHeaders, ...key() },
  );

  check('approving it lands', published.status === 200, published.status || published.body);

  const guideAfter = await prisma.guide.findUnique({
    where: { id: guide.id },
    select: { publishedAt: true, reviewedById: true },
  });

  // `AutoGuideService.publish` is documented as "called by the admin decision path" and had no
  // caller: an approved guide was never published.
  check('and the guide is published', !!guideAfter?.publishedAt, guideAfter);
  check('by a named reviewer', guideAfter?.reviewedById === lead.id, guideAfter?.reviewedById);

  // The silent no-op this found: `publish` refuses a sourceless auto-guide by returning quietly,
  // so approving one resolved the item, wrote an audit entry saying a reviewer had approved it, and
  // published nothing — with nowhere for anybody to read why.
  const refused = await api(
    null,
    'POST',
    `/admin/moderation/queue/${sourcelessItem.id}/decide`,
    { decision: 'APPROVE', reasonCode: 'OTHER', note: 'Trying to publish one with no sources.' },
    { ...leadHeaders, ...key() },
  );

  check(
    'approving a guide that cannot be published is refused',
    refused.status === 422,
    refused.status,
  );
  check(
    'and the reviewer is told to reject it instead',
    refused.body?.error?.code === 'INVALID_DECISION' &&
      /no sources/.test(refused.body?.error?.message ?? ''),
    refused.body?.error,
  );
  check(
    'with the item left open rather than closed on a decision that did nothing',
    (
      await prisma.moderationQueueItem.findUnique({
        where: { id: sourcelessItem.id },
        select: { state: true },
      })
    )?.state === 'PENDING',
  );

  // ── §5.12: ESCALATE_GUARD actually opens a Guard case ────────────────────
  heading('escalating to Guard opens the case, rather than just saying so');

  const escalated = await makeUser('queue-escalated');
  const escalatedPost = await api(escalated.token, 'POST', '/community/updates', {
    content: 'A post a reviewer decides needs safeguarding rather than moderation.',
    cityId: 'BRISTOL',
    visibility: 'ANONYMOUS',
  });
  const escalatedPostId = escalatedPost.body?.data?.id;

  check(
    'the post is accepted',
    escalatedPost.status === 201 && !!escalatedPostId,
    escalatedPost.status || escalatedPost.body,
  );

  // `targetId: undefined` is not "no match" in Prisma — the key is dropped and the query matches
  // **anything**. An earlier version of this read `targetId: <undefined>` and happily found a
  // resolved PROFESSIONAL_REVIEW row from another suite, so the existence check passed and the
  // decide failed with ALREADY_DECIDED about an item this test never created.
  const escalatedItem = escalatedPostId
    ? await prisma.moderationQueueItem.findFirst({
        where: { targetId: escalatedPostId, type: 'ANONYMOUS_POST', decidedAt: null },
      })
    : null;

  check('and queued, undecided', !!escalatedItem, escalatedItem);

  const guardBefore = await prisma.guardThread.count({ where: { userId: escalated.id } });

  const escalate = await api(
    null,
    'POST',
    `/admin/moderation/queue/${escalatedItem.id}/decide`,
    {
      decision: 'ESCALATE_GUARD',
      reasonCode: 'SAFETY_CONCERN',
      note: 'This reads like somebody in trouble, not a moderation question.',
      guard: { categoryCode: 'SAFETY', note: 'Escalated from the anonymous queue.' },
    },
    { ...leadHeaders, ...key() },
  );

  check('the escalation lands', escalate.status === 200, escalate.body?.error ?? escalate.status);

  // The whole point of this stage. `dto.guard` was accepted and validated by the DTO and then
  // read by nothing at all: staff escalated, got a 200, and no case opened anywhere.
  const guardCase = await prisma.guardThread.findFirst({
    where: { userId: escalated.id },
    orderBy: { createdAt: 'desc' },
  });

  check('a Guard case now exists for the member', !!guardCase && guardBefore === 0, {
    before: guardBefore,
    after: guardCase?.id ?? null,
  });
  check(
    'recorded as staff-raised, against the item it came from',
    guardCase?.sourceType === 'ESCALATION' && guardCase?.sourceId === escalatedItem.id,
    { sourceType: guardCase?.sourceType, sourceId: guardCase?.sourceId },
  );
  check(
    'carrying the category the reviewer chose',
    guardCase?.categoryCode === 'SAFETY',
    guardCase?.categoryCode,
  );
  check(
    'and never below MEDIUM, because somebody decided it needed safeguarding',
    ['MEDIUM', 'HIGH', 'CRITICAL'].includes(guardCase?.riskLevel ?? ''),
    { level: guardCase?.riskLevel, score: guardCase?.riskScore },
  );
  check(
    'with a GUARD_RISK item so it reaches the safeguarding queue, not just the table',
    !!(await prisma.moderationQueueItem.findFirst({
      where: {
        type: 'GUARD_RISK',
        targetId: guardCase?.conversationId ?? '-',
        decidedAt: null,
      },
    })),
    guardCase?.conversationId,
  );
  check(
    'the member-visible subject says nothing about a report or a queue',
    !!guardCase?.subject && !/report|queue|escalat/i.test(guardCase.subject),
    guardCase?.subject,
  );

  const guardAudit = await prisma.auditLog.findFirst({
    where: { action: 'guard.case_created', targetId: guardCase?.conversationId ?? '-' },
  });

  check('and somebody is named for having opened it', !!guardAudit?.actorId, guardAudit?.action);

  await prisma.moderationQueueItem.deleteMany({
    where: { targetId: { in: [guardCase?.conversationId ?? '-', escalatedItem?.id ?? '-'] } },
  });

  await prisma.guideSource.deleteMany({ where: { guideId: { in: [guide.id, sourceless.id] } } });
  await prisma.moderationQueueItem.deleteMany({
    where: { targetId: { in: [guide.id, sourceless.id] } },
  });
  await prisma.guide.deleteMany({ where: { id: { in: [guide.id, sourceless.id] } } });

  // The tier filter used to be applied to the page after it was fetched, so `totalCount` counted
  // the unfiltered set and page two skipped rows nobody had seen. It is a join now.
  heading('the tier filter pages like every other filter');

  let tiered = await api(
    null,
    'GET',
    '/admin/moderation/queue?tier=HIGH,CRITICAL&perPage=5',
    null,
    leadHeaders,
  );

  check('filtering by tier answers → 200', tiered.status === 200, tiered.body?.error);
  check(
    'and the count describes the same set the rows came from',
    (tiered.body?.data ?? []).length === Math.min(tiered.body?.meta?.totalCount ?? 0, 5),
    { rows: tiered.body?.data?.length, total: tiered.body?.meta?.totalCount },
  );
  check(
    'with no page-local warning, because there is nothing to warn about',
    tiered.body?.meta?.tierFilterIsPageLocal === undefined,
    tiered.body?.meta,
  );

  tiered = await api(
    null,
    'GET',
    '/admin/moderation/queue?tier=CLEAN&perPage=5',
    null,
    leadHeaders,
  );

  check(
    'and a tier nothing in the queue holds is an empty page rather than an unfiltered one',
    tiered.status === 200 && (tiered.body?.data ?? []).length === 0,
    { rows: tiered.body?.data?.length, total: tiered.body?.meta?.totalCount },
  );

  await sweep('moderation-queue');
  await finish();
}

main().catch(fail);
