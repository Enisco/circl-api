/* Staff authentication: the thing that was wide open.
 *
 * Until this shipped, any member token belonging to a user with a staff role worked on every
 * `/admin` route, and a staff row could obtain one through the member email-code flow — which has
 * no password and no second factor. A phished inbox was an administrator with access to the
 * personal data and private messages of the whole platform.
 *
 * So the checks here are in two halves. The first is that the front door works: invite, password,
 * authenticator, session, rotation. The second is that every other door is shut, and most of the
 * value is in the second half. */
const { generate, NobleCryptoPlugin, ScureBase32Plugin } = require('otplib');
const jwt = require('jsonwebtoken');
const {
  adminHeaders,
  api,
  check,
  clearRateLimits,
  finish,
  forgetCacheKeys,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

const base32 = new ScureBase32Plugin();
const crypto = new NobleCryptoPlugin();
const codeFor = secret => generate({ secret, base32, crypto, digits: 6, period: 30 });

const PASSWORD = 'correct-horse-battery-staple-7';
const bff = process.env.ADMIN_BFF_SECRET
  ? { 'X-Circl-Admin-Client': process.env.ADMIN_BFF_SECRET }
  : {};

/** An invitation, created the way the bootstrap CLI creates one. */
async function inviteFor(email, roleCode = 'super_admin') {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const token = require('crypto').randomBytes(32).toString('base64url');

  await prisma.adminInvite.create({
    data: {
      email,
      roleId: role.id,
      tokenHash: require('crypto').createHash('sha256').update(token, 'utf8').digest('hex'),
      invitedById: '00000000-0000-0000-0000-000000000000',
      expiresAt: new Date(Date.now() + 72 * 3_600_000),
    },
  });

  return token;
}

(async () => {
  await sweep('admin-auth');
  await clearRateLimits();

  // The audit trail is append-only, so entries from earlier runs are still there and always will
  // be. Every assertion about it is scoped to this run.
  const runStartedAt = new Date();

  const email = `e2e-admin-${Date.now()}@example.test`;

  console.log('\n── Invitation ───────────────────────────────────────────────');

  const token = await inviteFor(email);

  let r = await api(null, 'POST', '/admin/auth/invites/inspect', { token }, bff);
  check(
    'an invite says who it is for and who sent it',
    r.status === 200 && r.body?.data?.email === email && r.body?.data?.role === 'super_admin',
    r.body?.data,
  );

  r = await api(
    null,
    'POST',
    '/admin/auth/invites/inspect',
    { token: 'not-a-real-token-at-all' },
    bff,
  );
  check(
    'an unknown token is INVITE_INVALID, not a 400 that confirms the shape',
    r.status === 404 && r.body?.error?.code === 'INVITE_INVALID',
    r.body?.error,
  );

  r = await api(
    null,
    'POST',
    '/admin/auth/invites/accept',
    { token, firstName: 'Ada', lastName: 'L', password: 'short' },
    bff,
  );
  check(
    'a password that breaks the policy is refused, with the rules named',
    r.status === 422 &&
      r.body?.error?.code === 'PASSWORD_POLICY' &&
      r.body?.error?.details?.length > 0,
    r.body?.error,
  );

  r = await api(
    null,
    'POST',
    '/admin/auth/invites/accept',
    { token, firstName: 'Ada', lastName: 'L', password: `${email.split('@')[0]}-and-more` },
    bff,
  );
  check(
    'and so is one built out of their own email address',
    r.status === 422 && r.body?.error?.code === 'PASSWORD_POLICY',
    r.body?.error,
  );

  r = await api(null, 'POST', '/admin/auth/invites/inspect', { token }, bff);
  check('neither refusal spent the invitation', r.status === 200, r.status);

  r = await api(
    null,
    'POST',
    '/admin/auth/invites/accept',
    { token, firstName: 'Ada', lastName: 'L', password: PASSWORD },
    bff,
  );
  check('a real password is accepted', r.status === 201, r.body?.error);
  const setup = r.body?.data;
  check(
    'and hands back a setup token and a scannable URI',
    typeof setup?.mfaSetupToken === 'string' &&
      /^otpauth:\/\/totp\/Circl%20Admin/.test(setup?.otpauthUri ?? ''),
    setup?.otpauthUri,
  );
  check(
    'with the secret in base32, for anyone typing it in by hand',
    /^[A-Z2-7]{32}$/.test(setup?.secret ?? ''),
    setup?.secret?.length,
  );

  r = await api(null, 'POST', '/admin/auth/invites/inspect', { token }, bff);
  check('the invitation is single use', r.status === 404, r.status);

  console.log('\n── The account cannot be used until MFA is enrolled ─────────');

  r = await api(null, 'POST', '/admin/auth/login', { email, password: PASSWORD }, bff);
  check(
    'the password alone returns the enrolment path, never a session',
    r.status === 200 && r.body?.data?.mfaEnrollmentRequired === true && !r.body?.data?.accessToken,
    r.body?.data,
  );

  r = await api(
    null,
    'POST',
    '/admin/auth/mfa/enroll',
    { mfaSetupToken: setup.mfaSetupToken, code: '000000' },
    bff,
  );
  check('a wrong enrolment code is refused', r.status === 401, r.status);

  r = await api(
    null,
    'POST',
    '/admin/auth/mfa/enroll',
    { mfaSetupToken: setup.mfaSetupToken, code: await codeFor(setup.secret) },
    bff,
  );
  check('the right code enrols', r.status === 201, r.body?.error);
  const recovery = r.body?.data?.recoveryCodes ?? [];
  const firstPair = r.body?.data?.tokens;
  check(
    'and returns exactly ten recovery codes, once',
    recovery.length === 10 &&
      recovery.every(code => /^[2-9A-HJ-NP-TV-Z]{5}-[2-9A-HJ-NP-TV-Z]{5}$/.test(code)),
    recovery.slice(0, 2),
  );
  check('with a session', typeof firstPair?.accessToken === 'string', Object.keys(firstPair ?? {}));

  r = await api(
    null,
    'POST',
    '/admin/auth/mfa/enroll',
    { mfaSetupToken: setup.mfaSetupToken, code: await codeFor(setup.secret) },
    bff,
  );
  check('the setup token cannot be used twice', r.status !== 201, r.status);

  console.log('\n── Signing in ───────────────────────────────────────────────');

  await clearRateLimits();
  r = await api(
    null,
    'POST',
    '/admin/auth/login',
    { email, password: 'wrong-password-entirely-x' },
    bff,
  );
  const wrongPassword = r;
  check(
    'a wrong password is INVALID_CREDENTIALS',
    r.status === 401 && r.body?.error?.code === 'INVALID_CREDENTIALS',
    r.body?.error,
  );

  r = await api(
    null,
    'POST',
    '/admin/auth/login',
    { email: `e2e-nobody-${Date.now()}@example.test`, password: 'wrong-password-entirely-x' },
    bff,
  );
  check(
    'an unknown email returns the identical body — it cannot be used to find staff addresses',
    r.status === wrongPassword.status && r.body?.error?.code === wrongPassword.body?.error?.code,
    r.body?.error,
  );

  await clearRateLimits();
  r = await api(null, 'POST', '/admin/auth/login', { email, password: PASSWORD }, bff);
  check(
    'the right password returns a ticket, not a session',
    r.status === 200 && r.body?.data?.mfaRequired === true && !r.body?.data?.accessToken,
    r.body?.data,
  );
  const ticket = r.body?.data?.mfaToken;

  // Enrolment recorded the step its own code belonged to, so the same six digits are now refused —
  // a code is good for thirty seconds, and the replay bound is what stops it being used twice
  // inside them. The next step's code is within the server's tolerance and is a later step.
  const live = await generate({
    secret: setup.secret,
    base32,
    crypto,
    digits: 6,
    period: 30,
    epoch: Math.floor(Date.now() / 1000) + 30,
  });

  r = await api(null, 'POST', '/admin/auth/mfa/verify', { mfaToken: ticket, code: live }, bff);
  check('the next authenticator code completes the sign-in', r.status === 200, r.body?.error);
  const pair = r.body?.data;

  r = await api(null, 'POST', '/admin/auth/mfa/verify', { mfaToken: ticket, code: live }, bff);
  check('the ticket is spent', r.status === 401, r.status);

  await clearRateLimits();
  r = await api(null, 'POST', '/admin/auth/login', { email, password: PASSWORD }, bff);
  r = await api(
    null,
    'POST',
    '/admin/auth/mfa/verify',
    { mfaToken: r.body?.data?.mfaToken, code: live },
    bff,
  );
  check(
    'and the same authenticator code cannot be replayed inside its own 30-second window',
    r.status === 401,
    r.status,
  );

  console.log('\n── The sign-in limit ───────────────────────────────────────');

  // Five in fifteen minutes. Counted in Redis rather than in the process, so it is five across
  // every instance and it survives a deploy — in memory it was five per instance and reset on
  // every release, which is not a limit (B10).
  let limited = null;

  for (let attempt = 0; attempt < 8 && !limited; attempt += 1) {
    const tried = await api(
      null,
      'POST',
      '/admin/auth/login',
      { email, password: 'wrong-x-wrong-x' },
      bff,
    );

    if (tried.status === 429) limited = tried;
  }

  check(
    'repeated sign-in attempts are rate limited',
    limited !== null,
    limited?.status ?? 'never limited',
  );
  check(
    'and the refusal says how long to wait',
    typeof limited?.body?.data?.retryAfterSeconds === 'number',
    limited?.body?.data,
  );

  await clearRateLimits();

  console.log('\n── Lockout, which is a different control ───────────────────');

  // The limiter refuses the request; the lock refuses the ACCOUNT. They are separate, and with the
  // limiter in the way the lock would never be reached — so the limiter is cleared between
  // attempts here, to test the thing underneath it rather than the thing on top.
  await prisma.adminCredential.updateMany({
    where: { user: { email } },
    data: { lockedUntil: null, lockCount: 0, failedAttempts: 0, failedMfaAttempts: 0 },
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await clearRateLimits();
    await api(null, 'POST', '/admin/auth/login', { email, password: 'wrong-x-wrong-x' }, bff);
  }

  await clearRateLimits();

  const locked = await prisma.adminCredential.findFirst({
    where: { user: { email } },
    select: { lockedUntil: true, lockCount: true },
  });

  check(
    'five consecutive failures lock the account',
    locked?.lockedUntil !== null && (locked?.lockCount ?? 0) >= 1,
    locked,
  );
  check(
    'and a locked account still answers with the same generic refusal',
    (await api(null, 'POST', '/admin/auth/login', { email, password: PASSWORD }, bff)).body?.error
      ?.code === 'INVALID_CREDENTIALS',
    'told the caller it was locked',
  );

  // Cleared so the rest of the suite can sign in. In production this is what waiting out the lock
  // does; there is no endpoint that clears it, on purpose.
  await prisma.adminCredential.updateMany({
    where: { user: { email } },
    data: { lockedUntil: null, failedAttempts: 0, failedMfaAttempts: 0 },
  });

  console.log('\n── Recovery codes ───────────────────────────────────────────');

  await clearRateLimits();
  r = await api(null, 'POST', '/admin/auth/login', { email, password: PASSWORD }, bff);
  r = await api(
    null,
    'POST',
    '/admin/auth/mfa/verify',
    { mfaToken: r.body?.data?.mfaToken, code: recovery[0].toLowerCase().replace('-', '') },
    bff,
  );
  check(
    'a recovery code works in lower case and without its hyphen',
    r.status === 200,
    r.body?.error,
  );

  await clearRateLimits();
  r = await api(null, 'POST', '/admin/auth/login', { email, password: PASSWORD }, bff);
  r = await api(
    null,
    'POST',
    '/admin/auth/mfa/verify',
    { mfaToken: r.body?.data?.mfaToken, code: recovery[0] },
    bff,
  );
  check('and only once', r.status !== 200, r.status);

  console.log('\n── Refresh: rotation, grace and reuse ───────────────────────');

  r = await api(null, 'POST', '/admin/auth/refresh', { refreshToken: pair.refreshToken }, bff);
  check(
    'refresh issues a new pair',
    r.status === 200 && r.body?.data?.refreshToken !== pair.refreshToken,
    r.status,
  );
  const rotated = r.body?.data;

  r = await api(null, 'POST', '/admin/auth/refresh', { refreshToken: pair.refreshToken }, bff);
  check(
    'the superseded token inside the grace window returns the SAME pair, not a second rotation',
    r.status === 200 && r.body?.data?.refreshToken === rotated.refreshToken,
    r.body?.data?.refreshToken?.slice(0, 12),
  );

  r = await api(null, 'GET', '/admin/me', null, {
    Authorization: `Bearer ${rotated.accessToken}`,
    ...bff,
  });
  check('the rotated access token works', r.status === 200, r.body?.error);

  // Past the window, the same token is a replay. Forced rather than waited for — and it takes
  // both halves, because the grace answer is cached for the same thirty seconds that `rotatedAt`
  // is compared against, and in production the two expire together.
  await prisma.adminSession.update({
    where: { id: rotated.sessionId },
    data: { rotatedAt: new Date(Date.now() - 120_000) },
  });
  await forgetCacheKeys('admin:refresh-grace:*');

  r = await api(null, 'POST', '/admin/auth/refresh', { refreshToken: pair.refreshToken }, bff);
  check('outside the window it is treated as a replay', r.status === 401, r.status);

  const revoked = await prisma.adminSession.findUnique({ where: { id: rotated.sessionId } });
  check(
    'and the session is revoked with the reason recorded',
    revoked?.revokedReason === 'REFRESH_REUSE',
    revoked?.revokedReason,
  );
  check(
    'with the token hashes cleared, so a reactivation cannot revive them',
    revoked?.refreshTokenHash === null && revoked?.previousRefreshTokenHash === null,
    revoked,
  );

  r = await api(null, 'GET', '/admin/me', null, {
    Authorization: `Bearer ${rotated.accessToken}`,
    ...bff,
  });
  check(
    "the revoked session's access token fails on the very next request",
    r.status === 401 && r.body?.error?.code === 'SESSION_REVOKED',
    r.body?.error,
  );

  console.log('\n── Invitations that must not restore the wrong account ─────');

  // An invitation bound to an account that has since gone is not a licence to create a new one
  // with that address and that role.
  const orphanTarget = await makeAdmin('orphan', 'support');
  const orphanRole = await prisma.role.findUniqueOrThrow({ where: { code: 'support' } });
  const orphanToken = require('crypto').randomBytes(32).toString('base64url');

  await prisma.adminInvite.create({
    data: {
      email: orphanTarget.email,
      roleId: orphanRole.id,
      tokenHash: require('crypto').createHash('sha256').update(orphanToken, 'utf8').digest('hex'),
      invitedById: '00000000-0000-0000-0000-000000000000',
      expiresAt: new Date(Date.now() + 72 * 3_600_000),
      staffUserId: orphanTarget.id,
    },
  });
  await prisma.user.delete({ where: { id: orphanTarget.id } });

  r = await api(
    null,
    'POST',
    '/admin/auth/invites/accept',
    { token: orphanToken, firstName: 'Ghost', lastName: 'Account', password: PASSWORD },
    bff,
  );
  check(
    'an invite bound to an account that no longer exists is refused',
    r.status === 404 && r.body?.error?.code === 'INVITE_INVALID',
    r.body?.error,
  );

  const recreated = await prisma.user.findUnique({ where: { email: orphanTarget.email } });
  check('and no account was created from it', recreated === null, recreated?.id);

  console.log('\n── The doors that used to be open ──────────────────────────');

  const admin = await makeAdmin('guardcheck', 'super_admin');
  const member = await makeUser('membercheck');

  r = await api(member.token, 'GET', '/admin/me');
  check('a member access token is refused on an admin route', r.status === 401, r.status);

  r = await api(member.token, 'GET', '/admin/moderation/queue');
  check('and on the admin routes that predate the portal', r.status === 401, r.status);

  r = await api(null, 'GET', '/admin/me', null, adminHeaders(admin));
  check('an admin token works there', r.status === 200, r.body?.error);

  r = await api(admin.token, 'GET', '/users/profile');
  check('an admin token is refused on a member route', r.status === 401, r.status);

  // A staff row trying to sign in as a member. The email-code flow has no password and no second
  // factor, so this was the way in that mattered.
  const staffRow = await prisma.user.findUnique({
    where: { id: admin.id },
    select: { email: true },
  });
  r = await api(null, 'POST', '/auth/login', { email: staffRow.email });
  check(
    'a staff address cannot start the member sign-in flow',
    r.status === 401 || r.status === 403 || r.status === 404,
    r.status,
  );

  const forged = jwt.sign(
    { sub: admin.id, sid: admin.sessionId, typ: 'admin_access', role: 'super_admin' },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '1h', issuer: 'circl-api', audience: 'circl-admin', algorithm: 'HS256' },
  );

  r = await api(null, 'GET', '/admin/me', null, { Authorization: `Bearer ${forged}`, ...bff });
  check('an admin token signed with the MEMBER secret is refused', r.status === 401, r.status);

  const wrongAudience = jwt.sign(
    { sub: admin.id, sid: admin.sessionId, typ: 'admin_access', role: 'super_admin' },
    process.env.ADMIN_JWT_ACCESS_SECRET,
    { expiresIn: '1h', issuer: 'circl-api', audience: 'circl-app', algorithm: 'HS256' },
  );

  r = await api(null, 'GET', '/admin/me', null, {
    Authorization: `Bearer ${wrongAudience}`,
    ...bff,
  });
  check('and so is one with the wrong audience, even correctly signed', r.status === 401, r.status);

  console.log('\n── Permissions deny by default ─────────────────────────────');

  const support = await makeAdmin('supportcheck', 'support');

  r = await api(null, 'GET', '/admin/me', null, adminHeaders(support));
  check('support can read their own account', r.status === 200, r.body?.error);

  r = await api(null, 'GET', '/admin/team', null, adminHeaders(support));
  check(
    'but not the team, which needs team:read',
    r.status === 403 && r.body?.data?.requires?.includes('team:read'),
    r.body,
  );

  r = await api(null, 'GET', '/admin/moderation/queue', null, adminHeaders(support));
  check('nor the moderation queue', r.status === 403, r.status);

  const ts = await makeAdmin('tscheck', 'trust_safety');

  r = await api(null, 'GET', '/admin/moderation/queue', null, adminHeaders(ts));
  check('trust & safety can read the queue', r.status === 200, r.body?.error);

  r = await api(null, 'POST', '/admin/jobs/intelligence.search-demand/run', {}, adminHeaders(ts));
  check('but cannot run scheduled jobs, which only a super admin may', r.status === 403, r.status);

  console.log('\n── My own portal settings (§5.2) ───────────────────────────');

  const asSupport = adminHeaders(support);

  r = await api(null, 'GET', '/admin/me/preferences', null, asSupport);
  check(
    'every key is present, filled in from the defaults',
    r.status === 200 &&
      r.body?.data?.theme === 'system' &&
      r.body?.data?.alerts?.urgentReports === true &&
      r.body?.data?.alerts?.criticalGuard === true &&
      r.body?.data?.alerts?.assignedToMe === true,
    r.body?.data,
  );

  r = await api(null, 'PUT', '/admin/me/preferences', { theme: 'dark' }, asSupport);
  check('the theme saves', r.status === 200 && r.body?.data?.theme === 'dark', r.body?.data);

  // The merge is the point: the screen has three switches and sends the one that moved. Replacing
  // would mean saving one toggle silently turns the other two off — and for `criticalGuard` that
  // is somebody who stops hearing about safeguarding cases with no way to know it happened.
  r = await api(
    null,
    'PUT',
    '/admin/me/preferences',
    { alerts: { assignedToMe: false } },
    asSupport,
  );
  check(
    'one switch moves and the other two keep their state',
    r.body?.data?.alerts?.assignedToMe === false &&
      r.body?.data?.alerts?.urgentReports === true &&
      r.body?.data?.alerts?.criticalGuard === true,
    r.body?.data?.alerts,
  );
  check(
    'and the theme set a moment ago is still there',
    r.body?.data?.theme === 'dark',
    r.body?.data,
  );

  r = await api(null, 'GET', '/admin/me/preferences', null, asSupport);
  check(
    'read back, it is what was written',
    r.body?.data?.theme === 'dark' && r.body?.data?.alerts?.assignedToMe === false,
    r.body?.data,
  );

  r = await api(null, 'PUT', '/admin/me/preferences', { theme: 'midnight' }, asSupport);
  check('a theme nobody has is refused', r.status === 400, r.status);

  r = await api(
    null,
    'PUT',
    '/admin/me/preferences',
    { alerts: { urgentRepots: false } },
    asSupport,
  );
  check(
    'and a mistyped switch is a 400, not a setting somebody believes they changed',
    r.status === 400,
    { status: r.status, message: r.body?.error?.message },
  );

  const themeEntries = await prisma.auditLog.count({
    where: { actorId: support.id, action: 'staff.profile_updated' },
  });

  check(
    'preferences are not audited: a choice of theme in that trail is noise',
    themeEntries === 0,
    themeEntries,
  );

  console.log('\n── Audit ───────────────────────────────────────────────────');

  const entries = await prisma.auditLog.findMany({
    where: {
      occurredAt: { gte: runStartedAt },
      action: { in: ['auth.login_success', 'auth.mfa_enrolled', 'auth.refresh_reuse'] },
    },
    orderBy: { occurredAt: 'desc' },
  });

  check(
    'signing in, enrolling and a refresh replay are all recorded',
    ['auth.login_success', 'auth.mfa_enrolled', 'auth.refresh_reuse'].every(action =>
      entries.some(entry => entry.action === action),
    ),
    entries.map(entry => entry.action),
  );

  const login = entries.find(entry => entry.action === 'auth.login_success');
  check(
    'an entry carries its actor, area, address and request id',
    login?.actorId && login?.area === 'AUTH' && login?.ip && login?.requestId,
    {
      actorId: !!login?.actorId,
      area: login?.area,
      ip: !!login?.ip,
      requestId: !!login?.requestId,
    },
  );

  const failures = await prisma.auditLog.findMany({
    where: { occurredAt: { gte: runStartedAt }, action: 'auth.login_failed' },
    orderBy: { occurredAt: 'desc' },
  });
  check(
    'every failed sign-in records a hash of the address, and never the address',
    failures.length > 0 &&
      failures.every(entry => typeof entry.metadata?.emailHash === 'string') &&
      !JSON.stringify(failures.map(entry => entry.metadata)).includes('@'),
    failures.slice(0, 2).map(entry => entry.metadata),
  );

  let refused = null;
  try {
    await prisma.auditLog.update({ where: { id: login.id }, data: { reason: 'tampered' } });
  } catch (error) {
    refused = error;
  }
  check(
    'the audit trail refuses to be rewritten, in the database',
    refused !== null,
    refused ? 'refused' : 'ALLOWED',
  );

  refused = null;
  try {
    await prisma.auditLog.delete({ where: { id: login.id } });
  } catch (error) {
    refused = error;
  }
  check('and refuses to be deleted', refused !== null, refused ? 'refused' : 'ALLOWED');

  await prisma.user.deleteMany({ where: { email } });
  await prisma.adminInvite.deleteMany({ where: { email } });
  await sweep('admin-auth');
  await finish();
})().catch(async error => {
  console.error(error);
  process.exit(1);
});
