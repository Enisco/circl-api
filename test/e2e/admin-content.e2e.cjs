/**
 * §5.7 — the content screens.
 *
 * Seventeen kinds of content behind one route. The risk this suite exists for is not that one
 * endpoint is wrong: it is that sixteen of them are right and the seventeenth queries a column
 * that does not exist on its table, which no amount of testing `requests` will find. So every
 * kind is listed, and the kinds with an awkward shape — an author on a parent row, no
 * `deleted_at`, a `posted_at` instead of a `created_at` — are named individually.
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

/** Every slug the registry serves, in the order the portal's nav lists them. */
const SLUGS = [
  'requests',
  'responses',
  'offers',
  'updates',
  'update-replies',
  'guides',
  'groups',
  'group-posts',
  'group-post-replies',
  'connect-profiles',
  'connect-posts',
  'connect-stories',
  'listings',
  'services',
  'stores',
  'items',
  'reviews',
];

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

async function main() {
  await sweep('pre-run');

  const staff = await makeAdmin('content-staff', 'manager');
  const support = await makeAdmin('content-support', 'support');
  const headers = adminHeaders(staff);

  // ── 1. Every kind lists ───────────────────────────────────────────────────
  heading('1. all seventeen kinds answer');

  const failures = [];

  for (const slug of SLUGS) {
    const res = await api(null, 'GET', `/admin/content/${slug}?perPage=2`, null, headers);

    if (res.status !== 200) failures.push([slug, res.status, res.body?.error?.message]);
  }

  check('every content type lists without a 500', failures.length === 0, failures);

  // The kinds whose shape is unlike the others. Named individually because a generic loop passing
  // says nothing about whether these four queried the right column.
  for (const slug of ['services', 'connect-posts', 'connect-stories', 'reviews']) {
    const res = await api(null, 'GET', `/admin/content/${slug}?perPage=3`, null, headers);
    const rows = res.body?.data ?? [];

    check(
      `${slug} resolves an author, which it has to reach through a join or an odd column`,
      res.status === 200 && (rows.length === 0 || rows.every(row => row.author !== undefined)),
      rows[0],
    );
  }

  const unknown = await api(null, 'GET', '/admin/content/nonsense', null, headers);

  check('an unknown type is a 404', unknown.status === 404, unknown.status);
  check(
    'and names the types that do exist, so a typo is self-correcting',
    (unknown.body?.data?.types ?? []).length === SLUGS.length,
    unknown.body?.data?.types?.length,
  );

  // ── 2. Filters that belong to another kind ────────────────────────────────
  heading('2. a filter from another kind is refused, not ignored');

  const wrongFilter = await api(null, 'GET', '/admin/content/requests?ratings=5', null, headers);

  // Ignoring it would return every request, which reads as "there are 248 five-star requests".
  check(
    'ratings on requests is a 400 naming the field',
    wrongFilter.status === 400 &&
      (wrongFilter.body?.error?.details ?? []).some(detail => detail.field === 'ratings'),
    wrongFilter.body?.error,
  );

  const rightFilter = await api(null, 'GET', '/admin/content/reviews?ratings=5', null, headers);

  check(
    'and the same filter on reviews is accepted',
    rightFilter.status === 200 &&
      (rightFilter.body?.data ?? []).every(row => row.metrics?.rating === 5),
    (rightFilter.body?.data ?? []).map(row => row.metrics?.rating),
  );

  const noSoftDelete = await api(
    null,
    'GET',
    '/admin/content/services?deleted=only',
    null,
    headers,
  );

  check(
    'a kind with no deleted_at says so rather than returning nothing',
    noSoftDelete.status === 400 &&
      (noSoftDelete.body?.error?.message ?? '').includes('removed outright'),
    noSoftDelete.body?.error?.message,
  );

  // ── 3. The CLEAN tier includes content nobody has scanned ────────────────
  heading('3. unscanned content is CLEAN, not dirty');

  const author = await makeUser('content-author');
  const posted = await api(author.token, 'POST', '/community/updates', {
    content: 'An ordinary post for the content screens to list.',
    cityId: 'BRISTOL',
  });
  const postId = posted.body?.data?.id;

  check('a post to work with', posted.status === 201 && !!postId, posted.status);

  // A HIGH safety row, written directly: the point is the filter, not the scanner.
  await prisma.contentSafety.upsert({
    where: { targetType_targetId: { targetType: 'UPDATE', targetId: postId } },
    update: { tier: 'HIGH', finalScore: 72 },
    create: {
      targetType: 'UPDATE',
      targetId: postId,
      authorId: author.id,
      tier: 'HIGH',
      finalScore: 72,
      scanStatus: 'COMPLETE',
    },
  });

  const high = await api(
    null,
    'GET',
    `/admin/content/updates?tier=HIGH&authorId=${author.id}`,
    null,
    headers,
  );
  const cleanOnly = await api(
    null,
    'GET',
    `/admin/content/updates?tier=CLEAN&authorId=${author.id}`,
    null,
    headers,
  );

  check(
    'tier=HIGH finds the scanned post',
    (high.body?.data ?? []).some(row => row.id === postId),
    (high.body?.data ?? []).map(row => row.id),
  );
  check(
    'and tier=CLEAN excludes it',
    !(cleanOnly.body?.data ?? []).some(row => row.id === postId),
    (cleanOnly.body?.data ?? []).map(row => row.id),
  );

  const second = await api(author.token, 'POST', '/community/updates', {
    content: 'A second post, which nothing has scanned.',
    cityId: 'BRISTOL',
  });
  const unscannedId = second.body?.data?.id;

  await prisma.contentSafety.deleteMany({ where: { targetType: 'UPDATE', targetId: unscannedId } });

  const cleanAgain = await api(
    null,
    'GET',
    `/admin/content/updates?tier=CLEAN&authorId=${author.id}`,
    null,
    headers,
  );

  // The case the obvious implementation gets wrong: filtering to CLEAN by joining the safety table
  // returns only the scanned-and-found-clean rows, so most of the platform disappears and the rest
  // reads as though it were dirty.
  check(
    'tier=CLEAN includes a post with no safety row at all',
    (cleanAgain.body?.data ?? []).some(row => row.id === unscannedId),
    { looking: unscannedId, got: (cleanAgain.body?.data ?? []).map(row => row.id) },
  );

  // ── 4. Deleted content ───────────────────────────────────────────────────
  heading('4. removed content is out of the list unless asked for');

  await prisma.communityUpdate.update({
    where: { id: unscannedId },
    data: { deletedAt: new Date() },
  });

  const base = `/admin/content/updates?authorId=${author.id}`;
  const excluded = await api(null, 'GET', base, null, headers);
  const included = await api(null, 'GET', `${base}&deleted=include`, null, headers);
  const only = await api(null, 'GET', `${base}&deleted=only`, null, headers);

  check(
    'excluded by default, because the list is what is on the platform',
    !(excluded.body?.data ?? []).some(row => row.id === unscannedId),
    (excluded.body?.data ?? []).map(row => row.id),
  );
  check(
    'include brings it back',
    (included.body?.data ?? []).some(row => row.id === unscannedId),
    (included.body?.data ?? []).map(row => row.id),
  );
  check(
    'only shows nothing else',
    (only.body?.data ?? []).length >= 1 &&
      (only.body?.data ?? []).every(row => row.deletedAt !== null),
    (only.body?.data ?? []).map(row => [row.id, row.deletedAt]),
  );

  // ── 5. The detail ────────────────────────────────────────────────────────
  heading('5. one item, with what a reviewer needs beside it');

  const detail = await api(null, 'GET', `/admin/content/updates/${postId}`, null, headers);
  const page = detail.body?.data;

  check('the detail answers', detail.status === 200, detail.status || detail.body?.error);
  check(
    'with the scanned body, because the risk offsets refer to it',
    typeof page?.body?.text === 'string' && page.body.text.length > 0,
    Object.keys(page?.body ?? {}),
  );
  check('and the risk row we wrote', page?.risk?.tier === 'HIGH', page?.risk);
  check(
    'the author carries their strikes and account age, to tell a first mistake from a pattern',
    typeof page?.author?.activeStrikes === 'number' &&
      typeof page?.author?.accountAgeDays === 'number',
    page?.author,
  );
  check(
    'and whether anybody has reported it',
    typeof page?.reportCount === 'number',
    page?.reportCount,
  );

  // `status` is SQL per kind, so the list and the detail compute it two different ways. They have
  // to agree: a guide reading PUBLISHED on one screen and null on the next is the bug this catches.
  for (const slug of ['guides', 'stores', 'connect-stories', 'requests']) {
    const list = await api(null, 'GET', `/admin/content/${slug}?perPage=1`, null, headers);
    const row = (list.body?.data ?? [])[0];

    if (!row) continue;

    const one = await api(null, 'GET', `/admin/content/${slug}/${row.id}`, null, headers);

    check(
      `${slug}: the status on the row and on the detail agree`,
      row.status === one.body?.data?.status,
      { row: row.status, detail: one.body?.data?.status },
    );
  }

  const missing = await api(
    null,
    'GET',
    '/admin/content/updates/00000000-0000-4000-8000-000000000000',
    null,
    headers,
  );

  check('an id of the wrong kind is a 404', missing.status === 404, missing.status);

  // ── 6. History ───────────────────────────────────────────────────────────
  heading('6. what has happened to it, oldest first');

  const history = await api(null, 'GET', `/admin/content/updates/${postId}/history`, null, headers);
  const items = history.body?.data ?? [];

  check('history answers an array', history.status === 200 && Array.isArray(items), history.status);
  check(
    'in order, because reading it backwards swaps "got worse" and "got better"',
    items.every((item, index) => index === 0 || items[index - 1].at.localeCompare(item.at) <= 0),
    items.map(item => item.at),
  );

  // ── 7. Hide ──────────────────────────────────────────────────────────────
  heading('7. a hide is a hold, and always ends in a decision');

  const target = await api(author.token, 'POST', '/community/updates', {
    content: 'A post staff are about to hide while somebody looks at it.',
    cityId: 'BRISTOL',
  });
  const hideId = target.body?.data?.id;
  const key = () => ({ 'Idempotency-Key': `ac-${Math.random().toString(36).slice(2)}` });

  const reader = await makeUser('content-reader');
  const beforeHide = await api(reader.token, 'GET', `/community/updates/${hideId}`);

  check('the post is reachable before the hide', beforeHide.status === 200, beforeHide.status);

  const hidden = await api(
    null,
    'POST',
    `/admin/content/updates/${hideId}/hide`,
    { reasonCode: 'SAFETY_CONCERN', note: 'Looks like a scam, checking.' },
    { ...headers, ...key() },
  );

  check('the hide lands', hidden.status === 200, hidden.body?.error ?? hidden.status);
  check(
    'the content is held, not removed',
    hidden.body?.data?.visibilityState === 'HELD' && hidden.body?.data?.deletedAt === null,
    { state: hidden.body?.data?.visibilityState, deletedAt: hidden.body?.data?.deletedAt },
  );

  const afterHide = await api(reader.token, 'GET', `/community/updates/${hideId}`);

  // The mirrored column on the content's own row is what the member read paths filter on. Setting
  // only the safety row leaves it reading as held while still being served.
  check(
    'and nobody else can reach it any more',
    afterHide.status === 404 || afterHide.status === 403,
    afterHide.status,
  );

  const queued = await prisma.moderationQueueItem.findFirst({
    where: { type: 'FLAGGED_CONTENT', targetId: hideId, decidedAt: null },
    select: { riskLevel: true, dueAt: true, createdAt: true, summary: true },
  });

  check(
    'a hide opens a FLAGGED_CONTENT item, so it cannot be a disappearance nobody owns',
    !!queued,
    queued,
  );
  check('at HIGH', queued?.riskLevel === 'HIGH', queued?.riskLevel);
  check(
    'with a four-working-hour deadline',
    !!queued?.dueAt && queued.dueAt.getTime() - queued.createdAt.getTime() >= 4 * 3_600_000 - 1_000,
    queued && (queued.dueAt.getTime() - queued.createdAt.getTime()) / 3_600_000,
  );

  const toldHold = await prisma.notification.findFirst({
    where: { userId: author.id, title: { contains: 'being reviewed' } },
  });

  check('and the author is told it is under review', !!toldHold, toldHold?.title);

  const hideAgain = await api(
    null,
    'POST',
    `/admin/content/updates/${hideId}/hide`,
    { reasonCode: 'SAFETY_CONCERN', note: 'Again.' },
    { ...headers, ...key() },
  );

  check(
    'hiding it twice is a 409 rather than a second hold over the first',
    hideAgain.status === 409 && hideAgain.body?.error?.code === 'INVALID_TRANSITION',
    { status: hideAgain.status, code: hideAgain.body?.error?.code },
  );

  const unreasoned = await api(
    null,
    'POST',
    `/admin/content/updates/${hideId}/hide`,
    { reasonCode: 'POLICY_VIOLATION' },
    { ...headers, ...key() },
  );

  check(
    'a policy violation with no policy named is refused',
    unreasoned.status === 422 && unreasoned.body?.error?.code === 'REASON_REQUIRED',
    unreasoned.body?.error,
  );

  // ── 8. Remove, and what it closes ────────────────────────────────────────
  heading('8. a removal answers the work that was open about it');

  const removed = await api(
    null,
    'POST',
    `/admin/content/updates/${hideId}/remove`,
    { reasonCode: 'SAFETY_CONCERN', note: 'Confirmed scam.', strike: true },
    { ...headers, ...key() },
  );

  check('the removal lands', removed.status === 200, removed.body?.error ?? removed.status);
  check(
    'the content is gone and recorded as a staff removal',
    removed.body?.data?.deletedAt !== null && removed.body?.data?.deletedBy === 'STAFF',
    { deletedAt: removed.body?.data?.deletedAt, deletedBy: removed.body?.data?.deletedBy },
  );

  const closedItem = await prisma.moderationQueueItem.findFirst({
    where: { type: 'FLAGGED_CONTENT', targetId: hideId },
    select: { state: true, decision: true },
  });

  check(
    'the queue item it opened is closed, not left for somebody to find nothing to do',
    closedItem?.state === 'RESOLVED' && closedItem?.decision === 'REMOVE_CONTENT',
    closedItem,
  );

  const strike = await prisma.strike.findFirst({
    where: { userId: author.id, sourceId: hideId },
    select: { sourceType: true, sourceTargetType: true },
  });

  // §5.14 needs both: a content id is only unique within its own table, so a strike recorded
  // against the id alone cannot be traced back to the post it was about.
  check(
    'the strike records which kind of content it came from, not just the id',
    strike?.sourceType === 'CONTENT' && strike?.sourceTargetType === 'UPDATE',
    strike,
  );

  const removeAgain = await api(
    null,
    'POST',
    `/admin/content/updates/${hideId}/remove`,
    { reasonCode: 'OTHER', note: 'Again.' },
    { ...headers, ...key() },
  );

  check('removing it twice is a 409', removeAgain.status === 409, removeAgain.status);

  // ── 9. Restore, and whose deletion it was ────────────────────────────────
  heading('9. staff can undo their own removal, not the author’s');

  const restored = await api(
    null,
    'POST',
    `/admin/content/updates/${hideId}/restore`,
    { reasonCode: 'CORRECTION', note: 'Looked again, it is fine.' },
    { ...headers, ...key() },
  );

  check('the restore lands', restored.status === 200, restored.body?.error ?? restored.status);
  check(
    'and the post is live again',
    restored.body?.data?.deletedAt === null && restored.body?.data?.visibilityState === 'VISIBLE',
    { deletedAt: restored.body?.data?.deletedAt, state: restored.body?.data?.visibilityState },
  );

  const backForReader = await api(reader.token, 'GET', `/community/updates/${hideId}`);

  check('reachable by everybody again', backForReader.status === 200, backForReader.status);

  // A post the author deleted themselves. Staff must not be able to publish something somebody
  // chose to withdraw.
  const ownPost = await api(author.token, 'POST', '/community/updates', {
    content: 'A post its author is about to delete themselves.',
    cityId: 'BRISTOL',
  });
  const ownId = ownPost.body?.data?.id;

  await api(author.token, 'DELETE', `/community/updates/${ownId}`);

  const ownDetail = await api(null, 'GET', `/admin/content/updates/${ownId}`, null, headers);

  check(
    'an author’s own deletion is recorded as theirs',
    ownDetail.body?.data?.deletedBy === 'AUTHOR',
    ownDetail.body?.data?.deletedBy,
  );

  const refused = await api(
    null,
    'POST',
    `/admin/content/updates/${ownId}/restore`,
    { reasonCode: 'CORRECTION', note: 'Putting it back.' },
    { ...headers, ...key() },
  );

  check(
    'and staff cannot put it back — it was not theirs to remove',
    refused.status === 409 && refused.body?.error?.code === 'RESTORE_NOT_ALLOWED',
    { status: refused.status, code: refused.body?.error?.code },
  );

  // ── 10. Rescan ───────────────────────────────────────────────────────────
  heading('10. a fresh opinion on words that have not changed');

  const rescanned = await api(
    null,
    'POST',
    `/admin/content/updates/${hideId}/rescan`,
    {},
    { ...headers, ...key() },
  );

  check('the rescan answers', rescanned.status === 200, rescanned.body?.error ?? rescanned.status);
  check(
    'with the safety row it produced',
    !!rescanned.body?.data?.contentSafety?.tier,
    rescanned.body?.data?.contentSafety,
  );
  check(
    'and it is audited, because a verdict that moved without an edit needs explaining',
    (await prisma.auditLog.count({ where: { action: 'content.rescanned', targetId: hideId } })) >=
      1,
  );

  // ── 11. Groups and shops: the two type-specific endpoints ────────────────
  heading('11. group members and shop compliance');

  const anyGroup = await prisma.group.findFirst({
    where: { deletedAt: null },
    select: { id: true },
  });
  const members = await api(
    null,
    'GET',
    `/admin/content/groups/${anyGroup?.id}/members`,
    null,
    headers,
  );

  // Declared above `:type/:id/...`, because `groups` is itself a valid `:type`: below it, this URL
  // would be answered by the detail handler looking for a group called "members".
  check(
    'the group members route is not swallowed by :type/:id',
    members.status === 200 && Array.isArray(members.body?.data),
    members.status || members.body?.error,
  );
  check(
    'and each row says whether they run the group',
    (members.body?.data ?? []).every(row => typeof row.isAdmin === 'boolean' && !!row.member?.id),
    (members.body?.data ?? [])[0],
  );

  const anyStore = await prisma.store.findFirst({
    where: { deletedAt: null, complianceState: 'ACTIVE' },
    select: { id: true },
  });

  const suspendedShop = await api(
    null,
    'PATCH',
    `/admin/content/stores/${anyStore?.id}/compliance`,
    {
      complianceState: 'SUSPENDED',
      reasonCode: 'SAFETY_CONCERN',
      note: 'Selling restricted items.',
    },
    { ...headers, ...key() },
  );

  check(
    'a shop can be suspended',
    suspendedShop.status === 200,
    suspendedShop.body?.error ?? suspendedShop.status,
  );
  check(
    'and the state is on the row the portal reads back',
    suspendedShop.body?.data?.status === 'SUSPENDED',
    suspendedShop.body?.data?.status,
  );

  // The whole point of the state. Until §5.7's Decision nothing on the member side read
  // `complianceState`, so staff could suspend a shop and it kept selling — a state called
  // SUSPENDED that leaves the shop trading is worse than not having one, because staff believe
  // they have acted.
  const shopper = await makeUser('content-shopper');
  const browse = await api(shopper.token, 'GET', '/commerce/stores?perPage=100');
  const itemsGrid = await api(shopper.token, 'GET', '/commerce/items?perPage=100');

  check(
    'a suspended shop is out of browse',
    !(browse.body?.data ?? []).some(row => row.id === anyStore?.id),
    { suspended: anyStore?.id, listed: (browse.body?.data ?? []).length },
  );

  const itemsOfSuspended = await prisma.storeItem.findMany({
    where: { storeId: anyStore?.id, deletedAt: null },
    select: { id: true },
  });

  check(
    'and so are its items, which nobody could buy anyway',
    !(itemsGrid.body?.data ?? []).some(row => itemsOfSuspended.some(item => item.id === row.id)),
    { itemsInShop: itemsOfSuspended.length, gridSize: (itemsGrid.body?.data ?? []).length },
  );

  const sameAgain = await api(
    null,
    'PATCH',
    `/admin/content/stores/${anyStore?.id}/compliance`,
    { complianceState: 'SUSPENDED', reasonCode: 'SAFETY_CONCERN', note: 'Again.' },
    { ...headers, ...key() },
  );

  check('setting it to what it already is is a 409', sameAgain.status === 409, sameAgain.status);

  await api(
    null,
    'PATCH',
    `/admin/content/stores/${anyStore?.id}/compliance`,
    { complianceState: 'ACTIVE', reasonCode: 'CORRECTION', note: 'Reverting for the suite.' },
    { ...headers, ...key() },
  );

  // ── 12. The guard stack ──────────────────────────────────────────────────
  heading('12. the guard stack');

  const noToken = await api(null, 'GET', '/admin/content/requests');

  check('no token, no content', noToken.status === 401, noToken.status);

  // Support **does** hold `content:read`, by design: answering "why was my post removed" means
  // being able to look at the post. What they do not hold is `content:moderate`, which is what the
  // hide/remove/restore actions sit behind. Asserted as a grant rather than a refusal, because the
  // first version of this check assumed the opposite and would have had me "fixing" the role.
  const asSupport = await api(null, 'GET', '/admin/content/requests', null, adminHeaders(support));

  check(
    'support can read content, because answering a member about a post means seeing it',
    asSupport.status === 200,
    asSupport.status || asSupport.body?.error,
  );

  const permissions = await prisma.permission.findMany({
    where: { code: { in: ['content:read', 'content:moderate'] } },
    select: {
      code: true,
      rolePermissions: { select: { role: { select: { code: true } } } },
    },
  });
  const holders = Object.fromEntries(
    permissions.map(row => [row.code, row.rolePermissions.map(entry => entry.role.code).sort()]),
  );

  check(
    'and the two content permissions are held by the roles §4.13 says',
    JSON.stringify(holders['content:read']) ===
      JSON.stringify(['manager', 'super_admin', 'support', 'trust_safety']) &&
      JSON.stringify(holders['content:moderate']) ===
        JSON.stringify(['manager', 'super_admin', 'trust_safety']),
    holders,
  );

  await prisma.contentSafety.deleteMany({
    where: { targetType: 'UPDATE', targetId: { in: [postId, unscannedId] } },
  });
  await sweep('admin-content');
  await finish();
}

main().catch(fail);
