/* City resolution (spec 1.0.3).
 *
 * The shipped client has no city ids: its pickers are lists of names, and each
 * screen passes the chosen name into the parameter the contract calls `cityId`.
 * Onboarding manufactures an upper-snake code from the same label. All of it has
 * to resolve, and what gets STORED has to be the real id. */
const { api, makeUser, check, finish, sweep, prisma } = require('./harness.cjs');

(async () => {
  await sweep();
  const u = await makeUser('city');

  // 1.0.3: the value decides, not the parameter name.
  for (const [label, value] of [
    ['exact id', 'MANCHESTER'],
    ['picked name', 'Manchester'],
    ['lowercase name', 'manchester'],
    ['device-made code from a multi-word label', 'NEWCASTLE_UPON_TYNE'],
    ['multi-word picked name', 'Newcastle upon Tyne'],
    ['hyphenated', 'milton-keynes'],
  ]) {
    const r = await api(u.token, 'GET', `/community/requests?cityId=${encodeURIComponent(value)}`);
    check(`list resolves ${label} ("${value}")`, r.status === 200, { status: r.status, body: r.body });
  }

  const bad = await api(u.token, 'GET', '/community/requests?cityId=Atlantis');
  check('unknown city still lists (filter simply misses)', bad.status === 200, bad.status);

  // A composer must persist the resolved id, not the name it was handed.
  const created = await api(u.token, 'POST', '/community/requests', {
    categoryCode: 'ACCOMMODATION', title: 'City resolution check', cityId: 'Manchester',
  });
  check('create accepts a picked name', created.status === 201, { s: created.status, b: created.body });

  if (created.status === 201) {
    const row = await prisma.communityRequest.findUnique({
      where: { id: created.body.data.id }, select: { cityId: true },
    });
    check('create stored the resolved id, not the name', row.cityId === 'MANCHESTER', row);
    check('response echoes the city object so the client learns the id',
      created.body.data.city?.id === 'MANCHESTER', created.body.data.city);
  }

  const rejected = await api(u.token, 'POST', '/community/requests', {
    categoryCode: 'ACCOMMODATION', title: 'Bad city', cityId: 'Atlantis',
  });
  check('create rejects a genuinely unknown city with 422', rejected.status === 422, rejected.status);

  // The deprecated `city` parameter, and cityId winning when both arrive.
  const dep = await api(u.token, 'GET', '/community/requests?city=Manchester');
  check('deprecated `city` still resolves', dep.status === 200, dep.status);

  await sweep();
  finish();
})();
