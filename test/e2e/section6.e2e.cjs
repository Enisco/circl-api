/* Section 6: notifications, preferences, Guard and Pulse.
 *
 * The parts worth checking hard are the ones with a privacy or safety edge:
 * COMPLIANCE cannot be silenced, Pulse must suppress rather than draw a chart
 * from four people and must never name anybody, and a member's support thread
 * must stay one thread however many times they reach for it. */
const jwt = require('jsonwebtoken');
const {
  adminHeaders,
  api,
  check,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

/** A staff account holding exactly one role's permissions. */

(async () => {
  await sweep();
  const owner = await makeUser('n6a');
  const other = await makeUser('n6b');

  console.log('\n── 6.1.3 the preference matrix ──────────────────────────────');
  let r = await api(owner.token, 'GET', '/users/notification-preferences');
  check('matrix → 200', r.status === 200, { s: r.status, b: r.body });
  const cats = r.body?.data?.categories ?? [];
  // Ten: REACTIONS came with BACKEND-FEED-ACTIONS §3.6, and ACCOUNT with the admin portal's
  // moderation notices (§7.3) — a warning or a suspension has to reach a member who has turned
  // everything else off.
  check('ten rows', cats.length === 10, cats.map(c => c.code));
  check('every row carries a label', cats.every(c => typeof c.label === 'string' && c.label), cats);
  check('rows arrive in the order the screen draws them',
    cats[0]?.code === 'REPLIES' && cats[7]?.code === 'ANNOUNCEMENTS', cats.map(c => c.code));
  check('defaults match the table',
    cats.find(c => c.code === 'GROUPS')?.push === false &&
    cats.find(c => c.code === 'OFFERS')?.email === true, cats);
  // Two locked rows, and both for the same reason: a notice somebody can switch off is not a
  // notice. COMPLIANCE is verification and payments; ACCOUNT is what staff did to them and how to
  // appeal it.
  check('COMPLIANCE and ACCOUNT are the locked rows',
    cats.filter(c => c.isLocked).map(c => c.code).sort().join() === 'ACCOUNT,COMPLIANCE',
    cats.filter(c => c.isLocked));

  r = await api(owner.token, 'PUT', '/users/notification-preferences',
    { categories: [{ code: 'REPLIES', push: false, email: true }] });
  check('a change saves and returns the full matrix',
    r.status === 200 && r.body?.data?.categories?.length === 10, { s: r.status, n: r.body?.data?.categories?.length });
  check('the change is reflected',
    r.body?.data?.categories?.find(c => c.code === 'REPLIES')?.push === false,
    r.body?.data?.categories?.find(c => c.code === 'REPLIES'));

  r = await api(owner.token, 'PUT', '/users/notification-preferences',
    { categories: [{ code: 'COMPLIANCE', push: false, email: false }] });
  check('a locked category is rejected, not silently ignored',
    r.status === 422 && r.body?.error?.code === 'PREFERENCE_LOCKED',
    { s: r.status, c: r.body?.error?.code });
  r = await api(owner.token, 'GET', '/users/notification-preferences');
  check('and COMPLIANCE is still on',
    r.body?.data?.categories?.find(c => c.code === 'COMPLIANCE')?.push === true,
    r.body?.data?.categories?.find(c => c.code === 'COMPLIANCE'));

  r = await api(owner.token, 'PUT', '/users/notification-preferences',
    { categories: [{ code: 'NOT_A_CATEGORY', push: true, email: true }] });
  check('an unknown category is rejected', r.status === 422, r.status);

  console.log('\n── 6.1.1 the list ───────────────────────────────────────────');
  const req = await api(owner.token, 'POST', '/community/requests',
    { categoryCode: 'ACCOMMODATION', title: 'Anyone know a good letting agent?', cityId: 'MANCHESTER' });
  check('a request to be replied to', req.status === 201, req.status);

  await api(other.token, 'POST', `/community/requests/${req.body.data.id}/responses`,
    { content: 'I used one on Oxford Road, they were fine.' });
  await api(other.token, 'POST', `/community/requests/${req.body.data.id}/responses`,
    { content: 'Happy to drive you over there if that helps.', isHelpOffer: true });

  // The raise is fire-and-forget, so give it a moment to land.
  await new Promise(resolve => setTimeout(resolve, 400));

  r = await api(owner.token, 'GET', '/notifications');
  check('list → 200', r.status === 200, { s: r.status, b: r.body });
  const rows = r.body?.data ?? [];
  check('a reply and an offer both landed', rows.length >= 2, rows.map(n => n.kind));
  check('kinds are distinguished',
    rows.some(n => n.kind === 'HELP_OFFER') && rows.some(n => n.kind === 'REPLY'), rows.map(n => n.kind));
  check('bucket is computed server-side', rows.every(n => n.bucket === 'TODAY'), rows.map(n => n.bucket));
  check('route is server-owned', rows.every(n => n.route?.startsWith('/community/request/')), rows[0]?.route);
  check('actor is the shared author object', typeof rows[0]?.actor?.displayName === 'string', rows[0]?.actor);
  check('title and body are already worded',
    rows.every(n => typeof n.title === 'string' && n.title.length > 0), rows.map(n => n.title));
  check('meta.unreadTotal is present', typeof r.body?.meta?.unreadTotal === 'number', r.body?.meta);
  check('unreadTotal matches what arrived', r.body.meta.unreadTotal === rows.length, r.body.meta);

  check('nobody is notified about their own action', (await (async () => {
    const mine = await api(other.token, 'GET', '/notifications');
    return (mine.body?.data ?? []).length === 0;
  })()), 'the replier has notifications');

  r = await api(owner.token, 'GET', '/notifications?unreadOnly=true');
  check('unreadOnly filters', r.status === 200 && r.body.data.length === rows.length, r.status);

  console.log('\n── 6.1.2 / 6.1.4 read, read-all and the badge ───────────────');
  r = await api(owner.token, 'GET', '/notifications/unread-count');
  check('the badge endpoint returns just the integer',
    r.status === 200 && r.body?.data?.unreadTotal === rows.length &&
    !('data' in r.body && Array.isArray(r.body.data)), r.body?.data);

  r = await api(owner.token, 'POST', `/notifications/${rows[0].id}/read`);
  check('read returns the new total in data, not meta',
    r.status === 200 && r.body?.data?.unreadTotal === rows.length - 1 && r.body.meta === undefined,
    { data: r.body?.data, meta: r.body?.meta });

  const stolen = await api(other.token, 'POST', `/notifications/${rows[1].id}/read`);
  const stillUnread = await api(owner.token, 'GET', '/notifications/unread-count');
  check("another member cannot read somebody else's notification",
    stolen.status === 200 && stillUnread.body.data.unreadTotal === rows.length - 1,
    { stolen: stolen.status, total: stillUnread.body.data.unreadTotal });

  r = await api(owner.token, 'POST', '/notifications/read-all');
  check('read-all clears the badge', r.body?.data?.unreadTotal === 0, r.body?.data);

  console.log('\n── 6.3.1 / 6.3.3 Guard ──────────────────────────────────────');
  r = await api(owner.token, 'POST', '/guard/requests',
    { categoryCode: 'HOUSING', body: 'Short' }, { 'Idempotency-Key': `e2e-g1-${Date.now()}` });
  check('a body under 10 characters is rejected', r.status === 400, r.status);

  r = await api(owner.token, 'POST', '/guard/requests',
    { body: 'My landlord has changed the locks while I was at work.' },
    { 'Idempotency-Key': `e2e-g2-${Date.now()}` });
  check('a missing category is rejected', r.status === 400, r.status);

  const first = await api(owner.token, 'POST', '/guard/requests',
    { categoryCode: 'HOUSING', body: 'My landlord has changed the locks while I was at work.' },
    { 'Idempotency-Key': `e2e-g3-${Date.now()}` });
  check('a private request → 201', first.status === 201, { s: first.status, b: first.body });
  check('it returns a conversationId', typeof first.body?.data?.conversationId === 'string', first.body?.data);

  const second = await api(owner.token, 'POST', '/guard/requests',
    { categoryCode: 'MONEY', body: 'Separately, I think I have been underpaid for three months.' },
    { 'Idempotency-Key': `e2e-g4-${Date.now()}` });
  check('D36: a second request continues the same thread',
    second.body?.data?.conversationId === first.body?.data?.conversationId,
    { first: first.body?.data?.conversationId, second: second.body?.data?.conversationId });
  const threads = await prisma.guardThread.count({ where: { userId: owner.id } });
  check('and does not fragment the admin record', threads === 1, threads);

  const inFeed = await api(other.token, 'GET', '/community/requests?cityId=MANCHESTER');
  check('a private request never appears in the feed',
    !JSON.stringify(inFeed.body?.data ?? []).includes('changed the locks'), 'leaked into the feed');

  const activity = await api(owner.token, 'GET', '/users/me/activity');
  check('nor in profile activity, even for its author',
    !JSON.stringify(activity.body?.data ?? []).includes('changed the locks'), 'leaked into activity');

  r = await api(owner.token, 'GET', '/guard/resources?countryCode=GB');
  check('resources → 200', r.status === 200, r.status);
  check('the list is not empty', (r.body?.data ?? []).length > 0, r.body?.data?.length);
  check('crisis rows are listed first', (() => {
    const flags = r.body.data.map(x => x.isCrisis);
    return flags.indexOf(false) === -1 || !flags.slice(flags.indexOf(false)).includes(true);
  })(), r.body?.data?.map(x => x.isCrisis));
  check('rows carry what the client reads',
    r.body.data.every(x => x.name && x.phone && 'hours' in x && 'isCrisis' in x), r.body?.data?.[0]);
  check('meta.lastCheckedAt travels with the list',
    typeof r.body?.meta?.lastCheckedAt === 'string', r.body?.meta);

  r = await api(owner.token, 'GET', '/guard/resources?countryCode=ZZ');
  check('an unknown country returns empty rather than erroring',
    r.status === 200 && Array.isArray(r.body?.data), { s: r.status, d: r.body?.data });

  console.log('\n── 6.2 Pulse ────────────────────────────────────────────────');
  for (const scope of ['community', 'professionals', 'connect', 'commerce']) {
    r = await api(owner.token, 'GET', `/pulse/${scope}?cityId=Manchester`);
    check(`${scope} → 200`, r.status === 200, { s: r.status, b: r.body });
    const d = r.body?.data ?? {};
    check(`${scope} carries the full shape`,
      Array.isArray(d.stats) && Array.isArray(d.bars) && Array.isArray(d.actions) &&
      typeof d.contributingMembers === 'number' &&
      typeof d.barsTitle === 'string' && typeof d.actionsTitle === 'string' &&
      'updatedAt' in d, Object.keys(d));
    check(`${scope} never names anybody`, (() => {
      const text = JSON.stringify(d);
      return !text.includes('avatarUrl') && !text.includes('displayName') &&
             !text.includes('userId') && !text.includes(owner.id);
    })(), 'a person appears in the payload');
    check(`${scope} stat values are strings`,
      d.stats.every(s => typeof s.value === 'string'), d.stats);
    check(`${scope} bars carry their own max`,
      d.bars.every(b => typeof b.max === 'number'), d.bars);
  }

  r = await api(owner.token, 'GET', '/pulse/community?cityId=Manchester');
  check('below the floor it suppresses rather than charting a handful of people',
    r.body.data.contributingMembers < 5
      ? r.body.data.bars.length === 0 && r.body.data.stats.length === 0
      : true,
    r.body.data);
  check('and keeps the real contributingMembers so it is debuggable',
    typeof r.body.data.contributingMembers === 'number', r.body.data.contributingMembers);

  r = await api(owner.token, 'GET', '/pulse/nonsense');
  check('an unknown scope → 404', r.status === 404, r.status);

  r = await api(owner.token, 'GET', '/pulse/community?cityId=Atlantis');
  check('an unresolvable city falls back rather than erroring', r.status === 200, r.status);

  console.log('\n── 6.2.1 above the floor ────────────────────────────────────');
const admin = await makeAdmin('pladm', 'super_admin');
  const fixtureCats = ['ACCOMMODATION', 'JOBS', 'VISA_DOCS', 'BANK_ACCOUNT'];
  const fixtureUsers = [];

  for (let i = 0; i < 6; i++) {
    const u = await makeUser(`pls${i}`);
    fixtureUsers.push(u);
    for (let j = 0; j < 3; j++) {
      await api(u.token, 'POST', '/community/requests', {
        categoryCode: fixtureCats[(i + j) % fixtureCats.length],
        title: `Pulse fixture ${i}-${j}: a question about settling in`,
        cityId: 'MANCHESTER',
      });
    }
  }

  const ran = await api(null, 'POST', '/admin/jobs/intelligence.metrics/run', null, adminHeaders(admin));
  check('an admin can run a job on demand', ran.status === 200, { s: ran.status, b: ran.body });

  const denied = await api(fixtureUsers[0].token, 'POST', '/admin/jobs/intelligence.metrics/run');
  // 401, not 403. A member token is not an admin token, so it fails authentication rather than
  // authorisation — it used to be accepted here and then merely checked for a permission, which is
  // how a member account holding a staff role reached every admin route (B1).
  check('a member cannot', denied.status === 401, denied.status);

  const bad = await api(null, 'POST', '/admin/jobs/not.a.job/run', null, adminHeaders(admin));
  check('an unknown job name → 404', bad.status === 404, bad.status);

  r = await api(fixtureUsers[0].token, 'GET', '/pulse/community?cityId=Manchester');
  const above = r.body?.data ?? {};
  console.log('  contributingMembers:', above.contributingMembers);
  check('the floor is cleared by six contributors', above.contributingMembers >= 5, above.contributingMembers);
  check('above the floor Pulse publishes stats', above.stats.length > 0, above.stats);
  check('and bars', above.bars.length > 0, above.bars);
  check('bars carry a shared max, not a per-slice one',
    new Set(above.bars.map(b => b.max)).size === 1, above.bars);
  check('max is the largest value', above.bars[0]?.max === Math.max(...above.bars.map(b => b.value)), above.bars);
  check('stat values are formatted strings', above.stats.every(s => typeof s.value === 'string'), above.stats);
  check('updatedAt names the period the numbers describe',
    typeof above.updatedAt === 'string', above.updatedAt);
  check('no action row describes a single person',
    above.actions.every(a => !/\b1 (person|people)\b/.test(a.label)), above.actions);
  check('actions carry a server-owned route',
    above.actions.every(a => typeof a.route === 'string' && a.route.startsWith('/')), above.actions);
  check('still names nobody', !JSON.stringify(above).includes(fixtureUsers[0].id), 'a user id leaked');

  console.log('\n── 6.2.1 an action row says what it is about ────────────────');

  // The button opens the section's own search already searching the row's subject, so a row that
  // names a subject the search cannot find sends the member to an empty screen. Followed here
  // rather than assumed: both searches match on substrings, and the row's wording has to be words
  // that something actually contains.
  const sections = {
    community: (row, city) =>
      `/community/requests?q=${encodeURIComponent(row.subject)}&unanswered=true&cityId=${city}` +
      (row.subjectCode ? `&categories=${row.subjectCode}` : ''),
    professionals: (row, city) =>
      `/professionals?q=${encodeURIComponent(row.subject)}&cityId=${city}` +
      (row.subjectCode ? `&category=${row.subjectCode}` : ''),
    commerce: (row, city) => `/commerce/items?q=${encodeURIComponent(row.subject)}&cityId=${city}`,
  };

  for (const [scope, searchFor] of Object.entries(sections)) {
    for (const city of ['MANCHESTER', 'LONDON']) {
      const dash = await api(fixtureUsers[0].token, 'GET', `/pulse/${scope}?cityId=${city}`);
      const rows = dash.body?.data?.actions ?? [];

      check(`${scope}/${city}: every action row carries a subject and a kind`,
        rows.length > 0 && rows.every(a => typeof a.subject === 'string' && a.subject.length > 0
          && (a.kind === 'BROWSE' || a.kind === 'CREATE')),
        rows.map(a => ({ subject: a.subject, kind: a.kind })));

      check(`${scope}/${city}: no subject is a raw code or a filter label`,
        rows.every(a => !/^[A-Z_]+$/.test(a.subject) && !/[/&]/.test(a.subject)),
        rows.map(a => a.subject));

      const empty = [];

      for (const row of rows) {
        const hit = await api(fixtureUsers[0].token, 'GET', searchFor(row, city));

        if (hit.status !== 200 || (hit.body?.data ?? []).length === 0) {
          empty.push({ subject: row.subject, status: hit.status });
        }
      }

      check(`${scope}/${city}: and each one leads to something`, empty.length === 0, empty);
    }
  }

  // The filter the action row's count depends on: "4 unanswered" has to open four, not forty.
  let answered = await api(fixtureUsers[0].token, 'GET', '/community/requests?cityId=MANCHESTER&limit=50');
  const all = (answered.body?.data ?? []).length;
  answered = await api(fixtureUsers[0].token, 'GET', '/community/requests?cityId=MANCHESTER&limit=50&unanswered=true');
  const none = answered.body?.data ?? [];

  check('unanswered=true returns only requests with no reply',
    none.length > 0 && none.every(req => (req.replyCount ?? 0) === 0),
    none.slice(0, 3).map(req => req.replyCount));
  check('and it is a narrower set, not the same one', none.length < all, { all, unanswered: none.length });

  // Connect's floor is 20, so six contributors must NOT publish it. The six are put in Bristol,
  // which the dataset leaves empty on purpose, so this counts exactly them. Against Manchester it
  // was really asserting that nobody else was there, which held only while the city was thin.
  for (const [index, user] of fixtureUsers.entries()) {
    await api(user.token, 'PUT', '/connect/me', {
      typeCode: 'FRIENDSHIP',
      lookingFor: `Pulse fixture ${index}: someone to show me around.`,
      dateOfBirth: '1993-04-02',
      isVisible: true,
      cityIdOverride: 'BRISTOL',
    });
  }

  await api(null, 'POST', '/admin/jobs/intelligence.metrics/run', null, adminHeaders(admin));

  const connect = await api(fixtureUsers[0].token, 'GET', '/pulse/connect?cityId=BRISTOL');
  check('six contributors are counted',
    connect.body?.data?.contributingMembers === 6, connect.body?.data?.contributingMembers);
  check('Connect holds the higher floor (D19)',
    connect.body.data.bars.length === 0 && connect.body.data.stats.length === 0,
    connect.body.data);



  
  await prisma.user.deleteMany({ where: { id: admin.id } });
  await sweep();
  await finish();
})();
