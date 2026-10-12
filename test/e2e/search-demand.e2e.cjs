/* The published lists of what members are searching for (6.3).
 *
 * Every check here is about one of two promises. The first is that a number on the screen is a
 * number somebody produced: the floor counts different people and not searches, anything shaped
 * like somebody's own business is dropped, and no list is served without the window it covers. The
 * second is that a fragment is resolved from what the platform already holds rather than guessed —
 * which is the whole reason there is no model in this path. */
const { api, check, finish, makeUser, prisma, sweep } = require('./harness.cjs');

const SECTION = 'SEARCH_DEMAND';

/** Searches, as the recorder writes them, spread over the window the job reads. */
async function searched(term, scope, cityId, { members, searches, misses = 0, week = 'this' }) {
  const people = [];

  for (let index = 0; index < members; index += 1) {
    people.push((await makeUser(`demand-${index}-${Date.now() % 100000}`)).id);
  }

  const base = week === 'this' ? 4 : 180;

  for (let index = 0; index < searches; index += 1) {
    await prisma.activityEvent.create({
      data: {
        userId: people[index % members],
        verb: 'SEARCH',
        subject: 'SEARCH_TERM',
        scope,
        cityId,
        term,
        hadResults: index >= misses,
        occurredAt: new Date(Date.now() - (base + index * 3) * 3_600_000),
      },
    });
  }

  return people;
}

/** Unique, and deliberately digit-free: a term carrying a number is dropped by design, which is
 *  tested on its own below rather than smuggled into every other assertion. */
const unique = () =>
  Array.from(
    { length: 6 },
    () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)],
  ).join('');

const rowFor = (list, term) =>
  (list ?? []).find(row => row.term.toLowerCase() === term.toLowerCase());

(async () => {
  await sweep('demand');

  const viewer = await makeUser('demand-viewer');
  const staff = await prisma.user.findFirst({ where: { isStaff: true }, select: { id: true } });

  console.log('\nThe filters above the list');

  let r = await api(viewer.token, 'GET', '/pulse/search-demand');
  check('a member may read it with no arguments at all', r.status === 200, r.status);
  check(
    'and gets the nationwide list at the shallowest depth',
    r.body?.data?.filter === 'ALL' && r.body?.data?.cityId === null && r.body?.data?.limit === 10,
    r.body?.data,
  );
  check(
    'with the three lists the spec names',
    ['top', 'unmet', 'rising'].every(key => Array.isArray(r.body?.data?.[key])),
    Object.keys(r.body?.data ?? {}),
  );

  for (const filter of ['COMMUNITY', 'GUIDES', 'REQUESTS', 'PROFESSIONALS', 'PRODUCTS']) {
    r = await api(viewer.token, 'GET', `/pulse/search-demand?filter=${filter}`);
    check(
      `${filter} is one of them`,
      r.status === 200 && r.body?.data?.filter === filter,
      r.status,
    );
  }

  r = await api(viewer.token, 'GET', '/pulse/search-demand?filter=CONNECT');
  check(
    'Connect is not: searching for a person is not demand data',
    r.status === 400 && /filter/.test(JSON.stringify(r.body)),
    r.body?.error?.message,
  );

  r = await api(viewer.token, 'GET', '/pulse/search-demand?limit=37');
  check(
    'a depth that is not offered is refused by name rather than quietly changed',
    r.status === 400 && /limit/.test(JSON.stringify(r.body)),
    r.body?.error?.message,
  );

  r = await api(viewer.token, 'GET', '/pulse/search-demand?limit=50&filter=products');
  check(
    'but the filter may be sent in either case',
    r.status === 200 && r.body?.data?.filter === 'PRODUCTS',
    r.body?.data?.filter,
  );

  r = await api(viewer.token, 'GET', '/pulse/search-demand?scope=PRODUCTS');
  check(
    'and an invented argument is refused by name',
    r.status === 400 && /scope/.test(JSON.stringify(r.body)),
    r.body?.error?.message,
  );

  console.log('\nRarity, which is the part an aggregate does not cover');

  const city = 'SHEFFIELD';
  const rare = `eex rare solicitor ${unique()}`;
  const common = `eex tomato puree ${unique()}`;

  // One person, searched often enough to clear any floor counted in searches.
  await searched(rare, 'PROFESSIONALS', city, { members: 1, searches: 9 });
  await searched(common, 'PRODUCTS', city, { members: 6, searches: 18, misses: 11 });
  await searched(common, 'PRODUCTS', city, { members: 6, searches: 5, week: 'last' });

  r = await api(viewer.token, 'POST', '/admin/jobs/intelligence.search-demand/run');
  // 401 rather than 403 now: a member token is not an admin token at all, so it is refused at
  // authentication rather than at authorisation. It used to be accepted and then checked for a
  // permission, which is why a member with a staff role reached admin routes (B1).
  check('a member cannot force the rebuild', r.status === 401, r.status);

  const {
    SearchDemandService,
  } = require('../../dist/src/modules/platform/intelligence/services/search-demand.service');
  const {
    TaxonomyService,
  } = require('../../dist/src/modules/platform/shared/services/taxonomy.service');
  const service = new SearchDemandService(prisma, new TaxonomyService(prisma));

  await service.rebuild();

  r = await api(
    viewer.token,
    'GET',
    `/pulse/search-demand?filter=PRODUCTS&cityId=${city}&limit=50`,
  );
  const products = r.body?.data;

  console.log('  — no number without the date it covers —');
  check(
    'every list carries its window and when it was built',
    products?.window?.start && products?.window?.end && products?.updatedAt,
    products?.window,
  );
  check(
    'and the window is the week the spec asks for',
    Math.round((new Date(products.window.end) - new Date(products.window.start)) / 86_400_000) ===
      7,
    products?.window,
  );

  check(
    'a term six people searched is published',
    rowFor(products?.top, common),
    products?.top?.slice(0, 3),
  );
  check(
    'and found nothing, so it ranks on the unmet list',
    rowFor(products?.unmet, common),
    products?.unmet?.slice(0, 3),
  );
  check(
    'which reports the real total and the misses apart',
    rowFor(products?.unmet, common)?.searches === 18 &&
      rowFor(products?.unmet, common)?.misses === 11,
    rowFor(products?.unmet, common),
  );
  check(
    'it rose against the week before, so it is on the rising list too',
    rowFor(products?.rising, common),
    products?.rising?.slice(0, 3),
  );

  r = await api(
    viewer.token,
    'GET',
    `/pulse/search-demand?filter=PROFESSIONALS&cityId=${city}&limit=50`,
  );
  const pros = r.body?.data;
  check(
    'but one person searching nine times is never published, however high the count',
    !rowFor(pros?.top, rare) && !rowFor(pros?.unmet, rare) && !rowFor(pros?.rising, rare),
    pros?.top,
  );

  const kept = await prisma.searchTermCanonical.findFirst({
    where: { normalised: { contains: 'rare solicitor' } },
  });
  check(
    'though it is still resolved and remembered, so it costs nothing next week',
    kept !== null,
    kept,
  );

  console.log('\nShapes that are somebody else’s business');

  const phone = `eex plumber 07700900${Math.floor(Math.random() * 900 + 100)}`; // a number, on purpose

  await searched(phone, 'PROFESSIONALS', city, { members: 7, searches: 21 });
  await service.rebuild();

  r = await api(
    viewer.token,
    'GET',
    `/pulse/search-demand?filter=PROFESSIONALS&cityId=${city}&limit=50`,
  );
  check(
    'a term carrying a number is dropped whatever the counts say',
    !rowFor(r.body?.data?.top, phone),
    r.body?.data?.top,
  );

  console.log('\nA fragment is completed from what we hold, not guessed');

  const store = await prisma.store.findFirst({ where: { deletedAt: null }, select: { id: true } });
  const item = await prisma.storeItem.create({
    data: {
      storeId: store.id,
      name: 'Eex zobo hibiscus drink',
      description: 'Seeded by the search-demand suite.',
      categoryCode: 'DRINKS',
      unitCode: 'EACH',
      price: 350,
      availability: 'ON_SALE',
    },
  });

  await searched('eex zobo', 'PRODUCTS', city, { members: 6, searches: 14 });
  await service.rebuild();

  const resolved = await prisma.searchTermCanonical.findUnique({
    where: { normalised_scope: { normalised: 'eex zobo', scope: 'PRODUCTS' } },
  });
  check(
    'a fragment resolves to the name of something real',
    resolved?.canonical === item.name,
    resolved,
  );
  check(
    'from our own content and not from a model',
    resolved?.source === 'CONTENT',
    resolved?.source,
  );
  check(
    'and carries its category, which is what makes the row tappable',
    resolved?.categoryCode === 'DRINKS',
    resolved?.categoryCode,
  );

  r = await api(
    viewer.token,
    'GET',
    `/pulse/search-demand?filter=PRODUCTS&cityId=${city}&limit=50`,
  );
  check(
    'so the list shows the thing wanted rather than the keystrokes',
    rowFor(r.body?.data?.top, item.name),
    r.body?.data?.top?.slice(0, 3),
  );

  console.log('\nA verdict that depended on the catalogue is retried');

  await searched('qp', 'PRODUCTS', city, { members: 6, searches: 12 });
  await service.rebuild();

  let junk = await prisma.searchTermCanonical.findUnique({
    where: { normalised_scope: { normalised: 'qp', scope: 'PRODUCTS' } },
  });
  check('a fragment nothing completes is junk and is not published', junk?.source === 'JUNK', junk);

  r = await api(
    viewer.token,
    'GET',
    `/pulse/search-demand?filter=PRODUCTS&cityId=${city}&limit=50`,
  );
  check('so it never reaches the screen', !rowFor(r.body?.data?.top, 'Qp'), r.body?.data?.top);

  await prisma.storeItem.update({ where: { id: item.id }, data: { name: 'Qp pepper sauce' } });
  await service.rebuild();

  junk = await prisma.searchTermCanonical.findUnique({
    where: { normalised_scope: { normalised: 'qp', scope: 'PRODUCTS' } },
  });
  check(
    'but once somebody lists it, the same fragment stops being junk',
    junk?.source === 'CONTENT' && junk?.canonical === 'Qp pepper sauce',
    junk,
  );

  console.log('\nNothing is replaced: a later search adds to the term it belongs to');

  const before = rowFor(
    (await api(viewer.token, 'GET', `/pulse/search-demand?filter=PRODUCTS&cityId=${city}&limit=50`))
      .body?.data?.top,
    'Qp pepper sauce',
  );

  await searched('qp', 'PRODUCTS', city, { members: 6, searches: 7 });
  await service.rebuild();

  const after = rowFor(
    (await api(viewer.token, 'GET', `/pulse/search-demand?filter=PRODUCTS&cityId=${city}&limit=50`))
      .body?.data?.top,
    'Qp pepper sauce',
  );
  check(
    'the count goes up rather than the row being rewritten',
    after && before && after.searches === before.searches + 7,
    { before: before?.searches, after: after?.searches },
  );

  console.log('\nThe cap, and what happens past it');

  const capped = await prisma.metricSnapshot.findMany({
    where: { section: SECTION, metric: { endsWith: '.top' } },
    select: { metric: true, items: true },
  });
  check(
    'no list is stored longer than the deepest depth offered',
    capped.every(row => (row.items ?? []).length <= 50),
    capped.map(row => (row.items ?? []).length),
  );

  console.log('\nA list whose searches have all aged out');

  await prisma.metricSnapshot.updateMany({
    where: { section: SECTION, cityId: 'BRISTOL' },
    data: { windowStart: new Date(Date.now() - 90 * 86_400_000) },
  });
  await prisma.metricSnapshot.create({
    data: {
      section: SECTION,
      metric: 'ALL.top',
      cityId: 'BRISTOL',
      period: 'WEEK',
      items: [{ term: 'stale', code: null, searches: 99, misses: 0, members: 9 }],
      windowStart: new Date(Date.now() - 90 * 86_400_000),
      windowEnd: new Date(Date.now() - 83 * 86_400_000),
    },
  });
  await service.rebuild();

  r = await api(viewer.token, 'GET', '/pulse/search-demand?filter=ALL&cityId=BRISTOL');
  check(
    'is cleared rather than served as this week’s',
    (r.body?.data?.top ?? []).length === 0 && r.body?.data?.window === null,
    r.body?.data,
  );

  await prisma.storeItem.delete({ where: { id: item.id } });
  await prisma.activityEvent.deleteMany({
    where: { cityId: city, OR: [{ term: { startsWith: 'eex ' } }, { term: 'qp' }] },
  });
  await prisma.searchTermCanonical.deleteMany({
    where: { OR: [{ normalised: { startsWith: 'eex ' } }, { normalised: 'qp' }] },
  });
  await service.rebuild();

  await sweep('demand');
  await finish();
})().catch(async error => {
  console.error(error);
  process.exit(1);
});
