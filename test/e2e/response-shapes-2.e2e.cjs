/* Response shapes for everything the updated spec added or changed.
 *
 * response-shapes.e2e.cjs covers sections 0 to 5 as originally specified. This
 * one covers 0.16, 6.x, and the parts of 2 and 3 the update reshaped, checked
 * field by field against the JSON the spec prints. */
const jwt = require('jsonwebtoken');
const { api, check, dobFor, finish, makeUser, prisma, sweep } = require('./harness.cjs');

const has = (obj, path) =>
  path.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj) !== undefined;

const shape = (label, obj, fields) => {
  const missing = fields.filter(f => !has(obj, f));
  check(`${label}: ${fields.length} spec fields present`, missing.length === 0, { missing });
};

async function staff(tag, roleCode) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const user = await prisma.user.create({
    data: {
      firstName: 'E2E', lastName: tag, email: `e2e-${tag}-${stamp}@example.test`,
      username: `e2e_${tag}_${stamp}`, status: 'ACTIVE', isStaff: true,
      userRole: { create: { roleId: role.id } },
      profile: { create: { cityId: 'MANCHESTER' } },
      sessions: { create: { userAgent: 'e2e', deviceType: 'cli', browserName: 'cli',
        operatingSystem: 'cli', ipAddress: '127.0.0.1', isActive: true,
        deviceFingerprint: `e2e-${tag}-${stamp}` } },
    },
    include: { sessions: true },
  });
  return { id: user.id, token: jwt.sign({ sub: user.id, sid: user.sessions[0].id },
    process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }) };
}

(async () => {
  await sweep();
  const a = await makeUser('sh2a');
  const b = await makeUser('sh2b');
  let r;

  console.log('\n── 0.16 the user record ─────────────────────────────────────');
  await api(a.token, 'PATCH', '/users/profile',
    { bio: 'Here since 2023.', canHelpWith: 'CV reviews, Airport runs', countryOfOrigin: 'NG' });

  r = await api(a.token, 'GET', '/users/me/profile');
  shape('0.16.3 public profile', r.body?.data, [
    'user', 'username', 'bio', 'canHelpWith', 'countryOfOrigin', 'rating.average',
    'rating.count', 'isOpenToMessages', 'memberSince', 'viewer.isOwner', 'viewer.conversationId',
  ]);
  check('0.16.3 canHelpWith is an array of chips',
    Array.isArray(r.body?.data?.canHelpWith), r.body?.data?.canHelpWith);
  check('0.16.3 countryOfOrigin is a code/label pair',
    has(r.body?.data, 'countryOfOrigin.code') && has(r.body?.data, 'countryOfOrigin.label'),
    r.body?.data?.countryOfOrigin);

  await api(a.token, 'POST', '/community/requests',
    { categoryCode: 'ACCOMMODATION', title: 'Shape check request', cityId: 'MANCHESTER' });
  r = await api(a.token, 'GET', '/users/me/activity');
  shape('0.16.5 activity row', r.body?.data?.[0], [
    'id', 'type', 'title', 'excerpt', 'route', 'status', 'isAnonymous', 'thumbnailUrl', 'createdAt',
  ]);
  check('0.16.5 meta carries byType', has(r.body?.meta, 'byType'), r.body?.meta);
  check('0.16.5 byType omits zero counts',
    Object.values(r.body?.meta?.byType ?? {}).every(v => v > 0), r.body?.meta?.byType);

  console.log('\n── 2.9 bookings ─────────────────────────────────────────────');
  const listing = await api(b.token, 'POST', '/professionals/listings', {
    categoryCodes: ['LEGAL'], professionTitle: 'Adviser', experienceLevel: 'EXPERT',
    about: 'I have advised on immigration matters for the better part of a decade.',
    consentAccepted: true,
  });
  const listingId = listing.body?.data?.listing?.id;
  await api(b.token, 'PATCH', `/professionals/listings/${listingId}/availability`, { isAcceptingWork: true });
  const service = await api(b.token, 'POST', `/professionals/listings/${listingId}/services`,
    { name: 'Consultation', description: 'One hour on your case and the next step', price: 6500, priceBasis: 'PER_HOUR' });
  const booking = await api(a.token, 'POST', '/bookings',
    { listingId, serviceId: service.body?.data?.id, agreedAmount: 6500 },
    { 'Idempotency-Key': `sh2-${Date.now()}` });
  check('2.9.2 booking created', booking.status === 201, { s: booking.status, b: booking.body });
  check('2.9.2 returns conversationId, so Message never guesses a thread',
    typeof booking.body?.data?.conversationId === 'string', booking.body?.data?.conversationId);

  r = await api(a.token, 'GET', `/bookings/${booking.body?.data?.id}`);
  shape('2.9.4 booking detail', r.body?.data, [
    'id', 'timeline', 'counterpart', 'conversationId', 'viewer.role', 'viewer.canAccept',
    'viewer.canDecline', 'viewer.canMarkDelivered', 'viewer.canConfirmDone',
    'viewer.canRequestChanges', 'viewer.canCancel', 'viewer.canRaiseIssue', 'viewer.canReview',
  ]);
  r = await api(a.token, 'GET', '/bookings?role=CLIENT');
  check('2.9.3 list rows carry needsYourAction',
    has(r.body?.data?.[0], 'needsYourAction'), r.body?.data?.[0]);

  console.log('\n── 3.5 connection requests ──────────────────────────────────');
  await api(a.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP', lookingFor: 'Sunday walks and a bit of company.',
    dateOfBirth: dobFor(30), dmPolicy: 'REQUEST_FIRST', isVisible: true,
  });
  await api(b.token, 'PUT', '/connect/me', {
    typeCode: 'NETWORKING', lookingFor: 'Meeting people working in the same field.',
    dateOfBirth: dobFor(34), dmPolicy: 'REQUEST_FIRST', isVisible: true,
  });
  const target = await api(b.token, 'GET', '/connect/me');
  const req = await api(a.token, 'POST', '/connect/requests',
    { toProfileId: target.body?.data?.profile?.id, note: 'Saw we are in the same city.' },
    { 'Idempotency-Key': `sh2c-${Date.now()}` });
  check('3.5.1 request created', req.status === 201, { s: req.status, b: req.body });

  r = await api(b.token, 'GET', '/connect/requests?direction=RECEIVED');
  shape('3.5.2 request row', r.body?.data?.[0], ['id', 'direction', 'state', 'note', 'profile', 'createdAt']);

  console.log('\n── 6.1 notifications ────────────────────────────────────────');
  r = await api(b.token, 'GET', '/notifications');
  shape('6.1.1 notification row', r.body?.data?.[0], [
    'id', 'kind', 'title', 'body', 'bucket', 'isRead', 'route', 'actor', 'createdAt',
  ]);
  check('6.1.1 meta carries unreadTotal', has(r.body?.meta, 'unreadTotal'), r.body?.meta);
  check('6.1.1 bucket is a bare code, no label',
    ['TODAY', 'THIS_WEEK', 'EARLIER'].includes(r.body?.data?.[0]?.bucket), r.body?.data?.[0]?.bucket);

  const one = r.body?.data?.[0]?.id;
  r = await api(b.token, 'POST', `/notifications/${one}/read`);
  check('6.1.2 read returns unreadTotal in data, not meta',
    has(r.body?.data, 'unreadTotal') && r.body?.meta === undefined, { d: r.body?.data, m: r.body?.meta });

  r = await api(b.token, 'GET', '/users/notification-preferences');
  shape('6.1.3 preference row', r.body?.data?.categories?.[0], ['code', 'label', 'push', 'email', 'isLocked']);
  check('6.1.3 PUT never accepts label or isLocked', (await api(b.token, 'PUT', '/users/notification-preferences',
    { categories: [{ code: 'REPLIES', push: true, email: true, label: 'Hacked', isLocked: false }] })).status === 400);

  console.log('\n── 6.2 Pulse ────────────────────────────────────────────────');
  r = await api(a.token, 'GET', '/pulse/community?cityId=Manchester');
  shape('6.2 dashboard', r.body?.data, [
    'stats', 'barsTitle', 'bars', 'actionsTitle', 'actions', 'contributingMembers', 'updatedAt',
  ]);
  const stat = r.body?.data?.stats?.[0];
  if (stat) shape('6.2 stat row', stat, ['label', 'value', 'deltaLabel', 'isUp']);
  const bar = r.body?.data?.bars?.[0];
  if (bar) shape('6.2 bar row', bar, ['label', 'value', 'max']);
  const action = r.body?.data?.actions?.[0];
  if (action) shape('6.2 action row', action, ['label', 'detail', 'actionLabel', 'route']);

  console.log('\n── 6.3 Guard ────────────────────────────────────────────────');
  const guard = await api(a.token, 'POST', '/guard/requests',
    { categoryCode: 'HOUSING', body: 'My landlord has stopped replying to me entirely.' },
    { 'Idempotency-Key': `sh2g-${Date.now()}` });
  shape('6.3.1 guard request', guard.body?.data, ['conversationId']);
  check('6.3.1 returns nothing else', Object.keys(guard.body?.data ?? {}).join() === 'conversationId',
    Object.keys(guard.body?.data ?? {}));

  r = await api(a.token, 'GET', '/guard/resources?countryCode=GB');
  shape('6.3.3 resource row', r.body?.data?.[0], ['name', 'phone', 'url', 'isCrisis', 'hours']);
  check('6.3.3 meta carries lastCheckedAt', has(r.body?.meta, 'lastCheckedAt'), r.body?.meta);

  console.log('\n── 0.11 media ───────────────────────────────────────────────');
  r = await api(a.token, 'POST', '/media/uploads',
    { purpose: 'COMMUNITY', files: [{ mimeType: 'image/jpeg', byteSize: 2048 }] });
  shape('0.11.1 upload slot', r.body?.data?.[0], ['key', 'uploadUrl', 'uploadHeaders', 'expiresAt']);
  check('0.11.1 returns no mediaId', !has(r.body?.data?.[0], 'mediaId'), Object.keys(r.body?.data?.[0] ?? {}));

  console.log('\n── 2.7 verification, deferred by D13 ────────────────────────');
  r = await api(b.token, 'GET', '/verification/status');
  check('2.7.1 status is reachable', r.status === 200, r.status);
  const checks = r.body?.data?.checks ?? [];
  shape('2.7.1 check row', checks[0], ['check', 'status']);
  check('2.7.1 EMAIL is the only check anyone holds (D13)',
    checks.find(c => c.check === 'EMAIL')?.status === 'VERIFIED' &&
      checks.filter(c => c.check !== 'EMAIL').every(c => c.status === 'NOT_STARTED'),
    checks.map(c => `${c.check}:${c.status}`));

  await sweep();
  await finish();
})();
