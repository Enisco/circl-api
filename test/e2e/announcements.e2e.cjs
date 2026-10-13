/**
 * §5.18 — one message from Circl to many members.
 *
 * The most consequential write in the portal after a suspension, and the only one with no undo, so
 * the suite is mostly about the ways that goes wrong: addressing more people than you meant,
 * addressing almost nobody, sending somewhere nobody meant, and sending it twice.
 *
 * The fan-out itself is exercised for real — a small audience, batched, with delivery rows checked
 * against the preferences they were supposed to respect.
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

const key = () => ({ 'Idempotency-Key': `an-${Math.random().toString(36).slice(2)}` });

const register = async (label, codes) => {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const permissions = await prisma.permission.findMany({ where: { code: { in: codes } } });

  if (permissions.length !== codes.length) throw new Error(`role ${label}: unknown permission(s)`);

  const role = await prisma.role.create({
    data: {
      name: `E2E comms ${label} ${stamp}`,
      code: `e2e-an-${label}-${stamp}`,
      isSystem: false,
      isAdmin: true,
      rolePermissions: { create: permissions.map(permission => ({ permissionId: permission.id })) },
    },
  });

  return role.code;
};

/** Waits for the fan-out to land, rather than guessing at a sleep. */
const until = async (predicate, label, attempts = 40) => {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) return true;

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`    (gave up waiting for ${label})`);

  return false;
};

async function main() {
  await sweep('pre-run');
  await clearRateLimits();

  const senderRole = await register('sender', ['communications:manage']);
  const otherRole = await register('other', ['members:read']);

  const sender = await makeAdmin('an-sender', senderRole);
  const other = await makeAdmin('an-other', otherRole);
  const asSender = adminHeaders(sender);
  const asOther = adminHeaders(other);

  // ── 1. An audience ────────────────────────────────────────────────────────
  heading('1. who it would reach, before anybody sends it');

  // Twelve members in one city, which is over §2.7's floor of ten so the count is reportable.
  const members = [];

  for (let index = 0; index < 12; index += 1) {
    members.push(await makeUser(`an-m${index}`, { cityId: 'BRISTOL' }));
  }

  const audience = { everyone: false, filter: { cityIds: ['BRISTOL'] } };

  const preview = await api(
    null,
    'POST',
    '/admin/announcements/audience-preview',
    { audience, channels: ['IN_APP', 'PUSH', 'EMAIL'] },
    asSender,
  );

  check('the preview answers', preview.status === 200, preview.status || preview.body?.error);
  check(
    'with an audience of at least the twelve we made',
    (preview.body?.data?.members ?? 0) >= 12 && preview.body?.data?.suppressed === false,
    preview.body?.data,
  );
  check(
    'and a separate reach per channel, because a thousand members is not a thousand emails',
    typeof preview.body?.data?.reachable?.IN_APP === 'number' &&
      'PUSH' in (preview.body?.data?.reachable ?? {}) &&
      'EMAIL' in (preview.body?.data?.reachable ?? {}),
    preview.body?.data?.reachable,
  );
  check(
    'email reach is lower than the audience: it is opt-in, and nobody has opted in',
    preview.body?.data?.reachable?.EMAIL === 0,
    preview.body?.data?.reachable,
  );
  check(
    'while in-app reaches everybody, because a notification row is always written',
    preview.body?.data?.reachable?.IN_APP === preview.body?.data?.members,
    preview.body?.data?.reachable,
  );

  const tiny = await api(
    null,
    'POST',
    '/admin/announcements/audience-preview',
    {
      // A real city with nobody in it, so the filter validates and the count is genuinely tiny —
      // this check is about the floor, not about a rejected vocabulary.
      audience: { everyone: false, filter: { cityIds: ['ABERDEEN'] } },
      channels: ['IN_APP'],
    },
    asSender,
  );

  check(
    'a filter nobody matches is zero or a suppressed count, never a number under ten',
    tiny.status === 200 &&
      (tiny.body?.data?.members === null || tiny.body?.data?.members === 0) &&
      (tiny.body?.data?.reachable?.IN_APP ?? 0) === 0,
    { status: tiny.status, data: tiny.body?.data, error: tiny.body?.error },
  );

  const refusedPreview = await api(
    null,
    'POST',
    '/admin/announcements/audience-preview',
    { audience, channels: ['IN_APP'] },
    asOther,
  );

  check(
    'and somebody without communications:manage cannot even preview → 403',
    refusedPreview.status === 403,
    refusedPreview.status,
  );

  // ── 2. Writing one ────────────────────────────────────────────────────────
  heading('2. what a draft refuses');

  const noAudience = await api(
    null,
    'POST',
    '/admin/announcements',
    {
      title: 'Nobody in particular',
      body: 'This has no audience at all.',
      channels: ['IN_APP'],
      audience: { everyone: false },
    },
    { ...asSender, ...key() },
  );

  check(
    'no filter and no `everyone` is refused: an empty filter must not mean the platform',
    noAudience.status === 422,
    { status: noAudience.status, code: noAudience.body?.error?.code },
  );

  const badRoute = await api(
    null,
    'POST',
    '/admin/announcements',
    {
      title: 'Somewhere else',
      body: 'Tapping this would leave the app.',
      channels: ['IN_APP'],
      route: 'https://not-circl.example.com/phish',
      audience,
    },
    { ...asSender, ...key() },
  );

  check(
    'a link off the allowlist is refused: an announcement is the platform delivering it',
    badRoute.status === 422 && /app-routes/.test(badRoute.body?.error?.message ?? ''),
    badRoute.body?.error?.message,
  );

  const longPush = await api(
    null,
    'POST',
    '/admin/announcements',
    {
      title: 'Too long for a push',
      body: 'x'.repeat(600),
      channels: ['IN_APP', 'PUSH'],
      audience,
    },
    { ...asSender, ...key() },
  );

  check(
    'a 600-character body with push selected is refused, because the OS cuts it off',
    longPush.status === 422,
    { status: longPush.status, message: longPush.body?.error?.message },
  );

  const longInApp = await api(
    null,
    'POST',
    '/admin/announcements',
    { title: 'Long but in-app only', body: 'x'.repeat(600), channels: ['IN_APP'], audience },
    { ...asSender, ...key() },
  );

  check(
    'and the same body without push is fine: the limit is about where it lands',
    longInApp.status === 201,
    longInApp.status || longInApp.body?.error,
  );

  const routes = await api(null, 'GET', '/admin/meta/app-routes', null, asSender);

  check(
    'the allowlist is served, so the picker has something to offer',
    routes.status === 200 &&
      (routes.body?.data ?? []).length > 5 &&
      routes.body.data.every(entry => entry.route?.startsWith('/') && entry.label),
    (routes.body?.data ?? []).length,
  );

  const draft = await api(
    null,
    'POST',
    '/admin/announcements',
    {
      title: 'A new guide for Bristol',
      body: 'We have written something that might help with registering with a GP.',
      channels: ['IN_APP', 'EMAIL'],
      route: '/community',
      audience,
    },
    { ...asSender, ...key() },
  );
  const id = draft.body?.data?.id;

  check('a sound draft saves', draft.status === 201 && !!id, draft.body?.error);
  check(
    'as a DRAFT with no stats yet',
    draft.body?.data?.state === 'DRAFT' && draft.body?.data?.stats === null,
    draft.body?.data,
  );
  check(
    'naming who wrote it',
    draft.body?.data?.createdBy?.id === sender.id,
    draft.body?.data?.createdBy,
  );

  // ── 3. Sending ────────────────────────────────────────────────────────────
  heading('3. the send, and the count the sender was shown');

  const stale = await api(
    null,
    'POST',
    `/admin/announcements/${id}/send`,
    { confirmAudienceCount: 2 },
    { ...asSender, ...key() },
  );

  check(
    'a confirmation that does not match the real audience is 409 STALE_AUDIENCE',
    stale.status === 409 && stale.body?.error?.code === 'STALE_AUDIENCE',
    { status: stale.status, code: stale.body?.error?.code, data: stale.body?.data },
  );
  check(
    'and the refusal says what it actually is, so the portal can show it',
    typeof stale.body?.data?.members === 'number' && stale.body?.data?.confirmed === 2,
    stale.body?.data,
  );

  const noKey = await api(
    null,
    'POST',
    `/admin/announcements/${id}/send`,
    { confirmAudienceCount: preview.body?.data?.members },
    asSender,
  );

  check(
    'sending without an Idempotency-Key is refused: a double send cannot be put right',
    noKey.status === 400,
    { status: noKey.status, message: noKey.body?.error?.message },
  );

  // A second announcement, to a filter nobody matches, for the floor.
  const lonely = await api(
    null,
    'POST',
    '/admin/announcements',
    {
      title: 'For almost nobody',
      body: 'This audience is too small to be an announcement.',
      channels: ['IN_APP'],
      audience: { everyone: false, filter: { cityIds: ['ABERDEEN'] } },
    },
    { ...asSender, ...key() },
  );
  const lonelyId = lonely.body?.data?.id;

  const tooFew = await api(
    null,
    'POST',
    `/admin/announcements/${lonelyId}/send`,
    { confirmAudienceCount: 0 },
    { ...asSender, ...key() },
  );

  check(
    'under ten recipients is 422 AUDIENCE_TOO_SMALL — that is a message, not an announcement',
    tooFew.status === 422 && tooFew.body?.error?.code === 'AUDIENCE_TOO_SMALL',
    { status: tooFew.status, code: tooFew.body?.error?.code },
  );

  const fresh = await api(
    null,
    'POST',
    '/admin/announcements/audience-preview',
    { audience, channels: ['IN_APP', 'EMAIL'] },
    asSender,
  );
  const sent = await api(
    null,
    'POST',
    `/admin/announcements/${id}/send`,
    { confirmAudienceCount: fresh.body?.data?.members },
    { ...asSender, ...key() },
  );

  check('the send lands', sent.status === 200, sent.status || sent.body?.error);
  check(
    'as SENDING, with the audience frozen and who sent it',
    sent.body?.data?.state === 'SENDING' &&
      sent.body?.data?.audienceCount === fresh.body?.data?.members &&
      sent.body?.data?.sentBy?.id === sender.id,
    sent.body?.data,
  );

  const landed = await until(async () => {
    const row = await prisma.announcement.findUnique({ where: { id }, select: { state: true } });

    return row?.state === 'SENT';
  }, 'the fan-out to finish');

  check('and the fan-out finishes', landed, 'state never reached SENT');

  // ── 4. What actually reached whom ─────────────────────────────────────────
  heading('4. the delivery rows, and the preferences they respected');

  const deliveries = await prisma.announcementDelivery.findMany({
    where: { announcementId: id },
    select: { userId: true, channel: true, status: true },
  });

  check(
    'a row per member per channel',
    deliveries.filter(row => row.channel === 'IN_APP').length >= 12 &&
      deliveries.filter(row => row.channel === 'EMAIL').length >= 12,
    {
      inApp: deliveries.filter(row => row.channel === 'IN_APP').length,
      email: deliveries.filter(row => row.channel === 'EMAIL').length,
    },
  );
  check(
    'in-app went out to everybody',
    deliveries.filter(row => row.channel === 'IN_APP').every(row => row.status === 'SENT'),
    [...new Set(deliveries.filter(row => row.channel === 'IN_APP').map(row => row.status))],
  );
  check(
    'and email was SKIPPED_PREFERENCE, not FAILED: nobody opted in, and that is not a failure',
    deliveries
      .filter(row => row.channel === 'EMAIL')
      .every(row => row.status === 'SKIPPED_PREFERENCE'),
    [...new Set(deliveries.filter(row => row.channel === 'EMAIL').map(row => row.status))],
  );

  const notified = await prisma.notification.findMany({
    where: { userId: { in: members.map(member => member.id) }, kind: 'ANNOUNCEMENT' },
    select: { userId: true, title: true, route: true, metadata: true },
  });

  check(
    'every member has the notification, with the deep link on it',
    notified.length >= 12 &&
      notified.every(row => row.title === 'A new guide for Bristol' && row.route === '/community'),
    { count: notified.length, sample: notified[0] },
  );
  check(
    'and it names the announcement it came from, which is what "opened" is counted against',
    notified.every(row => row.metadata?.announcementId === id),
    notified[0]?.metadata,
  );

  const member = members[0];
  const feed = await api(member.token, 'GET', '/notifications');

  check(
    'the member sees it in their own feed',
    feed.status === 200 &&
      (feed.body?.data ?? []).some(row => row.title === 'A new guide for Bristol'),
    (feed.body?.data ?? []).slice(0, 2).map(row => row.title),
  );

  const stats = await api(null, 'GET', `/admin/announcements/${id}`, null, asSender);

  check(
    'the stats answer',
    stats.status === 200 && !!stats.body?.data?.stats,
    stats.body?.data?.stats,
  );
  check(
    'counting delivered and skipped apart, so a working fan-out does not read as broken',
    stats.body?.data?.stats?.perChannel?.IN_APP?.delivered >= 12 &&
      stats.body?.data?.stats?.perChannel?.EMAIL?.skippedPreference >= 12 &&
      stats.body?.data?.stats?.perChannel?.EMAIL?.failed === 0,
    stats.body?.data?.stats?.perChannel,
  );
  check(
    'and `opened` is null for email, because tracking that needs a pixel we do not use',
    stats.body?.data?.stats?.perChannel?.EMAIL?.opened === null &&
      typeof stats.body?.data?.stats?.perChannel?.IN_APP?.opened === 'number',
    stats.body?.data?.stats?.perChannel,
  );

  const resent = await api(
    null,
    'POST',
    `/admin/announcements/${id}/send`,
    { confirmAudienceCount: fresh.body?.data?.members },
    { ...asSender, ...key() },
  );

  check('a sent announcement cannot be sent again → 409', resent.status === 409, {
    status: resent.status,
    code: resent.body?.error?.code,
  });

  const edited = await api(
    null,
    'PATCH',
    `/admin/announcements/${id}`,
    { title: 'Changed my mind' },
    { ...asSender, ...key() },
  );

  check(
    'nor edited, because there is no unsend — write a new one',
    edited.status === 409 && /no unsend|new one/i.test(edited.body?.error?.message ?? ''),
    edited.body?.error?.message,
  );

  // ── 5. Scheduling and cancelling ──────────────────────────────────────────
  heading('5. armed for later, and stopped');

  const forLater = await api(
    null,
    'POST',
    '/admin/announcements',
    {
      title: 'Next week in Bristol',
      body: 'Something is happening and we will tell you about it on Tuesday.',
      channels: ['IN_APP'],
      audience,
    },
    { ...asSender, ...key() },
  );
  const laterId = forLater.body?.data?.id;

  const tooSoon = await api(
    null,
    'POST',
    `/admin/announcements/${laterId}/schedule`,
    { scheduledAt: new Date(Date.now() + 60_000).toISOString() },
    { ...asSender, ...key() },
  );

  check(
    'a minute out is refused: a schedule has to stay cancellable after it is set',
    tooSoon.status === 422,
    tooSoon.status,
  );

  const tooFar = await api(
    null,
    'POST',
    `/admin/announcements/${laterId}/schedule`,
    { scheduledAt: new Date(Date.now() + 200 * 86_400_000).toISOString() },
    { ...asSender, ...key() },
  );

  check('and two hundred days out is refused too', tooFar.status === 422, tooFar.status);

  const scheduled = await api(
    null,
    'POST',
    `/admin/announcements/${laterId}/schedule`,
    { scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
    { ...asSender, ...key() },
  );

  check('two days out is armed', scheduled.status === 200, scheduled.body?.error);
  check(
    'as SCHEDULED, with the time on the row',
    scheduled.body?.data?.state === 'SCHEDULED' && !!scheduled.body?.data?.scheduledAt,
    scheduled.body?.data,
  );

  const cancelled = await api(
    null,
    'POST',
    `/admin/announcements/${laterId}/cancel`,
    {},
    { ...asSender, ...key() },
  );

  check('and it can be called off', cancelled.status === 200, cancelled.body?.error);
  check(
    'leaving CANCELLED rather than disappearing',
    cancelled.body?.data?.state === 'CANCELLED',
    cancelled.body?.data?.state,
  );

  const noneLeft = await prisma.announcementDelivery.count({
    where: { announcementId: laterId },
  });

  check('with nothing delivered, because it never ran', noneLeft === 0, noneLeft);

  const cancelSent = await api(
    null,
    'POST',
    `/admin/announcements/${id}/cancel`,
    {},
    { ...asSender, ...key() },
  );

  check(
    'cancelling one that has gone out is a 409 saying so',
    cancelSent.status === 409 && /unsend/i.test(cancelSent.body?.error?.message ?? ''),
    cancelSent.body?.error?.message,
  );

  // ── 6. The trail ──────────────────────────────────────────────────────────
  heading('6. what the trail says');

  const trail = await prisma.auditLog.findMany({
    where: { targetId: { in: [id, laterId] }, action: { startsWith: 'announcement.' } },
    select: { action: true, metadata: true, after: true },
    orderBy: { occurredAt: 'asc' },
  });
  const actions = trail.map(entry => entry.action);

  check(
    'every step is recorded by its own name',
    [
      'announcement.created',
      'announcement.sent',
      'announcement.scheduled',
      'announcement.cancelled',
    ].every(action => actions.includes(action)),
    actions,
  );
  check(
    'the send records the audience it was confirmed against',
    trail.find(entry => entry.action === 'announcement.sent')?.after?.audienceCount >= 12,
    trail.find(entry => entry.action === 'announcement.sent')?.after,
  );
  check(
    'and a cancellation records how many had already received it',
    typeof trail.find(entry => entry.action === 'announcement.cancelled')?.metadata
      ?.alreadyDelivered === 'number',
    trail.find(entry => entry.action === 'announcement.cancelled')?.metadata,
  );

  await prisma.announcement.deleteMany({ where: { createdById: sender.id } });
  await prisma.role.deleteMany({ where: { code: { startsWith: 'e2e-an-' } } });
  await sweep('announcements');
  await finish();
}

main().catch(fail);
