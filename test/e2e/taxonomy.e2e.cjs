/* The vocabulary the app renders, and the promise that its codes are the codes the API takes.
 *
 * The client used to compile these lists in, send display labels where codes belonged, and pick a
 * feed filter by its position in a hardcoded row. Every check here is about the same thing: a chip
 * the app shows is a code some endpoint accepts, and nothing here is declared and then left empty. */
const { api, check, finish, makeUser, prisma, sweep } = require('./harness.cjs');
const jwt = require('jsonwebtoken');

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4000/api/v1';

const codes = list => (list ?? []).map(term => term.code);

/** A staff account that may edit the vocabulary, which is what the admin portal will be. */
async function makeAdmin(tag) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'super_admin' } });
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const user = await prisma.user.create({
    data: {
      firstName: 'E2E', lastName: tag, email: `e2e-${tag}-${stamp}@example.test`,
      username: `e2e_${tag}_${stamp}`, status: 'ACTIVE', isStaff: true,
      userRole: { create: { roleId: role.id } },
      profile: { create: { cityId: 'MANCHESTER' } },
      sessions: {
        create: {
          userAgent: 'e2e', deviceType: 'cli', browserName: 'cli', operatingSystem: 'cli',
          ipAddress: '127.0.0.1', isActive: true, deviceFingerprint: `e2e-${tag}-${stamp}`,
        },
      },
    },
    include: { sessions: true },
  });

  return {
    id: user.id,
    token: jwt.sign({ sub: user.id, sid: user.sessions[0].id }, process.env.JWT_ACCESS_SECRET, {
      expiresIn: '1h',
    }),
  };
}

(async () => {
  await sweep('taxonomy');

  const member = await makeUser('tax');

  let r = await api(member.token, 'GET', '/taxonomy');
  const tax = r.body?.data ?? {};
  check('taxonomy → 200', r.status === 200, r.status);

  console.log('\n── Nothing declared and left empty ──────────────────────────');

  const lists = Object.entries(tax).filter(([, value]) => Array.isArray(value));
  check('every list carries terms', lists.every(([, value]) => value.length > 0),
    lists.filter(([, value]) => !value.length).map(([key]) => key));
  check('and there are enough of them to be the whole vocabulary', lists.length >= 28, lists.length);

  const shaped = lists.filter(([key]) => key !== 'cities');
  check('every term is a code, a label, a sort and an active flag',
    shaped.every(([, value]) => value.every(t =>
      typeof t.code === 'string' && typeof t.label === 'string' &&
      typeof t.sort === 'number' && typeof t.isActive === 'boolean')),
    shaped.filter(([, value]) => value.some(t => typeof t.code !== 'string')).map(([key]) => key));
  check('no label leaked into a code field',
    shaped.every(([, value]) => value.every(t => /^[A-Z][A-Z0-9_]*$/.test(t.code) || t.code.length === 2)),
    shaped.flatMap(([key, value]) => value.filter(t => !/^[A-Z][A-Z0-9_]*$/.test(t.code) && t.code.length !== 2).map(t => key + ':' + t.code)).slice(0, 5));

  console.log('\n── The bounds that stop the client parsing a label ──────────');

  check('every age band carries its own minAge',
    (tax.connectAgeBands ?? []).every(b => typeof b.minAge === 'number'), tax.connectAgeBands);
  check('and a maxAge, null on the open-ended one',
    (tax.connectAgeBands ?? []).every(b => b.maxAge === null || typeof b.maxAge === 'number'), tax.connectAgeBands);
  check('every price band carries minPence',
    (tax.itemPriceBands ?? []).every(b => typeof b.minPence === 'number'), tax.itemPriceBands);
  check('and maxPence, null on the open-ended one',
    (tax.itemPriceBands ?? []).every(b => b.maxPence === null || typeof b.maxPence === 'number'), tax.itemPriceBands);

  console.log('\n── The codes are codes the endpoints accept ─────────────────');

  for (const code of codes(tax.feedTypes)) {
    r = await api(member.token, 'GET', `/community/feed?types=${code}&limit=1`);
    check(`feed accepts ${code}`, r.status === 200, { status: r.status, error: r.body?.error });
  }

  for (const code of codes(tax.requestStatuses)) {
    r = await api(member.token, 'GET', `/community/requests?status=${code}&limit=1`);
    check(`request list accepts ${code}`, r.status === 200, { status: r.status, error: r.body?.error });
  }

  for (const code of codes(tax.professionalSortOptions)) {
    r = await api(member.token, 'GET', `/professionals?sort=${code}&limit=1`);
    check(`professionals browse accepts ${code}`, r.status === 200, { status: r.status, error: r.body?.error });
  }

  for (const code of codes(tax.commerceSortOptions)) {
    r = await api(member.token, 'GET', `/commerce/items?sort=${code}&limit=1`);
    check(`marketplace accepts ${code}`, r.status === 200, { status: r.status, error: r.body?.error });
  }

  r = await api(member.token, 'GET', `/commerce/items?categories=${codes(tax.itemCategories)[0]}&limit=1`);
  check('and a category code filters rather than being ignored', r.status === 200, r.body?.error);

  // Today an unrecognised code is a filter that matches nothing rather than a refusal. Pinned as
  // it stands, because whether it should be a 422 is a decision, not an oversight.
  r = await api(member.token, 'GET', '/commerce/items?categories=Food %26 groceries&limit=1');
  check('a label where a code belongs matches nothing, quietly',
    r.status === 200 && (r.body?.data ?? []).length === 0, { status: r.status, items: (r.body?.data ?? []).length });

  console.log('\n── One call per launch, usually a 304 ──────────────────────');

  const head = await fetch(`${BASE}/taxonomy`);
  const etag = head.headers.get('etag');
  check('served with an ETag', !!etag, etag);
  check('and an hour of cache', /max-age=3600/.test(head.headers.get('cache-control') ?? ''),
    head.headers.get('cache-control'));
  check('the ETag is the version, so neither can move without the other',
    etag === `"${tax.version}"`, { etag, version: tax.version });

  const again = await fetch(`${BASE}/taxonomy`, { headers: { 'If-None-Match': etag } });
  check('an unchanged catalogue is a 304', again.status === 304, again.status);

  const size = (await head.text()).length;
  check('and the whole vocabulary is one small payload', size > 10_000 && size < 200_000, size + ' bytes');

  console.log('\n── A reworded label does not move a code ───────────────────');

  // Through the admin API rather than the database, because that is the portal's path and it is
  // the write that clears every process's cache.
  const admin = await makeAdmin('taxadm');
  const term = (tax.itemCategories ?? []).find(t => t.isActive);

  r = await api(admin.token, 'POST', '/admin/taxonomy', {
    kind: 'ITEM_CATEGORY', code: term.code, label: 'Renamed for a moment', sort: term.sort,
  });
  check('an admin can reword a label', r.status === 200, r.body?.error);

  r = await api(member.token, 'GET', '/taxonomy');
  const after = r.body?.data;
  const renamed = (after?.itemCategories ?? []).find(t => t.code === term.code);
  check('the label moves', renamed?.label === 'Renamed for a moment', renamed);
  check('the code does not', renamed?.code === term.code, renamed?.code);
  check('and the version changes with it, so a client can tell a real change from a no-op',
    after?.version !== tax.version, { before: tax.version, after: after?.version });

  r = await api(member.token, 'GET', '/taxonomy');
  check('while a second read of the same catalogue does not move it',
    r.body?.data?.version === after?.version, r.body?.data?.version);

  r = await api(admin.token, 'DELETE', `/admin/taxonomy/ITEM_CATEGORY/${term.code}`);
  check('retiring a term → 200', r.status === 200, r.body?.error);

  r = await api(member.token, 'GET', '/taxonomy');
  const retiredNow = (r.body?.data?.itemCategories ?? []).find(t => t.code === term.code);
  check('a retired term is still sent, not removed', !!retiredNow, r.body?.data?.itemCategories?.map(t => t.code));
  check('marked inactive, so the picker stops offering it', retiredNow?.isActive === false, retiredNow);
  check('with its label intact, so six months of records still read',
    retiredNow?.label === 'Renamed for a moment', retiredNow?.label);

  // Put it back the way it was.
  await api(admin.token, 'POST', '/admin/taxonomy', {
    kind: 'ITEM_CATEGORY', code: term.code, label: term.label, sort: term.sort, isActive: true,
  });

  r = await api(member.token, 'GET', '/taxonomy');
  const restored = (r.body?.data?.itemCategories ?? []).find(t => t.code === term.code);
  check('and it can be turned back on', restored?.isActive === true && restored?.label === term.label, restored);

  console.log('\n── A withdrawn term is still sent, so old records read ─────');

  const retired = (tax.itemCategories ?? []).filter(t => !t.isActive);
  check('the seeded vocabulary already carries withdrawn terms', retired.length > 0,
    (tax.itemCategories ?? []).map(t => t.code + '=' + t.isActive));
  check('each with a label, so content filed under it still reads',
    retired.every(t => typeof t.label === 'string' && t.label.length > 0), retired);

  await sweep('taxonomy');
  await finish();
})().catch(async error => {
  console.error(error);
  process.exit(1);
});
