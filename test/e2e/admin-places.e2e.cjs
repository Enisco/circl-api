/**
 * §5.20 — cities, and the numbers the platform hands somebody in trouble.
 *
 * Two small CRUD surfaces, and the suite is almost entirely about their two rules: a city id is
 * never renamed because every piece of content references it, and a support line's "last checked"
 * date moves only when somebody says so — because that line is what tells a member in crisis
 * whether these numbers are current.
 */
const {
  adminHeaders,
  api,
  check,
  clearRateLimits,
  fail,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const key = () => ({ 'Idempotency-Key': `pl-${Math.random().toString(36).slice(2)}` });

const register = async (label, codes) => {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const permissions = await prisma.permission.findMany({ where: { code: { in: codes } } });

  if (permissions.length !== codes.length) throw new Error(`role ${label}: unknown permission(s)`);

  const role = await prisma.role.create({
    data: {
      name: `E2E places ${label} ${stamp}`,
      code: `e2e-pl-${label}-${stamp}`,
      isSystem: false,
      isAdmin: true,
      rolePermissions: { create: permissions.map(permission => ({ permissionId: permission.id })) },
    },
  });

  return role.code;
};

const CITY_ID = 'E2E_TESTVILLE';

async function main() {
  await sweep('pre-run');
  await clearRateLimits();
  await prisma.city.deleteMany({ where: { id: CITY_ID } });
  await prisma.supportResource.deleteMany({ where: { name: { startsWith: 'E2E ' } } });

  const keeperRole = await register('keeper', ['config:read', 'config:taxonomy']);
  const readerRole = await register('reader', ['config:read']);

  const keeper = await makeAdmin('pl-keeper', keeperRole);
  const reader = await makeAdmin('pl-reader', readerRole);
  const asKeeper = adminHeaders(keeper);
  const asReader = adminHeaders(reader);

  // ── 1. Cities ─────────────────────────────────────────────────────────────
  heading('1. the city list, and what is in each one');

  const list = await api(null, 'GET', '/admin/cities', null, asReader);
  const london = (list.body?.data ?? []).find(row => row.id === 'LONDON');

  check('the list answers', list.status === 200, list.status || list.body?.error);
  check(
    'with the two numbers that decide whether a city can be switched off',
    typeof london?.memberCount === 'number' && typeof london?.contentCount === 'number',
    london,
  );

  const searched = await api(null, 'GET', '/admin/cities?q=milton+keynes', null, asReader);

  check(
    'and `q` matches the name as a person would type it, not the id',
    (searched.body?.data ?? []).some(row => row.id === 'MILTON_KEYNES'),
    (searched.body?.data ?? []).map(row => row.id),
  );

  const refused = await api(
    null,
    'POST',
    '/admin/cities',
    { id: CITY_ID, name: 'Testville' },
    { ...asReader, ...key() },
  );

  check('config:read cannot add one → 403', refused.status === 403, refused.status);

  const created = await api(
    null,
    'POST',
    '/admin/cities',
    { id: 'e2e_testville', name: 'Testville', region: 'Test Shire', timezone: 'Europe/London' },
    { ...asKeeper, ...key() },
  );

  check('a city is added', created.status === 201, created.status || created.body?.error);
  check(
    'and the id is upper-cased for us, because that is the form every reference takes',
    created.body?.data?.id === CITY_ID,
    created.body?.data?.id,
  );

  const twice = await api(
    null,
    'POST',
    '/admin/cities',
    { id: CITY_ID, name: 'Testville again' },
    { ...asKeeper, ...key() },
  );

  check(
    'adding it twice is a 409 **carrying the city**, so it can be switched back on instead',
    twice.status === 409 && twice.body?.data?.city?.id === CITY_ID,
    { status: twice.status, data: twice.body?.data },
  );

  const badId = await api(
    null,
    'POST',
    '/admin/cities',
    { id: 'not a city id!', name: 'Nope' },
    { ...asKeeper, ...key() },
  );

  check('an id that is not UPPER_SNAKE is refused', badId.status === 400, badId.status);

  const renamed = await api(
    null,
    'PATCH',
    `/admin/cities/${CITY_ID}`,
    { name: 'Testville-on-Sea' },
    { ...asKeeper, ...key() },
  );

  check('the name is a label and may be changed', renamed.status === 200, renamed.body?.error);
  check(
    'and the change is visible immediately, not after the cache expires',
    (await api(null, 'GET', `/admin/cities?q=${CITY_ID}`, null, asReader)).body?.data?.[0]?.name ===
      'Testville-on-Sea',
    true,
  );

  // The city cache is what the member-facing API resolves names from, so it has to see it too.
  const member = await makeUser('pl-member');
  const catalogue = await api(member.token, 'GET', '/taxonomy');
  const inCatalogue = (catalogue.body?.data?.cities ?? []).find(row => row.id === CITY_ID);

  check(
    'a new city reaches the member catalogue the app renders pickers from',
    !!inCatalogue && inCatalogue.name === 'Testville-on-Sea',
    inCatalogue,
  );

  const deactivated = await api(
    null,
    'PATCH',
    `/admin/cities/${CITY_ID}`,
    { isActive: false },
    { ...asKeeper, ...key() },
  );

  check('a city can be taken out of the pickers', deactivated.status === 200, deactivated.status);

  const afterOff = await api(member.token, 'GET', '/taxonomy');

  check(
    'and it leaves the member catalogue',
    !(afterOff.body?.data?.cities ?? []).some(row => row.id === CITY_ID),
    (afterOff.body?.data?.cities ?? []).length,
  );

  const cityTrail = await prisma.auditLog.findFirst({
    where: { action: 'city.updated', targetId: CITY_ID },
    orderBy: { occurredAt: 'desc' },
  });

  check(
    'every change is audited with before and after',
    cityTrail?.before?.isActive === true && cityTrail?.after?.isActive === false,
    { before: cityTrail?.before, after: cityTrail?.after },
  );

  // ── 2. Support resources ──────────────────────────────────────────────────
  heading('2. the lines a member in trouble is given');

  const nothingToDo = await api(
    null,
    'POST',
    '/admin/support-resources',
    { name: 'E2E Nothing', isCrisis: false },
    { ...asKeeper, ...key() },
  );

  check(
    'a line with no number and no link is refused: a name alone is no use to anybody',
    nothingToDo.status === 422,
    { status: nothingToDo.status, code: nothingToDo.body?.error?.code },
  );

  const added = await api(
    null,
    'POST',
    '/admin/support-resources',
    {
      name: 'E2E Crisis Line',
      phone: '0800 000 000',
      description: 'Someone to talk to, any time.',
      hours: '24 hours, every day',
      isCrisis: true,
      sort: 1,
    },
    { ...asKeeper, ...key() },
  );
  const resourceId = added.body?.data?.id;

  check('a crisis line is added', added.status === 201 && !!resourceId, added.body?.error);
  check(
    'with today as the date it was last verified',
    (added.body?.data?.lastCheckedAt ?? '').slice(0, 10) === new Date().toISOString().slice(0, 10),
    added.body?.data?.lastCheckedAt,
  );

  const reachable = await api(member.token, 'GET', '/guard/resources');

  check(
    'and the member sees it the moment it is added',
    (reachable.body?.data ?? []).some(row => row.name === 'E2E Crisis Line'),
    (reachable.body?.data ?? []).map(row => row.name),
  );
  check(
    'crisis lines first, as the app renders them',
    (reachable.body?.data ?? [])[0]?.isCrisis === true,
    (reachable.body?.data ?? []).slice(0, 3).map(row => [row.name, row.isCrisis]),
  );

  const checkedBefore = added.body?.data?.lastCheckedAt;

  // Backdate it, so "did an edit move it" is a question with a visible answer.
  await prisma.supportResource.update({
    where: { id: resourceId },
    data: { lastCheckedAt: new Date(Date.now() - 90 * 86_400_000) },
  });

  const edited = await api(
    null,
    'PATCH',
    `/admin/support-resources/${resourceId}`,
    { hours: '24 hours, 365 days' },
    { ...asKeeper, ...key() },
  );

  check('an ordinary edit lands', edited.status === 200, edited.body?.error);
  check(
    'and does NOT claim the number was re-verified: that date is for a member in crisis to trust',
    edited.body?.data?.lastCheckedAt !== checkedBefore &&
      new Date(edited.body?.data?.lastCheckedAt).getTime() < Date.now() - 60 * 86_400_000,
    edited.body?.data?.lastCheckedAt,
  );

  const verified = await api(
    null,
    'PATCH',
    `/admin/support-resources/${resourceId}`,
    { lastCheckedAt: 'now' },
    { ...asKeeper, ...key() },
  );

  check(
    'marking it checked is a deliberate act, and moves the date',
    (verified.body?.data?.lastCheckedAt ?? '').slice(0, 10) ===
      new Date().toISOString().slice(0, 10),
    verified.body?.data?.lastCheckedAt,
  );

  const emptied = await api(
    null,
    'PATCH',
    `/admin/support-resources/${resourceId}`,
    { phone: '' },
    { ...asKeeper, ...key() },
  );

  check(
    'and an active line cannot have its last contact detail removed',
    emptied.status === 422,
    emptied.status,
  );

  const readded = await api(
    null,
    'POST',
    '/admin/support-resources',
    { name: 'E2E Crisis Line', phone: '0800 000 001', isCrisis: true },
    { ...asKeeper, ...key() },
  );

  check(
    'adding a name that exists edits it rather than making a second row',
    readded.status === 201 && readded.body?.data?.id === resourceId,
    { id: readded.body?.data?.id, expected: resourceId },
  );

  const removed = await api(
    null,
    'DELETE',
    `/admin/support-resources/${resourceId}`,
    null,
    asKeeper,
  );

  check('a line can be taken off the list', removed.status === 200, removed.status);
  check(
    'which deactivates rather than deletes',
    removed.body?.data?.isActive === false,
    removed.body?.data,
  );

  const afterRemoval = await api(member.token, 'GET', '/guard/resources');

  check(
    'and the member stops seeing it',
    !(afterRemoval.body?.data ?? []).some(row => row.name === 'E2E Crisis Line'),
    (afterRemoval.body?.data ?? []).map(row => row.name),
  );

  const stillThere = await prisma.supportResource.findUnique({ where: { id: resourceId } });

  check(
    'the row stays, so the trail still names what was removed',
    !!stillThere,
    stillThere?.isActive,
  );

  await prisma.supportResource.deleteMany({ where: { name: { startsWith: 'E2E ' } } });
  await prisma.city.deleteMany({ where: { id: CITY_ID } });
  await prisma.role.deleteMany({ where: { code: { startsWith: 'e2e-pl-' } } });
  await sweep('admin-places');
  await finish();
}

main().catch(fail);
