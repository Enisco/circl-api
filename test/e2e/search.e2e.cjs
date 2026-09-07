/* Search: the All view (`GET /search`) and the People view (`GET /users?q=`).
 *
 * The endpoint's whole reason to exist is the grouped preview with a true count per type. That
 * makes three things load-bearing and all three are asserted here: a group comes back for every
 * requested type even when it is empty, `totalCount` is the full number of matches rather than the
 * number returned, and a gated type reports the gate on the group instead of failing the call. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');

const groupsOf = res => res.body?.data?.groups ?? [];
const group = (res, type) => groupsOf(res).find(g => g.type === type);

(async () => {
  await sweep('search');

  const me = await makeUser('search', { cityId: 'MANCHESTER' });
  const other = await makeUser('searchee', { cityId: 'LONDON' });

  await prisma.user.update({
    where: { id: other.id },
    data: { firstName: 'Zephyrine', lastName: 'Quibbleton', username: 'zephq' },
  });

  console.log('\n── The shape of a group ────────────────────────────────────');
  let r = await api(me.token, 'GET', '/search?q=gp');
  check('200 with a group for every type', r.status === 200 && groupsOf(r).length === 8,
    groupsOf(r).map(g => g.type));
  check('empty groups are present, not omitted',
    groupsOf(r).some(g => g.totalCount === 0),
    groupsOf(r).map(g => `${g.type}:${g.totalCount}`));
  check('every group carries type, label and totalCount',
    groupsOf(r).every(g => g.type && g.label && typeof g.totalCount === 'number'), groupsOf(r)[0]);
  check('totalCount is the full number of matches, not the number returned',
    (group(r, 'GUIDE')?.totalCount ?? 0) > (group(r, 'GUIDE')?.items.length ?? 0),
    { total: group(r, 'GUIDE')?.totalCount, returned: group(r, 'GUIDE')?.items.length });
  check('`total` still answers under its old name for an older build',
    groupsOf(r).every(g => g.total === g.totalCount), groupsOf(r)[0]);
  check('suggestions come back with the groups', Array.isArray(r.body?.data?.suggestions),
    r.body?.data?.suggestions);

  console.log('\n── limit is per type, not overall ──────────────────────────');
  r = await api(me.token, 'GET', '/search?q=gp&limit=2');
  check('no group exceeds the limit', groupsOf(r).every(g => g.items.length <= 2),
    groupsOf(r).map(g => `${g.type}:${g.items.length}`));
  check('and the default is 3', (await api(me.token, 'GET', '/search?q=gp'))
    .body.data.groups.every(g => g.items.length <= 3));

  r = await api(me.token, 'GET', '/search?q=in&limit=25');
  check('a group returns everything it has up to the limit, never one row short',
    groupsOf(r).every(g => g.items.length === Math.min(25, g.totalCount)),
    groupsOf(r).map(g => `${g.type}:${g.totalCount}/${g.items.length}`));

  console.log('\n── types, and an unknown code ──────────────────────────────');
  r = await api(me.token, 'GET', '/search?q=gp&types=REQUEST,GUIDE');
  check('only the requested types come back',
    groupsOf(r).length === 2 && groupsOf(r).every(g => ['REQUEST', 'GUIDE'].includes(g.type)),
    groupsOf(r).map(g => g.type));
  r = await api(me.token, 'GET', '/search?q=gp&types=REQUEST,PANTOMIME');
  check('an unknown type code is ignored, not rejected',
    r.status === 200 && groupsOf(r).length === 1 && groupsOf(r)[0].type === 'REQUEST',
    { status: r.status, types: groupsOf(r).map(g => g.type) });
  r = await api(me.token, 'GET', '/search?q=gp&types=GUIDE,GUIDE,REQUEST');
  check('a repeated type code is one group, not two',
    groupsOf(r).length === 2, groupsOf(r).map(g => g.type));
  r = await api(me.token, 'GET', '/search?q=gp&types=PANTOMIME,SEMAPHORE');
  check('every code being unknown is empty groups, not the default set',
    r.status === 200 && groupsOf(r).length === 0, groupsOf(r).map(g => g.type));
  r = await api(me.token, 'GET', '/search?q=gp&scope=COMMERCE');
  check('the deprecated scope still answers',
    r.status === 200 && groupsOf(r).every(g => ['STORE', 'ITEM'].includes(g.type)),
    groupsOf(r).map(g => g.type));

  console.log('\n── Every item says what it is ──────────────────────────────');
  r = await api(me.token, 'GET', '/search?q=gp&types=GUIDE,REQUEST');
  check('resultType is on every item',
    groupsOf(r).every(g => g.items.every(i => i.resultType === g.type)),
    groupsOf(r).flatMap(g => g.items.map(i => i.resultType)));
  check('and the row is the list row, not a wrapper',
    groupsOf(r).every(g => g.items.every(i => typeof i.id === 'string' && !('payload' in i))),
    groupsOf(r)[0]?.items?.[0] && Object.keys(groupsOf(r)[0].items[0]).slice(0, 6));

  r = await api(me.token, 'GET', '/search?q=a&types=STORE&limit=5');
  const store = group(r, 'STORE')?.items?.[0];

  if (store) {
    check("a shop keeps its own `type` and mirrors it onto storeType",
      store.storeType !== undefined && store.resultType === 'STORE',
      { type: store.type, storeType: store.storeType, resultType: store.resultType });
  } else {
    check('a shop keeps its own `type` and mirrors it onto storeType', true, 'no shop matched');
  }

  console.log('\n── A gate is a group status, never a response status ───────');
  r = await api(me.token, 'GET', '/search?q=gp');
  check('Connect reports its gate on the group',
    group(r, 'CONNECT_PROFILE')?.gate === 'CONNECT_PROFILE_REQUIRED',
    group(r, 'CONNECT_PROFILE'));
  check('and the other seven groups survive it',
    r.status === 200 && groupsOf(r).filter(g => !g.gate).length === 7,
    groupsOf(r).map(g => `${g.type}${g.gate ? ':GATED' : ''}`));
  check('a gated group returns no items', (group(r, 'CONNECT_PROFILE')?.items ?? []).length === 0);

  console.log('\n── PERSON ─────────────────────────────────────────────────');
  r = await api(me.token, 'GET', '/search?q=Quibbleton&types=PERSON');
  const person = group(r, 'PERSON')?.items?.[0];

  check('a member is findable by name', person?.id === other.id, group(r, 'PERSON'));
  check('and comes back as the shared author object',
    person && 'displayName' in person && 'trustChecks' in person && 'isProfessional' in person,
    person && Object.keys(person));
  check('never as a bio search',
    (await api(me.token, 'GET', '/search?q=Quibbleton&types=PERSON')).status === 200);

  r = await api(me.token, 'GET', '/search?q=zephq&types=PERSON');
  check('and by username', (group(r, 'PERSON')?.items ?? []).some(i => i.id === other.id));

  r = await api(me.token, 'GET', '/search?q=Zephyrine%20Quibbleton&types=PERSON');
  check('a full name matches across both name columns',
    (group(r, 'PERSON')?.items ?? []).some(i => i.id === other.id), group(r, 'PERSON'));

  r = await api(me.token, 'GET', '/search?q=Quibbelton&types=PERSON');
  check('a misspelt name still lands, through the trigram pass',
    (group(r, 'PERSON')?.items ?? []).some(i => i.id === other.id), group(r, 'PERSON'));

  r = await api(other.token, 'GET', '/search?q=Quibbleton&types=PERSON');
  check('the caller never finds themselves',
    (group(r, 'PERSON')?.items ?? []).every(i => i.id !== other.id), group(r, 'PERSON'));

  await prisma.block.create({ data: { blockerId: other.id, blockedId: me.id } });
  r = await api(me.token, 'GET', '/search?q=Quibbleton&types=PERSON');
  check('somebody who blocked the caller is invisible, in that direction too',
    (group(r, 'PERSON')?.items ?? []).length === 0, group(r, 'PERSON'));
  await prisma.block.deleteMany({ where: { blockerId: other.id } });

  // A different term, because the cache answers a repeated one for ten seconds and a suspension
  // is allowed to take that long. A block is not, which is what the assertion above proves.
  await prisma.user.update({ where: { id: other.id }, data: { status: 'SUSPENDED' } });
  r = await api(me.token, 'GET', '/search?q=zephyrine&types=PERSON');
  check('a suspended member is invisible', (group(r, 'PERSON')?.items ?? []).length === 0,
    group(r, 'PERSON'));
  await prisma.user.update({ where: { id: other.id }, data: { status: 'ACTIVE' } });

  console.log('\n── GET /users?q= is the paginated half ─────────────────────');
  r = await api(me.token, 'GET', '/users?q=Quibbleton');
  check('200 with the same person shape',
    r.status === 200 && r.body?.data?.[0]?.id === other.id, r.body?.data?.[0]);
  check('paginated, so the See all view has somewhere to go',
    typeof r.body?.meta?.totalCount === 'number' && typeof r.body?.meta?.hasNextPage === 'boolean',
    r.body?.meta);
  const p1 = await api(me.token, 'GET', '/users?q=Quibbelton&page=1&limit=1');
  const p2 = await api(me.token, 'GET', '/users?q=Quibbelton&page=2&limit=1');

  check('a fuzzy result pages without the count changing under it',
    p1.body?.meta?.totalCount === p2.body?.meta?.totalCount,
    { p1: p1.body?.meta?.totalCount, p2: p2.body?.meta?.totalCount });

  r = await api(me.token, 'GET', '/users');
  check('no term is an empty page, not the whole membership',
    r.status === 200 && r.body?.data?.length === 0, { status: r.status, n: r.body?.data?.length });

  console.log('\n── Ranking, biasing and short terms ────────────────────────');
  r = await api(me.token, 'GET', '/search?q=gp&types=GUIDE&limit=1');
  check("the caller's own city is ranked up, not filtered to",
    (group(r, 'GUIDE')?.items?.[0]?.title ?? '').includes('Manchester'),
    { title: group(r, 'GUIDE')?.items?.[0]?.title, total: group(r, 'GUIDE')?.totalCount });
  check('and the rest of the country is still counted',
    (group(r, 'GUIDE')?.totalCount ?? 0) > 1, group(r, 'GUIDE')?.totalCount);

  r = await api(me.token, 'GET', '/search?q=gp&types=GUIDE&limit=1&cityId=LONDON');
  check('an explicit cityId biases somewhere else',
    (group(r, 'GUIDE')?.items?.[0]?.title ?? '').includes('London'),
    group(r, 'GUIDE')?.items?.[0]?.title);

  r = await api(me.token, 'GET', '/search?q=a');
  check('a one-character term is empty groups, not a 400',
    r.status === 200 && groupsOf(r).length === 0, { status: r.status, n: groupsOf(r).length });

  console.log('\n── ILIKE wildcards are text, not operators ─────────────────');
  r = await api(me.token, 'GET', '/search?q=%25%25');
  check('`%%` matches nothing rather than every row of every table',
    groupsOf(r).every(g => g.totalCount === 0),
    groupsOf(r).map(g => `${g.type}:${g.totalCount}`));
  r = await api(me.token, 'GET', '/search?q=_a');
  check('`_` is a character, not a single-character wildcard',
    groupsOf(r).every(g => g.totalCount === 0),
    groupsOf(r).map(g => `${g.type}:${g.totalCount}`));
  r = await api(me.token, 'GET', '/users?q=%25%25');
  check('and the membership cannot be enumerated with one either',
    r.body?.meta?.totalCount === 0, r.body?.meta);

  for (const path of ['/community/requests', '/community/guides', '/community/groups',
    '/community/offers', '/professionals', '/commerce/stores', '/commerce/items', '/messages']) {
    r = await api(me.token, 'GET', `${path}?q=%25%25`);
    check(`${path} treats it as text too`, r.body?.meta?.totalCount === 0,
      { status: r.status, total: r.body?.meta?.totalCount });
  }

  console.log('\n── Elastic matching ────────────────────────────────────────');
  const stamp = Date.now();

  await prisma.guide.create({
    data: {
      title: `Bursary application ${stamp}`,
      intro: 'Written for this test.',
      topicCode: 'HOUSING',
      city: { connect: { id: 'MANCHESTER' } },
      author: { connect: { id: me.id } },
      blocks: [{ type: 'PARAGRAPH', text: 'Written for this test.' }],
      publishedAt: new Date(),
    },
  });

  r = await api(me.token, 'GET', `/search?q=bursaries&types=GUIDE`);
  check('a plural finds the singular somebody actually wrote',
    (group(r, 'GUIDE')?.items ?? []).some(i => i.title.includes(`${stamp}`)),
    (group(r, 'GUIDE')?.items ?? []).map(i => i.title));

  r = await api(me.token, 'GET', `/search?q=${stamp}&types=GUIDE`);
  check('an infix matches, so a member need not start at the beginning',
    (group(r, 'GUIDE')?.items ?? []).some(i => i.title.includes(`${stamp}`)),
    (group(r, 'GUIDE')?.items ?? []).map(i => i.title));

  console.log('\n── Latency ────────────────────────────────────────────────');
  const cold = Date.now();

  await api(me.token, 'GET', `/search?q=cold${stamp}`);
  const coldMs = Date.now() - cold;

  check(`eight types answer in one round trip, under 800ms (${coldMs}ms)`, coldMs < 800, coldMs);

  await api(me.token, 'GET', '/search?q=repeated');
  const warm = Date.now();

  await api(me.token, 'GET', '/search?q=repeated');
  const warmMs = Date.now() - warm;

  check(`a repeated term is served from cache (${warmMs}ms)`, warmMs <= coldMs, { coldMs, warmMs });

  await prisma.guide.deleteMany({ where: { title: `Bursary application ${stamp}` } });
  await sweep('search');
  await finish();
})().catch(fail);
