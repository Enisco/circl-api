/* The demo dataset (Appendix B).
 *
 * B.8 says the test is the app, and names the things that fail quietly rather
 * than loudly: times that read as months, images that 404 into a placeholder, a
 * city filter that returns nothing because the name did not resolve, dashboards
 * that all say "not enough activity". Each of those looks like a design choice
 * on screen, so each one is asserted here. */
const jwt = require('jsonwebtoken');
const { api, check, finish, prisma } = require('./harness.cjs');

const BASE = 'http://localhost:4000/api/v1';

/** Signs in the way the app does: an email code, no password (B.6). */
async function signIn(email) {
  const res = await fetch(`${BASE}/auth/verify/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code: '1111' }),
  });
  const cookies = res.headers.getSetCookie?.() ?? [];
  const access = cookies.find(c => c.startsWith('accessToken='));

  return { ok: res.status === 200 || res.status === 201, token: access?.split(';')[0].split('=')[1] ?? null };
}

/** Follows a signed media URL and reports whether an object is actually there. */
async function objectExists(url) {
  if (!url) return false;

  const res = await fetch(url, { method: 'GET' });

  return res.status === 200 && Number(res.headers.get('content-length') ?? 0) > 0;
}

(async () => {
  console.log('\n── B.6 getting in ───────────────────────────────────────────');
  const one = await signIn('seed1@circl.test');
  check('member 1 signs in with the documented code', one.ok && !!one.token, one.ok);

  const ten = await signIn('seed10@circl.test');
  check('so does member 10', ten.ok && !!ten.token, ten.ok);

  const nobody = await signIn('seed99@circl.test');
  check('an address that was never seeded does not', !nobody.token, nobody.ok);

  const token = one.token;

  console.log('\n── B.8 the walk ─────────────────────────────────────────────');
  let r = await api(token, 'GET', '/users/profile');
  check('profile loads', r.status === 200, { s: r.status, b: r.body });
  check('it has a bio, a city and a country', (() => {
    const d = r.body?.data ?? {};
    return d.profile?.bio && d.profile?.cityId === 'MANCHESTER' && d.profile?.countryOfOrigin;
  })(), r.body?.data?.profile);
  check('and a signed avatar url', typeof r.body?.data?.avatarUrl === 'string', r.body?.data?.avatarUrl);
  check('the avatar object actually exists', await objectExists(r.body?.data?.avatarUrl),
    r.body?.data?.avatarUrl);

  r = await api(token, 'GET', '/community/requests?cityId=Manchester');
  check('the community feed has content', (r.body?.data ?? []).length > 0, r.body?.meta);
  check('a city filter by NAME returns rows (1.0.3)', (r.body?.data ?? []).length > 0, r.body?.meta?.totalCount);
  check('times read as hours and days, not months', (() => {
    const newest = (r.body?.data ?? [])
      .map(row => Date.parse(row.createdAt))
      .sort((a, b) => b - a)[0];
    return Date.now() - newest < 7 * 86_400_000;
  })(), (r.body?.data ?? [])[0]?.createdAt);

  const anonymous = (r.body?.data ?? []).filter(row => row.author?.isAnonymous);
  check('an anonymous post is in the feed', anonymous.length > 0, anonymous.length);
  check('and it names no author', anonymous.every(row => row.author?.id === null), anonymous[0]?.author);

  const empty = await api(token, 'GET', '/community/requests?cityId=Nottingham');
  check('a city with nothing in it returns an empty list, not an error',
    empty.status === 200, empty.status);

  r = await api(token, 'GET', '/community/guides');
  check('guides have content', (r.body?.data ?? []).length > 0, r.body?.meta?.totalCount);

  r = await api(token, 'GET', '/professionals?cityId=Manchester');
  check('professionals browse returns listings', (r.body?.data ?? []).length > 0, r.body?.meta);
  check('every listing is UNVERIFIED (D13)',
    (r.body?.data ?? []).every(row => row.verificationStatus === 'UNVERIFIED'),
    (r.body?.data ?? []).map(row => row.verificationStatus));

  r = await api(token, 'GET', '/bookings?role=CLIENT');
  check('member 1 has bookings', (r.body?.data ?? []).length > 0, r.body?.meta?.totalCount);
  check('at least one needs their action',
    (r.body?.data ?? []).some(row => row.needsYourAction), (r.body?.data ?? []).map(b => b.state));

  r = await api(token, 'GET', '/commerce/stores?cityId=London');
  check('commerce has stores', (r.body?.data ?? []).length > 0, r.body?.meta);

  r = await api(token, 'GET', '/connect/profiles');
  check('connect discovery returns people', (r.body?.data ?? []).length > 0, r.body?.meta?.totalCount);

  r = await api(token, 'GET', '/messages');
  check('the inbox has threads', (r.body?.data ?? []).length > 0, r.body?.meta);
  check('with a non-zero unread total', (r.body?.meta?.unreadTotal ?? 0) > 0, r.body?.meta);

  console.log('\n── B.4 the badges and the deliberate empties ────────────────');
  r = await api(token, 'GET', '/notifications');
  const rows = r.body?.data ?? [];
  check('notifications are populated', rows.length > 0, rows.length);
  check('the header badge shows a count', (r.body?.meta?.unreadTotal ?? 0) > 0, r.body?.meta);
  check('all three buckets are represented',
    new Set(rows.map(n => n.bucket)).size === 3, [...new Set(rows.map(n => n.bucket))]);
  check('VERIFICATION pins to the top despite being the oldest',
    rows[0]?.kind === 'VERIFICATION', rows.slice(0, 2).map(n => `${n.kind}@${n.createdAt}`));
  check('a row with a null route exists', rows.some(n => n.route === null), rows.map(n => n.route));
  check('several kinds are present', new Set(rows.map(n => n.kind)).size >= 5,
    [...new Set(rows.map(n => n.kind))]);

  r = await api(token, 'GET', '/users/notification-preferences');
  check('the preference matrix is the eight rows',
    (r.body?.data?.categories ?? []).length === 8, r.body?.data?.categories?.length);
  check('with COMPLIANCE locked',
    r.body?.data?.categories?.find(c => c.code === 'COMPLIANCE')?.isLocked === true,
    r.body?.data?.categories?.find(c => c.code === 'COMPLIANCE'));

  r = await api(token, 'GET', '/guard/resources?countryCode=GB');
  check('the resources list has numbers', (r.body?.data ?? []).length > 0, r.body?.data?.length);
  check('with a lastCheckedAt', typeof r.body?.meta?.lastCheckedAt === 'string', r.body?.meta);

  r = await api(token, 'GET', '/messages');
  check('the support thread is pinned to the top of the inbox',
    (r.body?.data ?? [])[0]?.isPinned === true, (r.body?.data ?? [])[0]);

  console.log('\n── B.2.2 every key resolves to an object ────────────────────');
  const store = await api(token, 'GET', '/commerce/stores?cityId=London');
  const storeId = store.body?.data?.[0]?.id;
  const detail = await api(token, 'GET', `/commerce/stores/${storeId}`);
  check('the store has a logo url', typeof detail.body?.data?.logoUrl === 'string', detail.body?.data?.logoUrl);
  check('and the logo object exists', await objectExists(detail.body?.data?.logoUrl),
    detail.body?.data?.logoUrl);

  const items = await api(token, 'GET', `/commerce/stores/${storeId}/items`);
  const photo = (items.body?.data ?? []).flatMap(item => item.photos ?? [])[0];
  check('an item photo exists', await objectExists(photo?.url), photo?.url);
  check('an out-of-stock item is in the catalogue',
    (items.body?.data ?? []).some(item => item.isAvailable === false),
    (items.body?.data ?? []).map(i => i.isAvailable));

  console.log('\n── B.3 the Pulse floors ─────────────────────────────────────');
  // Pulse reads precomputed snapshots, and they are derived state that any suite may legitimately clear.
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'super_admin' } });
  const stamp = Date.now();
  const admin = await prisma.user.create({
    data: {
      firstName: 'E2E', lastName: 'pulse', email: `e2e-pulse-${stamp}@example.test`,
      username: `e2e_pulse_${stamp}`, status: 'ACTIVE', isStaff: true,
      userRole: { create: { roleId: role.id } },
      sessions: { create: { userAgent: 'e2e', deviceType: 'cli', browserName: 'cli',
        operatingSystem: 'cli', ipAddress: '127.0.0.1', isActive: true,
        deviceFingerprint: `e2e-pulse-${stamp}` } },
    },
    include: { sessions: true },
  });
  const adminToken = jwt.sign(
    { sub: admin.id, sid: admin.sessions[0].id },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '1h' },
  );

  const rebuilt = await api(adminToken, 'POST', '/admin/jobs/intelligence.metrics/run');
  check('the Pulse rollup can be rebuilt on demand', rebuilt.status === 200, rebuilt.status);

  const pulses = {};
  for (const scope of ['community', 'professionals', 'commerce', 'connect']) {
    const dash = await api(token, 'GET', `/pulse/${scope}?cityId=Manchester`);
    pulses[scope] = dash.body?.data ?? {};
  }
  check('at least one Manchester dashboard shows numbers',
    Object.values(pulses).some(d => (d.bars ?? []).length > 0),
    Object.fromEntries(Object.entries(pulses).map(([k, v]) => [k, v.contributingMembers])));
  check('Connect clears its floor of 20 too, from the extra profiles',
    (pulses.connect.contributingMembers ?? 0) >= 20, pulses.connect.contributingMembers);
  check('no dashboard names anybody',
    !JSON.stringify(pulses).includes('avatarUrl') && !JSON.stringify(pulses).includes('displayName'),
    'a person appeared in a Pulse payload');

  const thin = await api(token, 'GET', '/pulse/community?cityId=Leeds');
  check('a thin city suppresses, as B.3 intends',
    (thin.body?.data?.bars ?? []).length === 0, thin.body?.data);

  console.log('\n── B.4 the deliberate empty states ──────────────────────────');
  const two = await signIn('seed2@circl.test');
  r = await api(two.token, 'GET', '/users/profile');
  check('member 2 has no avatar, so the initials fallback is visible',
    r.body?.data?.avatarUrl === null, r.body?.data?.avatarUrl);
  check('and no bio', !r.body?.data?.profile?.bio, r.body?.data?.profile?.bio);

  const nine = await signIn('seed9@circl.test');
  r = await api(nine.token, 'GET', '/users/me/profile');
  check('the one-word name renders without a trailing null',
    r.body?.data?.user?.displayName === 'Aiyana', r.body?.data?.user?.displayName);

  await prisma.user.deleteMany({ where: { id: admin.id } });
  await finish();
})();
