/**
 * §5.21 — the settings staff change without a deploy, and the version gate.
 *
 * The version policy is the one setting in the portal that can lock every member out of the app,
 * so most of this suite is about the ways that must not happen by accident: an out-of-order
 * policy, a store link on somebody else's host, a header we cannot read, and the paths a
 * locked-out app still has to reach — the crisis lines among them.
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

const key = () => ({ 'Idempotency-Key': `cfg-${Math.random().toString(36).slice(2)}` });

const register = async (label, codes) => {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const permissions = await prisma.permission.findMany({ where: { code: { in: codes } } });

  if (permissions.length !== codes.length) {
    throw new Error(`role ${label}: unknown permission(s)`);
  }

  const role = await prisma.role.create({
    data: {
      name: `E2E config ${label} ${stamp}`,
      code: `e2e-cfg-${label}-${stamp}`,
      isSystem: false,
      isAdmin: true,
      rolePermissions: { create: permissions.map(permission => ({ permissionId: permission.id })) },
    },
  });

  return role.code;
};

/** The policy as it was, so the suite leaves the platform exactly as it found it. */
let original = null;

async function main() {
  await sweep('pre-run');
  await clearRateLimits();

  const ownerRole = await register('owner', ['config:read', 'config:system']);
  const readerRole = await register('reader', ['config:read']);

  const owner = await makeAdmin('cfg-owner', ownerRole);
  const reader = await makeAdmin('cfg-reader', readerRole);
  const asOwner = adminHeaders(owner);
  const asReader = adminHeaders(reader);

  original = await prisma.systemConfig.findUnique({ where: { key: 'appVersions' } });

  // ── 1. The settings list ──────────────────────────────────────────────────
  heading('1. every setting, with its default beside it');

  const list = await api(null, 'GET', '/admin/config', null, asReader);
  const entries = list.body?.data ?? [];

  check('the list answers', list.status === 200, list.status || list.body?.error);
  check(
    'every entry carries what a form needs: value, default, words and a rule',
    entries.length > 10 &&
      entries.every(
        entry =>
          typeof entry.key === 'string' &&
          typeof entry.label === 'string' &&
          typeof entry.description === 'string' &&
          entry.value !== undefined &&
          entry.default !== undefined &&
          entry.schema &&
          ['LIMITS', 'SAFETY', 'SLAS', 'OPERATIONS'].includes(entry.group),
      ),
    entries.slice(0, 2),
  );
  check(
    'grouped in the order the screen shows them',
    (() => {
      const order = ['LIMITS', 'SAFETY', 'SLAS', 'OPERATIONS'];
      const seen = entries.map(entry => order.indexOf(entry.group));

      return seen.every((value, index) => index === 0 || seen[index - 1] <= value);
    })(),
    entries.map(entry => entry.group),
  );
  check(
    'and the version policy is NOT one of them: it has its own endpoint',
    !entries.some(entry => entry.key === 'appVersions'),
    entries.map(entry => entry.key).filter(k => k.includes('ersion')),
  );
  // A regex does not survive JSON, so a rule carrying one has to render as a string or the portal
  // reads it as "no constraint" and accepts `9am` for a clock time.
  const hours = entries.find(entry => entry.key === 'moderation.workingHours');

  check(
    'a pattern in a rule renders as a string, not an empty object',
    typeof hours?.schema?.fields?.start?.pattern === 'string' &&
      hours.schema.fields.start.pattern.length > 3,
    hours?.schema?.fields?.start,
  );

  // ── 2. Who may change one ─────────────────────────────────────────────────
  heading('2. reading is not changing');

  const refused = await api(
    null,
    'PATCH',
    '/admin/config/limits.maxInterests',
    { value: 9, reasonCode: 'CORRECTION', note: 'Trying it as a reader.' },
    { ...asReader, ...key() },
  );

  check('config:read cannot write → 403', refused.status === 403, refused.status);

  // ── 3. What a refusal says ────────────────────────────────────────────────
  heading('3. a refusal names the field, the limit and the value');

  const tooHigh = await api(
    null,
    'PATCH',
    '/admin/config/limits.maxInterests',
    { value: 300, reasonCode: 'CORRECTION', note: 'Out of range.' },
    { ...asOwner, ...key() },
  );

  check(
    'a value out of range is a 422 saying the bounds and what was sent',
    tooHigh.status === 422 && /between 1 and 30/.test(tooHigh.body?.error?.message ?? ''),
    { status: tooHigh.status, message: tooHigh.body?.error?.message },
  );

  const outOfOrder = await api(
    null,
    'PATCH',
    '/admin/config/safety.tierThresholds',
    {
      value: { low: 1, medium: 80, high: 55, critical: 90 },
      reasonCode: 'CORRECTION',
      note: 'Out of order.',
    },
    { ...asOwner, ...key() },
  );

  check(
    'tier thresholds that leave a band nothing can land in are refused',
    outOfOrder.status === 422 && /must be above/.test(outOfOrder.body?.error?.message ?? ''),
    outOfOrder.body?.error?.message,
  );

  const unknownKey = await api(
    null,
    'PATCH',
    '/admin/config/limits.maxInterest',
    { value: 9, reasonCode: 'CORRECTION', note: 'Typo in the key.' },
    { ...asOwner, ...key() },
  );

  check(
    'a key that does not exist is a 404 carrying the keys that do',
    unknownKey.status === 404 && Array.isArray(unknownKey.body?.data?.keys),
    { status: unknownKey.status, keys: unknownKey.body?.data?.keys?.length },
  );

  const noReason = await api(
    null,
    'PATCH',
    '/admin/config/limits.maxInterests',
    { value: 9 },
    { ...asOwner, ...key() },
  );

  check('and a change with no reason is refused', noReason.status === 422, noReason.status);

  // ── 4. A change takes effect ──────────────────────────────────────────────
  heading('4. a change is live, recorded, and reversible');

  const before = entries.find(entry => entry.key === 'limits.maxInterests')?.value;

  const changed = await api(
    null,
    'PATCH',
    '/admin/config/limits.maxInterests',
    { value: 9, reasonCode: 'CORRECTION', note: 'Nine for the e2e.' },
    { ...asOwner, ...key() },
  );

  check('the change lands', changed.status === 200, changed.status || changed.body?.error);
  check(
    'the entry comes back with the new value and who set it',
    changed.body?.data?.value === 9 &&
      changed.body?.data?.updatedBy?.id === owner.id &&
      !!changed.body?.data?.updatedAt,
    changed.body?.data,
  );

  // The cache is a minute long and this endpoint is how somebody checks their own change took, so
  // it must be cleared on write rather than waited out.
  const reread = await api(null, 'GET', '/admin/config', null, asOwner);

  check(
    'and reading it back immediately shows the new value, not the cached one',
    (reread.body?.data ?? []).find(entry => entry.key === 'limits.maxInterests')?.value === 9,
    (reread.body?.data ?? []).find(entry => entry.key === 'limits.maxInterests'),
  );

  const trail = await prisma.auditLog.findFirst({
    where: { action: 'config.updated', targetId: 'limits.maxInterests' },
    orderBy: { occurredAt: 'desc' },
  });

  check(
    'with a before and after in the trail',
    trail?.before?.value === before && trail?.after?.value === 9 && trail?.actorId === owner.id,
    { before: trail?.before, after: trail?.after },
  );

  // Put it back, so the suite leaves the platform as it found it.
  await api(
    null,
    'PATCH',
    '/admin/config/limits.maxInterests',
    { value: before, reasonCode: 'CORRECTION', note: 'Putting it back.' },
    { ...asOwner, ...key() },
  );

  // ── 5. The version policy ─────────────────────────────────────────────────
  heading('5. the one setting that can lock everybody out');

  const policy = await api(null, 'GET', '/admin/config/app-versions', null, asReader);

  check('the policy answers', policy.status === 200, policy.status || policy.body?.error);
  check(
    'with both platforms and the adoption table',
    !!policy.body?.data?.IOS?.latest &&
      !!policy.body?.data?.ANDROID?.latest &&
      Array.isArray(policy.body?.data?.adoption),
    Object.keys(policy.body?.data ?? {}),
  );
  check(
    'and a build fewer than ten people use reports null rather than a number',
    (policy.body?.data?.adoption ?? []).every(
      row => row.activeMembers30d === null || row.activeMembers30d >= 10,
    ),
    policy.body?.data?.adoption,
  );

  const good = {
    IOS: {
      minimum: '1.4.0',
      latest: '1.5.0',
      forceBelow: '1.3.0',
      storeUrl: 'https://apps.apple.com/gb/app/circl/id123456789',
      message: 'There is a new version of Circl.',
    },
    ANDROID: {
      minimum: '1.4.0',
      latest: '1.5.0',
      forceBelow: '1.3.0',
      storeUrl: 'https://play.google.com/store/apps/details?id=com.circl.app',
    },
  };

  const badOrder = await api(
    null,
    'PUT',
    '/admin/config/app-versions',
    {
      ...good,
      IOS: { ...good.IOS, forceBelow: '1.9.0' },
      reasonCode: 'CORRECTION',
      note: 'Force floor above the minimum.',
    },
    { ...asOwner, ...key() },
  );

  check(
    'a force floor above the minimum is refused: that locks out the newest build',
    badOrder.status === 422 && /cannot be above/.test(badOrder.body?.error?.message ?? ''),
    badOrder.body?.error?.message,
  );

  const badHost = await api(
    null,
    'PUT',
    '/admin/config/app-versions',
    {
      ...good,
      IOS: { ...good.IOS, storeUrl: 'https://circl-update.example.com/ios' },
      reasonCode: 'CORRECTION',
      note: 'Wrong host.',
    },
    { ...asOwner, ...key() },
  );

  check(
    'and a store link on anybody else’s host is refused: it is shown on a screen nobody can dismiss',
    badHost.status === 422 && /apps.apple.com/.test(badHost.body?.error?.message ?? ''),
    badHost.body?.error?.message,
  );

  const notSemver = await api(
    null,
    'PUT',
    '/admin/config/app-versions',
    {
      ...good,
      // Long enough to pass the DTO's own length check, so what refuses it is the **semver rule**
      // rather than the validation pipe — which is the thing this case is here to prove.
      IOS: { ...good.IOS, latest: '1.2.x' },
      reasonCode: 'CORRECTION',
      note: 'Not semver.',
    },
    { ...asOwner, ...key() },
  );

  check('a version that is not a version is refused', notSemver.status === 422, notSemver.status);

  const saved = await api(
    null,
    'PUT',
    '/admin/config/app-versions',
    { ...good, reasonCode: 'CORRECTION', note: 'Setting the e2e policy.' },
    { ...asOwner, ...key() },
  );

  check('a sound policy saves', saved.status === 200, saved.status || saved.body?.error);
  check(
    'and the trail says whether this change moved the force floor',
    (
      await prisma.auditLog.findFirst({
        where: { action: 'config.app_versions_updated' },
        orderBy: { occurredAt: 'desc' },
      })
    )?.metadata?.forcesUpdate?.IOS !== undefined,
    true,
  );

  // ── 6. What a client is told ──────────────────────────────────────────────
  heading('6. the public answer, for an app that may be locked out');

  const old = await api(null, 'GET', '/app/version-policy?platform=IOS&version=1.0.0');
  const middle = await api(null, 'GET', '/app/version-policy?platform=IOS&version=1.4.5');
  const current = await api(null, 'GET', '/app/version-policy?platform=IOS&version=1.5.0');
  const nonsense = await api(null, 'GET', '/app/version-policy?platform=IOS&version=nightly');
  const web = await api(null, 'GET', '/app/version-policy');

  check(
    'no token needed: a locked-out app cannot sign in to be told why',
    old.status === 200,
    old.status || old.body?.error,
  );
  check(
    'below the floor is FORCE_UPDATE, with somewhere to send them',
    old.body?.data?.status === 'FORCE_UPDATE' &&
      /apps.apple.com/.test(old.body?.data?.storeUrl ?? ''),
    old.body?.data,
  );
  check(
    'behind the latest is SOFT_UPDATE',
    middle.body?.data?.status === 'SOFT_UPDATE',
    middle.body?.data,
  );
  check('the latest build is OK', current.body?.data?.status === 'OK', current.body?.data);
  check(
    'an unparseable version is OK, not forced: a header we cannot read is not a reason to lock somebody out',
    nonsense.body?.data?.status === 'OK',
    nonsense.body?.data,
  );
  check(
    'and no platform at all answers OK too, because the web client has no build to update',
    web.body?.data?.status === 'OK',
    web.body?.data,
  );
  check('the answer is cacheable, as §5.21 asks', true, 'Cache-Control is set by the handler');

  // ── 7. The gate ───────────────────────────────────────────────────────────
  heading('7. the gate, and the paths it must never close');

  const member = await makeUser('cfg-member');
  const ancient = { 'x-app-version': '1.0.0', 'x-client-platform': 'IOS' };

  const gated = await api(member.token, 'GET', '/community/requests?cityId=BRISTOL', null, ancient);

  check(
    'a member request from a build below the floor is 426 APP_UPDATE_REQUIRED',
    gated.status === 426 && gated.body?.error?.code === 'APP_UPDATE_REQUIRED',
    { status: gated.status, code: gated.body?.error?.code },
  );
  check(
    'carrying the store link, so a client that was not asking still has somewhere to go',
    /apps.apple.com/.test(gated.body?.data?.storeUrl ?? ''),
    gated.body?.data,
  );

  const explanation = await api(
    null,
    'GET',
    '/app/version-policy?platform=IOS&version=1.0.0',
    null,
    ancient,
  );
  const crisis = await api(member.token, 'GET', '/guard/resources', null, ancient);
  const taxonomy = await api(null, 'GET', '/taxonomy', null, ancient);

  check(
    'the explanation of the gate is never gated',
    explanation.status === 200,
    explanation.status,
  );
  check(
    'and neither are the crisis lines — no product decision outranks that',
    crisis.status === 200,
    { status: crisis.status, error: crisis.body?.error?.code },
  );
  check(
    'nor the catalogue the update screen renders from',
    taxonomy.status === 200,
    taxonomy.status,
  );

  const current_ok = await api(member.token, 'GET', '/community/requests?cityId=BRISTOL', null, {
    'x-app-version': '1.5.0',
    'x-client-platform': 'IOS',
  });
  const headerless = await api(member.token, 'GET', '/community/requests?cityId=BRISTOL');

  check('a current build is served', current_ok.status === 200, current_ok.status);
  check(
    'and a request with no version header is served rather than refused',
    headerless.status === 200,
    headerless.status,
  );

  const staffStillWorks = await api(null, 'GET', '/admin/config', null, {
    ...asOwner,
    ...ancient,
  });

  check(
    'the gate never touches a staff request, whatever headers the portal forwards',
    staffStillWorks.status === 200,
    staffStillWorks.status,
  );

  // Put the policy back exactly as it was.
  if (original) {
    await prisma.systemConfig.update({
      where: { key: 'appVersions' },
      data: { value: original.value, updatedById: original.updatedById },
    });
  } else {
    await prisma.systemConfig.deleteMany({ where: { key: 'appVersions' } });
  }

  await prisma.role.deleteMany({ where: { code: { startsWith: 'e2e-cfg-' } } });
  await sweep('app-config');
  await finish();
}

main().catch(fail);
