/**
 * §13.2 — what a suspension does to the content the member published.
 *
 * A suspension used to stop somebody signing in and leave every post, guide, review, listing and
 * shop of theirs exactly where it was. So a suspension issued *for* harmful content left the
 * content up, which is the gap this closes.
 *
 * Two properties matter more than any single surface:
 *
 *  - the content goes **and comes back**, because the filter is on the author's status rather than
 *    on the item. §13.2 is explicit about that: rewriting `visibilityState` would destroy the
 *    state each item was already in and reactivation would have to guess which was which.
 *  - a **null** author is not a suspended one. `Guide.authorId` is null for the guides Circl
 *    writes, and a relation filter that does not allow for that hides every one of them.
 *
 * This file grows as the remaining read paths are filtered; `author-status-coverage.spec.ts` is
 * what says which are still outstanding.
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

async function main() {
  await sweep('pre-run');

  const staff = await makeAdmin('se-staff', 'trust_safety');
  const headers = adminHeaders(staff);
  const reader = await makeUser('se-reader', { cityId: 'MANCHESTER' });
  const key = prefix => ({ 'Idempotency-Key': `${prefix}-${Math.random().toString(36).slice(2)}` });

  const feed = async () =>
    (await api(reader.token, 'GET', '/community/feed?cityId=MANCHESTER')).body?.data ?? [];

  // ── 1. The feed ───────────────────────────────────────────────────────────
  heading('1. a suspended member leaves the feed, and comes back');

  const before = await feed();

  check('the feed has something in it to reason about', before.length > 0, before.length);

  // Whoever is most present, so the before/after difference is unmistakable. Picking a member and
  // hoping they appear is how a check like this passes while testing nothing.
  const tally = {};

  for (const item of before) {
    if (item.author?.id) tally[item.author.id] = (tally[item.author.id] ?? 0) + 1;
  }

  const [authorId, appearances] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] ?? [];

  check('and an author with several items in it', (appearances ?? 0) >= 2, {
    authorId,
    appearances,
  });

  const suspended = await api(
    null,
    'POST',
    `/admin/members/${authorId}/suspend`,
    { duration: '7d', reasonCode: 'SAFETY_CONCERN', note: 'Testing §13.2.' },
    { ...headers, ...key('se-susp') },
  );

  check(
    'the suspension lands',
    suspended.status === 200,
    suspended.body?.error ?? suspended.status,
  );

  const during = await feed();

  check(
    'every one of their items is out of the feed',
    during.filter(item => item.author?.id === authorId).length === 0,
    during.filter(item => item.author?.id === authorId).map(item => item.id),
  );
  // The feed is still a feed: filtering one author must not empty it.
  check('and the feed still has content in it', during.length > 0, during.length);

  const reactivated = await api(
    null,
    'POST',
    `/admin/members/${authorId}/reactivate`,
    { reasonCode: 'CORRECTION', note: 'Done testing.' },
    { ...headers, ...key('se-react') },
  );

  check(
    'the reactivation lands',
    reactivated.status === 200,
    reactivated.body?.error ?? reactivated.status,
  );

  const after = await feed();

  // The whole point of filtering on the author rather than rewriting the item: nothing had to be
  // restored, because nothing was changed.
  check(
    'and their content is back without anything having been rewritten',
    after.filter(item => item.author?.id === authorId).length === appearances,
    {
      beforeSuspension: appearances,
      afterReactivation: after.filter(item => item.author?.id === authorId).length,
    },
  );

  const states = await prisma.communityUpdate.groupBy({
    by: ['visibilityState'],
    where: { authorId, deletedAt: null },
    _count: { _all: true },
  });

  check(
    'their items never left VISIBLE, because the suspension did not touch them',
    states.every(row => row.visibilityState === 'VISIBLE'),
    states.map(row => [row.visibilityState, row._count._all]),
  );

  // ── 2. The guide Circl wrote ──────────────────────────────────────────────
  heading('2. a null author is not a suspended one');

  const editor = await makeAdmin('se-editor', 'manager');
  const topic = await prisma.taxonomyTerm.findFirst({
    where: { kind: 'GUIDE_TOPIC', isActive: true },
    select: { code: true },
  });

  const written = await api(
    null,
    'POST',
    '/admin/guides',
    {
      topicCode: topic?.code,
      title: 'A guide Circl wrote, with nobody as its author',
      intro:
        'It exists to prove that an absent author is not read as a suspended one, which would ' +
        'hide every staff-written guide on the platform.',
      blocks: [{ type: 'PARAGRAPH', text: 'The content does not matter. Its authorship does.' }],
    },
    { ...adminHeaders(editor), ...key('se-guide') },
  );
  const guideId = written.body?.data?.id;

  check('a Circl guide is written', written.status === 201 && !!guideId, written.body?.error);

  await api(
    null,
    'POST',
    `/admin/guides/${guideId}/publish`,
    {},
    { ...adminHeaders(editor), ...key('se-pub') },
  );

  const row = await prisma.guide.findUnique({
    where: { id: guideId },
    select: { authorId: true, publishedAt: true },
  });

  check(
    'with a null author, which is the case that breaks a naive relation filter',
    row?.authorId === null && !!row?.publishedAt,
    row,
  );

  const listed = await api(reader.token, 'GET', '/community/guides?perPage=100');
  const direct = await api(reader.token, 'GET', `/community/guides/${guideId}`);

  check(
    'it is in the guides list',
    (listed.body?.data ?? []).some(guide => guide.id === guideId),
    { looking: guideId, got: (listed.body?.data ?? []).length },
  );
  check('and readable at its own link', direct.status === 200, direct.status);

  // ── 3. Every other surface ───────────────────────────────────────────────
  heading('3. the same rule on every surface that serves content');

  // A member with content across the platform, suspended once, checked everywhere. The surfaces
  // are listed rather than sampled: the failure mode is eighty-seven of eighty-eight, and a
  // sampled test is how the eighty-eighth survives.
  // Chosen from what the grid is **actually serving**, not from the table. The items grid is
  // capped, so a shop picked by query may own nothing on page one — and then every assertion
  // about its items passes while testing nothing. The feed section above had the same trap.
  const gridItems =
    (await api(reader.token, 'GET', '/commerce/items?perPage=100')).body?.data ?? [];
  const gridItemIds = gridItems.map(row => row.id);
  const onGrid = await prisma.storeItem.findFirst({
    where: {
      id: { in: gridItemIds },
      store: { deletedAt: null, complianceState: 'ACTIVE', owner: { status: 'ACTIVE' } },
    },
    select: { storeId: true },
  });
  const seller = onGrid
    ? await prisma.store.findUnique({
        where: { id: onGrid.storeId },
        select: { id: true, ownerId: true, cityId: true },
      })
    : null;

  check('a shop with something in the live grid', !!seller, { gridSize: gridItems.length });

  const itemIds = (
    await prisma.storeItem.findMany({
      where: { storeId: seller?.id, deletedAt: null },
      select: { id: true },
    })
  ).map(row => row.id);

  const surfaces = async () => ({
    shops: ((await api(reader.token, 'GET', '/commerce/stores?perPage=100')).body?.data ?? []).some(
      row => row.id === seller?.id,
    ),
    items: ((await api(reader.token, 'GET', '/commerce/items?perPage=100')).body?.data ?? []).some(
      row => itemIds.includes(row.id),
    ),
    shelves: (
      (await api(reader.token, 'GET', `/commerce/stores/${seller?.id}/items?perPage=100`)).body
        ?.data ?? []
    ).length,
  });

  const open = await surfaces();

  check(
    'the shop and its items are there to begin with',
    open.shops && open.items && open.shelves > 0,
    open,
  );

  const sellerSuspension = await api(
    null,
    'POST',
    `/admin/members/${seller?.ownerId}/suspend`,
    { duration: '7d', reasonCode: 'SAFETY_CONCERN', note: 'Testing §13.2 across surfaces.' },
    { ...headers, ...key('se-shop') },
  );

  check('the owner is suspended', sellerSuspension.status === 200, sellerSuspension.body?.error);

  const shut = await surfaces();

  check('the shop leaves browse', shut.shops === false, shut);
  check('its items leave the items grid', shut.items === false, shut);
  // There is no separate public shop-detail route — the page is assembled from this read — so if
  // the shelves still answer, the shop is still open for business.
  check(
    'and its shelves are empty, which is what the shop page is built from',
    shut.shelves === 0,
    shut,
  );

  await api(
    null,
    'POST',
    `/admin/members/${seller?.ownerId}/reactivate`,
    { reasonCode: 'CORRECTION', note: 'Done.' },
    { ...headers, ...key('se-shop-re') },
  );

  const reopened = await surfaces();

  check(
    'and all of it comes back on reactivation',
    reopened.shops && reopened.items && reopened.shelves === open.shelves,
    { before: open, after: reopened },
  );

  await prisma.guide.deleteMany({ where: { id: guideId } });
  await sweep('suspension-effects');
  await finish();
}

main().catch(fail);
