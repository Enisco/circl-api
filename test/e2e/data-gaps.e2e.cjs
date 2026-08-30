/* BACKEND-DATA-GAPS.md, gap by gap.
 *
 * Every check here answers the question that document asks of each screen: where does this value
 * come from? Anything still answered by "a Dart constant" is a failure. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');

const BASE = 'http://localhost:4000/api/v1';

async function signIn(email) {
  const res = await fetch(`${BASE}/auth/verify/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code: '1111' }),
  });
  const body = await res.json().catch(() => ({}));
  const cookies = res.headers.getSetCookie?.() ?? [];

  return {
    status: res.status,
    // Tokens ride in the standard envelope's `data`, like every other response.
    body: body?.data ?? {},
    cookieToken: cookies.find(c => c.startsWith('accessToken='))?.split(';')[0].split('=')[1] ?? null,
  };
}

(async () => {
  await sweep('pre-run');

  console.log('\n── §22 tokens reach a client with no cookie jar ─────────────');
  const one = await signIn('seed1@circl.test');
  check('sign-in returns accessToken in the JSON body', typeof one.body?.accessToken === 'string',
    Object.keys(one.body ?? {}));
  check('and refreshToken', typeof one.body?.refreshToken === 'string');
  check('and sessionId', typeof one.body?.sessionId === 'string');
  check('cookies are still set, for the admin web client', !!one.cookieToken);

  const token = one.body.accessToken;

  console.log('\n── G1 taxonomy ─────────────────────────────────────────────');
  let r = await api(token, 'GET', '/taxonomy');
  const tax = r.body?.data ?? {};
  const KEYS = [
    'cities', 'communityCategories', 'guideTopics', 'professions', 'itemCategories', 'itemUnits',
    'heritageTags', 'journeyStages', 'interests', 'helpTags', 'countriesOfOrigin',
    'itemPriceBands', 'storeTypes', 'storeContactChannels', 'filters',
  ];
  check('the fourteen keys the client parses are all present',
    KEYS.every(key => tax[key] !== undefined), KEYS.filter(key => tax[key] === undefined));

  const NEW_KEYS = [
    'genders', 'managedCategories', 'experienceLevels', 'urgencyOptions', 'storeHelpAreas',
    'privateHelpCategories', 'spokenLanguages', 'connectAgeBands', 'professionalSortOptions',
  ];
  for (const key of NEW_KEYS) {
    check(`${key} is served, not compiled into the app`, (tax[key] ?? []).length > 0, tax[key]);
  }

  check('the limits block carries all four numbers',
    tax.limits?.maxInterests === 8 && tax.limits?.maxLanguages === 6
    && tax.limits?.minConnectAge === 18 && tax.limits?.nearMeRadiusMiles === 5, tax.limits);

  check('connectAgeBands carry bounds, not a label to parse back',
    (tax.connectAgeBands ?? []).every(b => typeof b.minAge === 'number' && 'maxAge' in b),
    tax.connectAgeBands);
  check('and the open-ended band has a null maxAge',
    (tax.connectAgeBands ?? []).some(b => b.maxAge === null), tax.connectAgeBands);

  check('spokenLanguages carry an ISO code alongside the stable one',
    (tax.spokenLanguages ?? []).every(l => typeof l.iso === 'string'),
    (tax.spokenLanguages ?? []).slice(0, 3));

  check('privateHelpCategories keep the codes 6.3.1 fixed',
    ['HOUSING', 'IMMIGRATION', 'SAFETY', 'MONEY', 'HEALTH', 'WORK', 'OTHER']
      .every(code => (tax.privateHelpCategories ?? []).some(t => t.code === code)),
    (tax.privateHelpCategories ?? []).map(t => t.code));
  check('and OTHER reads as "Something else"',
    (tax.privateHelpCategories ?? []).find(t => t.code === 'OTHER')?.label === 'Something else');

  check('inactive terms are served too, so an old post still renders its name',
    (tax.communityCategories ?? []).some(t => t.isActive === false)
    && (tax.itemCategories ?? []).some(t => t.isActive === false),
    { categories: (tax.communityCategories ?? []).filter(t => !t.isActive).length });

  console.log('\n── G17 cityId is an id, not a label ────────────────────────');
  check('cities carry both id and label',
    (tax.cities ?? []).every(c => typeof c.id === 'string' && typeof c.label === 'string'),
    (tax.cities ?? []).slice(0, 2));
  check('the id is the upper-snake form',
    (tax.cities ?? []).find(c => c.label === 'Manchester')?.id === 'MANCHESTER');

  console.log('\n── G3 active sessions ──────────────────────────────────────');
  r = await api(token, 'GET', '/users/me/sessions');
  const sessions = r.body?.data ?? [];
  check('the seeded member has real devices', r.status === 200 && sessions.length >= 2,
    { s: r.status, n: sessions.length });
  check('exactly one is the current device',
    sessions.filter(s => s.isCurrent).length === 1, sessions.map(s => s.isCurrent));
  check('each carries a device label and platform',
    sessions.every(s => s.device && ['IOS', 'ANDROID', 'WEB'].includes(s.platform)),
    sessions.map(s => ({ d: s.device, p: s.platform })));
  check('one is stale by weeks, which is why the screen exists',
    sessions.some(s => Date.now() - new Date(s.lastSeenAt) > 20 * 86400000),
    sessions.map(s => s.lastSeenAt));

  // Revoking is done on a throwaway account: signing the seeded member out everywhere would leave
  // the dataset thinner every time this suite ran.
  const revoker = await makeUser('gapsrevoke');
  for (const label of ['spare-a', 'spare-b']) {
    await prisma.userSession.create({
      data: {
        userId: revoker.id,
        userAgent: 'Circl/1.0 (Pixel 8; Android 15)',
        deviceType: 'mobile',
        browserName: 'Circl',
        operatingSystem: 'Android 15',
        ipAddress: '81.2.69.201',
        isActive: true,
        deviceFingerprint: `gaps-${label}-${Date.now()}`,
      },
    });
  }

  r = await api(revoker.token, 'GET', '/users/me/sessions');
  const own = r.body?.data ?? [];
  check('three devices before revoking', own.length === 3, own.length);

  const current = own.find(s => s.isCurrent);
  r = await api(revoker.token, 'DELETE', `/users/me/sessions/${current.id}`);
  check('the current session cannot be revoked from here',
    r.status === 409 && r.body?.error?.code === 'CANNOT_REVOKE_CURRENT_SESSION',
    { s: r.status, code: r.body?.error?.code });

  const other = own.find(s => !s.isCurrent);
  r = await api(revoker.token, 'DELETE', `/users/me/sessions/${other.id}`);
  check('another device signs out', r.status === 200 && r.body?.data?.revoked === 1, r.body);

  r = await api(revoker.token, 'DELETE', '/users/me/sessions');
  check('and sign out everywhere reports what it actually revoked',
    r.status === 200 && r.body?.data?.revoked === 1, r.body?.data);
  r = await api(revoker.token, 'GET', '/users/me/sessions');
  check('leaving this device signed in', (r.body?.data ?? []).length === 1, r.body?.data?.length);

  console.log('\n── G4 Trust Centre ─────────────────────────────────────────');
  r = await api(token, 'GET', '/verification/status');
  const checks = r.body?.data?.checks ?? [];
  check('all four checks are returned', checks.length === 4, checks.map(c => c.check));
  check('each carries updatedAt and note',
    checks.every(c => 'updatedAt' in c && 'note' in c), checks[0]);
  check('EMAIL is verified', checks.find(c => c.check === 'EMAIL')?.status === 'VERIFIED');
  check('D13: nothing else is VERIFIED, ever',
    checks.filter(c => c.check !== 'EMAIL').every(c => c.status !== 'VERIFIED'),
    checks.map(c => `${c.check}:${c.status}`));

  const three = await signIn('seed3@circl.test');
  r = await api(three.body.accessToken, 'GET', '/verification/status');
  check('one member sits IN_REVIEW so the state is demonstrable',
    (r.body?.data?.checks ?? []).some(c => c.status === 'IN_REVIEW'),
    (r.body?.data?.checks ?? []).map(c => `${c.check}:${c.status}`));

  console.log('\n── G5 booking slots ────────────────────────────────────────');
  const listing = await prisma.professionalListing.findFirst({
    where: { user: { email: 'seed3@circl.test' } },
    select: { id: true },
  });
  r = await api(token, 'GET', `/professionals/listings/${listing.id}/slots`);
  const avail = r.body?.data ?? {};
  check('slots load', r.status === 200, { s: r.status, b: r.body?.error });
  check('with a timezone and the accepting-work flag',
    !!avail.timezone && typeof avail.isAcceptingWork === 'boolean', avail);
  check('two weeks of days, not a fixed six', (avail.days ?? []).length >= 5, avail.days?.length);
  check('each day is server-formatted, so the app holds no date vocabulary',
    (avail.days ?? []).every(d => /^[A-Z][a-z]{2} \d{1,2}$/.test(d.label)),
    (avail.days ?? []).slice(0, 3).map(d => d.label));
  check('an unavailable slot says why rather than being hidden',
    (avail.days ?? []).some(d => d.slots.some(s => !s.isAvailable && s.reason)),
    (avail.days ?? []).flatMap(d => d.slots.filter(s => !s.isAvailable)).slice(0, 3));
  check('at least one is BOOKED',
    (avail.days ?? []).some(d => d.slots.some(s => s.reason === 'BOOKED')),
    (avail.days ?? []).flatMap(d => d.slots.map(s => s.reason)).filter(Boolean));

  const evening = await prisma.professionalListing.findFirst({
    where: { user: { email: 'seed5@circl.test' } },
    select: { id: true },
  });
  const other2 = await api(token, 'GET', `/professionals/listings/${evening.id}/slots`);
  check('a different professional has a different week, not the same grid',
    JSON.stringify(other2.body?.data?.days?.[0]?.slots) !== JSON.stringify(avail.days?.[0]?.slots),
    { a: avail.days?.[0]?.slots?.[0], b: other2.body?.data?.days?.[0]?.slots?.[0] });

  console.log('\n── G6 interests are kept, not discarded ────────────────────');
  r = await api(token, 'GET', '/users/profile');
  check('the profile returns interests', (r.body?.data?.profile?.interests ?? []).length >= 4,
    r.body?.data?.profile?.interests);

  const mine = await makeUser('gaps');
  r = await api(mine.token, 'PATCH', '/users/profile', { interests: ['STUDY', 'TECH', 'MUSIC'] });
  check('PATCH accepts them', r.status === 200, { s: r.status, b: r.body?.error });
  r = await api(mine.token, 'GET', '/users/profile');
  check('and they survive the round trip',
    JSON.stringify(r.body?.data?.profile?.interests) === JSON.stringify(['STUDY', 'TECH', 'MUSIC']),
    r.body?.data?.profile?.interests);

  const spread = await prisma.userProfile.findMany({
    where: { user: { email: { endsWith: '@circl.test' } } },
    select: { interests: true },
  });
  const distinct = new Set(spread.map(p => JSON.stringify(p.interests)));
  check('no two seeded members carry the same set', distinct.size >= 10, distinct.size);

  console.log('\n── G7 privacy switches ─────────────────────────────────────');
  r = await api(token, 'GET', '/users/me/privacy');
  check('privacy loads with all three switches',
    typeof r.body?.data?.personalisedFeed === 'boolean'
    && typeof r.body?.data?.useActivityForRecommendations === 'boolean'
    && typeof r.body?.data?.showInConnectDiscovery === 'boolean', r.body?.data);

  r = await api(token, 'PATCH', '/users/me/privacy', { personalisedFeed: false });
  check('a subset patches and the whole object comes back',
    r.status === 200 && r.body?.data?.personalisedFeed === false
    && 'showInConnectDiscovery' in (r.body?.data ?? {}), r.body?.data);

  r = await api(token, 'GET', '/community/feed');
  check('and the feed really does fall back to recency',
    r.body?.meta?.ranking === 'LATEST', r.body?.meta);

  await api(token, 'PATCH', '/users/me/privacy', { personalisedFeed: true });
  r = await api(token, 'GET', '/community/feed');
  check('switching it back restores ranking', r.body?.meta?.ranking === 'PERSONALISED', r.body?.meta);

  console.log('\n── G8 search ───────────────────────────────────────────────');
  r = await api(token, 'GET', '/search?q=yam');
  check('search returns groups', (r.body?.data?.groups ?? []).length > 0,
    (r.body?.data?.groups ?? []).map(g => `${g.type}:${g.total}`));
  check('each group carries its type, label and total',
    (r.body?.data?.groups ?? []).every(g => g.type && g.label && typeof g.total === 'number'),
    r.body?.data?.groups?.[0]);
  check('items keep the shape their own list endpoint returns',
    (r.body?.data?.groups ?? []).every(g => g.items.every(i => typeof i.id === 'string')),
    r.body?.data?.groups?.[0]?.items?.[0]);

  r = await api(token, 'GET', '/search?q=yam&scope=COMMERCE');
  check('the Commerce scope is actually searched, not always empty',
    (r.body?.data?.groups ?? []).length > 0,
    (r.body?.data?.groups ?? []).map(g => g.type));
  check('and returns only Commerce types',
    (r.body?.data?.groups ?? []).every(g => ['STORE', 'ITEM'].includes(g.type)),
    (r.body?.data?.groups ?? []).map(g => g.type));

  r = await api(token, 'GET', '/search?q=friendship&scope=CONNECT');
  check('the Connect scope answers rather than 500ing', r.status === 200, r.status);

  r = await api(token, 'GET', '/search?q=a');
  check('a one-character term is empty groups, not a 400',
    r.status === 200 && (r.body?.data?.groups ?? []).length === 0, r.status);

  r = await api(token, 'GET', '/search?q=whiting');
  check('suggestions come back with the groups', Array.isArray(r.body?.data?.suggestions),
    r.body?.data?.suggestions);

  console.log('\n── G9 data export ──────────────────────────────────────────');
  r = await api(mine.token, 'GET', '/users/me/data-export');
  check('null data when nothing was ever asked for', r.body?.data === null, r.body?.data);
  r = await api(mine.token, 'POST', '/users/me/data-export');
  check('a request is accepted with 202', r.status === 202 && r.body?.data?.status === 'PENDING',
    { s: r.status, b: r.body?.data });
  r = await api(mine.token, 'POST', '/users/me/data-export');
  check('a second while one is pending is refused, not queued',
    r.status === 409 && r.body?.error?.code === 'EXPORT_ALREADY_PENDING',
    { s: r.status, code: r.body?.error?.code });
  r = await api(mine.token, 'GET', '/users/me/data-export');
  check('and the status is readable', r.body?.data?.status === 'PENDING', r.body?.data);

  console.log('\n── G10 change email ────────────────────────────────────────');
  r = await api(mine.token, 'POST', '/users/me/email/change', { newEmail: 'seed1@circl.test' });
  check('an address on another account is refused',
    r.status === 409 && r.body?.error?.code === 'EMAIL_TAKEN',
    { s: r.status, code: r.body?.error?.code });

  r = await api(mine.token, 'POST', '/users/me/email/change', { newEmail: 'moved@example.test' });
  check('a free address starts the change with 202', r.status === 202, { s: r.status, b: r.body });
  const pending = await prisma.emailChangeRequest.findFirst({
    where: { user: { id: mine.id }, confirmedAt: null },
  });
  check('a pending request is recorded against the NEW address',
    pending?.newEmail === 'moved@example.test', pending?.newEmail);

  r = await api(mine.token, 'POST', '/users/me/email/change/confirm', { code: '000000' });
  check('a wrong code is 400 INVALID_CODE',
    r.status === 400 && r.body?.error?.code === 'INVALID_CODE',
    { s: r.status, code: r.body?.error?.code });

  await prisma.emailChangeRequest.update({
    where: { id: pending.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  r = await api(mine.token, 'POST', '/users/me/email/change/confirm', { code: '000000' });
  check('an expired one is 410 CODE_EXPIRED',
    r.status === 410 && r.body?.error?.code === 'CODE_EXPIRED',
    { s: r.status, code: r.body?.error?.code });

  console.log('\n── G12 store map ───────────────────────────────────────────');
  const stores = await api(token, 'GET', '/commerce/stores?cityId=London');
  r = await api(token, 'GET', `/commerce/stores/${stores.body?.data?.[0]?.id}`);
  check('a store that shows its address has real coordinates',
    typeof r.body?.data?.address?.latitude === 'number'
    && typeof r.body?.data?.address?.longitude === 'number', r.body?.data?.address);
  check('and is not marked approximate', r.body?.data?.address?.isApproximate === false);

  const hidden = await prisma.store.findFirst({ where: { hidesExactAddress: true }, select: { id: true } });
  r = await api(token, 'GET', `/commerce/stores/${hidden.id}`);
  check('one that hides it sends no line1 or postcode',
    r.body?.data?.address?.line1 === null && r.body?.data?.address?.postcode === null,
    r.body?.data?.address);
  check('and its pin is rounded to about a kilometre, flagged approximate',
    r.body?.data?.address?.isApproximate === true
    && String(r.body?.data?.address?.latitude).split('.')[1]?.length <= 2,
    r.body?.data?.address);

  console.log('\n── G12 the static map tile ─────────────────────────────────');
  r = await api(token, 'GET', `/commerce/stores/${stores.body?.data?.[0]?.id}`);
  const mapUrl = r.body?.data?.staticMapUrl;
  check('a store that shows its address carries a staticMapUrl',
    typeof mapUrl === 'string' && mapUrl.startsWith('http'), mapUrl);
  check('it is a signed URL, not a provider URL with a key in it',
    !!mapUrl && !/api_?key|access_token/i.test(mapUrl) && /X-Amz-Signature/.test(mapUrl),
    mapUrl?.slice(0, 120));

  const tile = await fetch(mapUrl);
  const bytes = Buffer.from(await tile.arrayBuffer());
  check('the object behind it exists', tile.status === 200 && bytes.length > 5000,
    { status: tile.status, bytes: bytes.length });
  check('and is a real PNG of the size the doc asks for',
    bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    && bytes.readUInt32BE(16) === 640 && bytes.readUInt32BE(20) === 220,
    { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) });

  r = await api(token, 'GET', `/commerce/stores/${hidden.id}`);
  check('a store that hides its address gets no tile at all',
    r.body?.data?.staticMapUrl === null, r.body?.data?.staticMapUrl);

  // The backfill: a store created through the API has no tile until something asks for it.
  const mapper = await makeUser('gapsmap');
  const built = await api(mapper.token, 'POST', '/commerce/stores', {
    name: 'Static Map Test Shop', type: 'LOCAL', area: 'Ancoats',
    description: 'A store that exists to prove the map tile is rendered server-side.',
    latitude: 53.4839, longitude: -2.2260,
  });
  check('a store can be created with coordinates', built.status === 201,
    { s: built.status, e: built.body?.error });

  let backfilled = null;

  // The first read triggers the render, which then has to reach a tile server, so this polls
  // rather than assuming the second call is already late enough.
  for (let attempt = 0; attempt < 20 && !backfilled; attempt += 1) {
    const detail = await api(mapper.token, 'GET', `/commerce/stores/${built.body?.data?.id}`);

    backfilled = detail.body?.data?.staticMapUrl ?? null;

    if (!backfilled) await new Promise(resolve => setTimeout(resolve, 500));
  }

  check('a store created through the API gets its tile built on first read',
    typeof backfilled === 'string', backfilled);

  const backfilledTile = backfilled ? await fetch(backfilled) : null;
  check('and that object is a real PNG too',
    backfilledTile?.status === 200
    && Buffer.from(await backfilledTile.arrayBuffer()).subarray(0, 8).toString('hex')
      === '89504e470d0a1a0a',
    backfilledTile?.status);

  console.log('\n── G13 Guard resources ─────────────────────────────────────');
  r = await api(token, 'GET', '/guard/resources');
  const resources = r.body?.data ?? [];
  check('the five UK lines are all there',
    ['Samaritans', 'National Domestic Abuse Helpline', 'Migrant Help', 'Shelter', 'Citizens Advice']
      .every(name => resources.some(x => x.name.includes(name))),
    resources.map(x => x.name));
  check('each carries a number and a description the app can render',
    resources.every(x => x.number && x.description), resources[0]);
  check('crisis lines sort first', resources[0]?.isCrisis === true, resources.map(x => x.isCrisis));
  check('lastChecked is current, not a date baked into a binary',
    !!r.body?.meta?.lastChecked
    && Date.now() - new Date(r.body.meta.lastChecked) < 40 * 86400000,
    r.body?.meta);

  console.log('\n── G14 15.2 conversations look alive ───────────────────────');
  const threads = await prisma.conversation.findMany({
    where: { kind: { not: 'SUPPORT' }, participants: { some: { user: { email: { endsWith: '@circl.test' } } } } },
    select: { messageCount: true, messages: { select: { sentAt: true } } },
  });
  check('every seeded thread holds six or more messages',
    threads.length > 0 && threads.every(t => t.messageCount >= 6),
    threads.map(t => t.messageCount));
  check('spread over days rather than minutes',
    threads.every(t => {
      const times = t.messages.map(m => +m.sentAt).sort();

      return times.length < 2 || times[times.length - 1] - times[0] > 2 * 86400000;
    }), threads.map(t => t.messages.length));
  const unread = await prisma.conversationParticipant.count({ where: { unreadCount: { gt: 0 } } });
  check('and some are left unread, so the badge counts something', unread > 0, unread);

  console.log('\n── G15 demand hints ────────────────────────────────────────');
  const seller = await signIn('seed7@circl.test');
  const myStore = await api(seller.body.accessToken, 'GET', '/commerce/stores/me');
  r = await api(seller.body.accessToken, 'GET', `/commerce/stores/${myStore.body?.data?.id}/demand-hints`);
  check('the demand card has something to show', (r.body?.data ?? []).length >= 2,
    r.body?.data);
  check('each hint carries a term, a count and a city',
    (r.body?.data ?? []).every(h => h.term && h.searches >= 3 && h.cityName), r.body?.data?.[0]);

  console.log('\n── G2 report and block ─────────────────────────────────────');
  const victim = await makeUser('gapsvictim');
  const post = await api(victim.token, 'POST', '/community/requests', {
    categoryCode: 'JOBS', title: 'A seeded request to report', description: 'x'.repeat(30),
    cityId: 'MANCHESTER',
  });

  // The field names the report sheet actually sends.
  r = await api(mine.token, 'POST', '/moderation/reports', {
    subjectType: 'REQUEST',
    subjectId: post.body?.data?.id,
    reason: 'HATE_SPEECH',
    detail: 'Reported through the sheet, using its own field names.',
    blockUserId: victim.id,
  });
  check('the sheet payload is accepted as sent', r.status === 202, { s: r.status, b: r.body?.error });

  r = await api(mine.token, 'GET', '/moderation/blocks');
  check('blockUserId applied the block in the same call',
    (r.body?.data ?? []).some(b => b.user?.id === victim.id), r.body?.data);

  r = await api(mine.token, 'POST', '/moderation/reports', {
    subjectType: 'REQUEST', subjectId: post.body?.data?.id, reason: 'HATE_SPEECH',
  });
  check('a duplicate report is idempotent, not an error', r.status === 202, r.status);
  const filed = await prisma.report.count({
    where: { reporterId: mine.id, targetId: post.body?.data?.id },
  });
  check('and files one report, not two', filed === 1, filed);

  r = await api(mine.token, 'POST', '/moderation/reports', {
    targetType: 'REQUEST', targetId: post.body?.data?.id, reasonCode: 'SPAM',
  });
  check('the spec field names still work alongside', r.status === 202, r.status);

  const seededBlocks = await prisma.block.count({
    where: { blocker: { email: { endsWith: '@circl.test' } } },
  });
  check('the seeded dataset carries blocks of its own', seededBlocks >= 2, seededBlocks);
  const seededReports = await prisma.report.count({
    where: { reporter: { email: { endsWith: '@circl.test' } } },
  });
  check('and reports, so the queue is not empty', seededReports >= 2, seededReports);

  console.log('\n── G18 releasing a push token ──────────────────────────────');
  r = await api(mine.token, 'POST', '/users/notification-preferences/device-token', { token: 'seed-fcm-1' });
  check('a token registers', r.status === 200, r.status);

  const second = await makeUser('gapsphone');
  await api(second.token, 'POST', '/users/notification-preferences/device-token', { token: 'seed-fcm-1' });
  const holders = await prisma.userNotificationPrefs.count({ where: { devicePushToken: 'seed-fcm-1' } });
  check('the same handset on a second account MOVES rather than sitting on both', holders === 1, holders);

  r = await api(second.token, 'DELETE', '/users/notification-preferences/device-token', { token: 'seed-fcm-1' });
  check('it can be released on sign-out', r.status === 204, r.status);
  r = await api(second.token, 'DELETE', '/users/notification-preferences/device-token', { token: 'seed-fcm-1' });
  check('releasing one that is already gone still succeeds', r.status === 204, r.status);

  console.log('\n── Cleanup ─────────────────────────────────────────────────');
  await prisma.user.deleteMany({ where: { id: { in: [mine.id, second.id, victim.id, revoker.id, mapper.id] } } });
  await sweep('cleanup');
  await finish();
})().catch(fail);
