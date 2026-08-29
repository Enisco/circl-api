/* The user record (spec 0.16).
 *
 * Three endpoints referenced from every section. The parts worth checking hard
 * are the ones that leak if they are wrong: an explicit `null` avatar must clear
 * rather than be ignored, and a visitor's activity counts must be built from what
 * that visitor can see, because a count that disagrees with the list tells them
 * exactly how many anonymous posts exist and roughly when. */
const { api, check, finish, makeUser, prisma, sweep } = require('./harness.cjs');

(async () => {
  await sweep();
  const owner = await makeUser('rec');
  const visitor = await makeUser('vis');

  console.log('\n── 0.16.2 PATCH /users/profile ──────────────────────────────');
  let r = await api(owner.token, 'PATCH', '/users/profile', { bio: 'Moved over in 2023.' });
  check('partial patch → 200', r.status === 200, { s: r.status, b: r.body });
  check('returns the updated record, not null', r.body?.data?.id === owner.id, r.body?.data);

  r = await api(owner.token, 'PATCH', '/users/profile', { lastName: null });
  check('lastName accepts an explicit null', r.status === 200, { s: r.status, b: r.body?.error });
  let row = await prisma.user.findUnique({ where: { id: owner.id }, select: { lastName: true } });
  check('lastName cleared in the database', row.lastName === null, row);

  r = await api(owner.token, 'GET', '/users/profile');
  check('display name survives a null last name',
    r.status === 200 && !JSON.stringify(r.body).includes('null null'), r.status);

  r = await api(owner.token, 'PATCH', '/users/profile', { canHelpWith: 'x'.repeat(301) });
  check('canHelpWith over 300 rejected', r.status === 400, r.status);

  r = await api(owner.token, 'PATCH', '/users/profile', { phoneNumber: '123456' });
  check('phoneNumber under 7 digits rejected', r.status === 400, r.status);

  // 1.0.3 reaches this endpoint too: the Edit Profile picker sends a name.
  r = await api(owner.token, 'PATCH', '/users/profile', { cityId: 'Manchester' });
  check('cityId accepts a picked name', r.status === 200, { s: r.status, b: r.body?.error });
  const prof = await prisma.userProfile.findUnique({ where: { userId: owner.id }, select: { cityId: true } });
  check('city stored as the resolved id', prof.cityId === 'MANCHESTER', prof);

  r = await api(owner.token, 'PATCH', '/users/profile', { cityId: 'Atlantis' });
  check('an unknown city → 422, never a 500', r.status === 422, r.status);

  console.log('\n── 0.16.2 avatarKey ─────────────────────────────────────────');
  const up = await api(owner.token, 'POST', '/media/uploads',
    { purpose: 'AVATAR', files: [{ mimeType: 'image/jpeg', byteSize: 4096 }] });
  const key = up.body?.data?.[0]?.key;
  check('avatar upload minted under the avatar prefix', key?.includes('/avatar'), key);

  r = await api(owner.token, 'PATCH', '/users/profile', { avatarKey: key });
  check('setting an avatar → 200', r.status === 200, { s: r.status, b: r.body?.error });
  check('profile returns a signed avatarUrl', typeof r.body?.data?.avatarUrl === 'string', r.body?.data?.avatarUrl);
  check('the raw key is not exposed', !('avatarKey' in (r.body?.data ?? {})), Object.keys(r.body?.data ?? {}));

  r = await api(owner.token, 'PATCH', '/users/profile', { bio: 'Unrelated edit.' });
  check('omitting avatarKey leaves the photo alone', typeof r.body?.data?.avatarUrl === 'string', r.body?.data?.avatarUrl);

  r = await api(owner.token, 'PATCH', '/users/profile', { avatarKey: null });
  check('an explicit null clears the photo', r.body?.data?.avatarUrl === null, r.body?.data?.avatarUrl);
  row = await prisma.user.findUnique({ where: { id: owner.id }, select: { avatarKey: true } });
  check('avatarKey cleared in the database', row.avatarKey === null, row);

  const stolen = await api(visitor.token, 'PATCH', '/users/profile', { avatarKey: key });
  check("another member's avatar key is refused", stolen.status === 422, stolen.status);

  console.log('\n── 0.16.3 GET /users/{id}/profile ───────────────────────────');
  r = await api(owner.token, 'GET', '/users/me/profile');
  check('`me` resolves to the caller', r.status === 200 && r.body?.data?.user?.id === owner.id, r.status);
  check('viewer.isOwner true for the owner', r.body?.data?.viewer?.isOwner === true, r.body?.data?.viewer);
  check('carries a rating summary', typeof r.body?.data?.rating?.average === 'number', r.body?.data?.rating);
  check('carries memberSince', typeof r.body?.data?.memberSince === 'string', r.body?.data?.memberSince);

  await api(owner.token, 'PATCH', '/users/profile', { canHelpWith: 'CV reviews, Airport runs' });
  r = await api(visitor.token, 'GET', `/users/${owner.id}/profile`);
  check('a visitor can read it', r.status === 200, r.status);
  check('viewer.isOwner false for a visitor', r.body?.data?.viewer?.isOwner === false, r.body?.data?.viewer);
  check('canHelpWith comes back as chips',
    JSON.stringify(r.body?.data?.canHelpWith) === '["CV reviews","Airport runs"]', r.body?.data?.canHelpWith);
  check('no conversation yet', r.body?.data?.viewer?.conversationId === null, r.body?.data?.viewer);

  r = await api(owner.token, 'GET', '/users/00000000-0000-0000-0000-000000000000/profile');
  check('an unknown member → 404', r.status === 404, r.status);

  console.log('\n── 0.16.5 / 0.16.6 activity ─────────────────────────────────');
  const mk = (title, visibility) => api(owner.token, 'POST', '/community/requests',
    { categoryCode: 'ACCOMMODATION', title, cityId: 'MANCHESTER', visibility });
  await mk('Public request one', 'PUBLIC');
  await mk('Public request two', 'PUBLIC');
  const anon = await mk('Anonymous request', 'ANONYMOUS');
  check('the fixtures were created', anon.status === 201, anon.status);

  // PRIVATE_TO_CIRCL is not a post: the public composer refuses it and the client routes to Guard instead (1.9).
  const refused = await mk('Private to Circl', 'PRIVATE_TO_CIRCL');
  check('the public composer refuses PRIVATE_TO_CIRCL',
    refused.status === 422 && refused.body?.error?.code === 'USE_PRIVATE_ENDPOINT',
    { s: refused.status, c: refused.body?.error?.code });

  const guard = await api(owner.token, 'POST', '/guard/threads',
    { subject: 'Something private', message: 'I would rather this were not public.' },
    { 'Idempotency-Key': `e2e-guard-${Date.now()}` });
  check('a private thread was opened', guard.status === 201, { s: guard.status, b: guard.body });

  await api(owner.token, 'POST', '/community/updates', { content: 'An update from the owner.' });

  const mine = await api(owner.token, 'GET', '/users/me/activity');
  check('owner activity → 200', mine.status === 200, { s: mine.status, b: mine.body });
  const mineIds = (mine.body?.data ?? []).map(i => i.id);
  check('the owner sees their own anonymous post', mineIds.includes(anon.body?.data?.id), mineIds.length);
  check('anonymous rows are flagged for the owner',
    mine.body?.data?.some(i => i.isAnonymous === true), mine.body?.data?.map(i => i.isAnonymous));
  check('a Guard thread never appears, even for the owner',
    !mineIds.includes(guard.body?.data?.id), mineIds);
  check('ordered newest first', (() => {
    const dates = (mine.body?.data ?? []).map(i => Date.parse(i.createdAt));
    return dates.every((d, i) => i === 0 || dates[i - 1] >= d);
  })(), mine.body?.data?.map(i => i.createdAt));
  check('rows carry a server-owned route',
    mine.body?.data?.every(i => typeof i.route === 'string' && i.route.startsWith('/')), mine.body?.data?.[0]);
  check('a request row carries a status with a label',
    mine.body?.data?.find(i => i.type === 'REQUEST')?.status?.label === 'Open',
    mine.body?.data?.find(i => i.type === 'REQUEST')?.status);
  check('an update row carries no status',
    mine.body?.data?.find(i => i.type === 'UPDATE')?.status === null,
    mine.body?.data?.find(i => i.type === 'UPDATE'));
  check('meta.byType counts the owner\'s requests', mine.body?.meta?.byType?.REQUEST === 3, mine.body?.meta?.byType);
  check('meta.byType omits types with no rows',
    !('GUIDE' in (mine.body?.meta?.byType ?? {})), mine.body?.meta?.byType);

  const theirs = await api(visitor.token, 'GET', `/users/${owner.id}/activity`);
  const theirIds = (theirs.body?.data ?? []).map(i => i.id);
  check('a visitor never receives the anonymous row', !theirIds.includes(anon.body?.data?.id), theirIds);
  check('a visitor never receives a Guard thread', !theirIds.includes(guard.body?.data?.id), theirIds);
  check('a visitor gets no isAnonymous field at all',
    (theirs.body?.data ?? []).every(i => !('isAnonymous' in i)), theirs.body?.data?.[0]);
  check('byType is computed from what the VISITOR sees, not the table',
    theirs.body?.meta?.byType?.REQUEST === 2, theirs.body?.meta?.byType);
  check('totalCount is the visitor\'s too',
    theirs.body?.meta?.totalCount === theirIds.length, theirs.body?.meta);

  const filtered = await api(owner.token, 'GET', '/users/me/activity?type=UPDATE');
  check('the type filter narrows the list',
    (filtered.body?.data ?? []).every(i => i.type === 'UPDATE'), filtered.body?.data?.map(i => i.type));
  check('a bad type is rejected',
    (await api(owner.token, 'GET', '/users/me/activity?type=NONSENSE')).status === 400);

  const paged = await api(owner.token, 'GET', '/users/me/activity?limit=2&page=2');
  check('paging works across the union',
    paged.status === 200 && (paged.body?.data ?? []).length <= 2, paged.body?.meta);

  await sweep();
  await finish();
})();
