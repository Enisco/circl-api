/* What staff can DO to a member (§5.5).
 *
 * Reads have no consequences; every endpoint here does. So the checks are about the parts that are
 * easy to get almost right: a suspension that updates the database but leaves live access tokens
 * working, a field a role should not be able to edit, a date of birth changed for the wrong reason,
 * a warning the member can mute, an anonymisation confirmed by a click. Each of those passes a
 * naive test and fails a member. */
const {
  adminHeaders,
  api,
  check,
  clearRateLimits,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

const Redis = require('ioredis');

/** Whether a session id is on the access-token blacklist — the half a naive revoke forgets. */
async function isBlacklisted(sessionId) {
  const redis = new Redis(process.env.REDIS_URL);

  try {
    return (await redis.get(`blacklisted:sessions:${sessionId}`)) !== null;
  } finally {
    await redis.quit();
  }
}

const key = () => ({ 'Idempotency-Key': require('crypto').randomUUID() });

(async () => {
  await sweep('admin-member-actions');
  await clearRateLimits();

  const admin = await makeAdmin('act-admin');
  const headers = adminHeaders(admin);
  const safety = await makeAdmin('act-safety', 'trust_safety');
  const safetyHeaders = adminHeaders(safety);
  const support = await makeAdmin('act-support', 'support');
  const supportHeaders = adminHeaders(support);

  const member = await makeUser('act-member', {
    cityId: 'LONDON',
    dateOfBirth: new Date('1990-04-10'),
    onboardingCompleted: true,
  });

  await prisma.userAuth.create({
    data: { userId: member.id, emailVerifiedAt: new Date(), isBlocked: true, failedLoginAttempts: 5 },
  });

  console.log('\n— The allowlist (S10.2) —');

  let res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { headline: 'Corrected', reasonCode: 'CORRECTION' }, headers);
  check('a super admin may edit a profile field', res.status === 200, res.body?.error);
  check('and gets the member detail back', res.body?.data?.id === member.id, res.body?.data?.id);
  check('with an audit id', !!res.body?.meta?.auditId, res.body?.meta);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { headline: 'Nope', reasonCode: 'CORRECTION' }, safetyHeaders);
  check('trust & safety cannot edit a profile field, and are told which',
    res.status === 403 && res.body?.error?.code === 'FIELD_NOT_EDITABLE'
      && JSON.stringify(res.body).includes('headline'),
    res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { removeAvatar: true, reasonCode: 'POLICY_VIOLATION', policySubtype: 'NUDITY' }, safetyHeaders);
  check('but may remove an avatar — that is moderation, not editing', res.status === 200,
    res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { dateOfBirth: '1991-01-01', reasonCode: 'CORRECTION' }, supportHeaders);
  check('support cannot change a date of birth',
    res.status === 403 && res.body?.error?.code === 'FIELD_NOT_EDITABLE', res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { dateOfBirth: '1991-01-01', reasonCode: 'MEMBER_REQUEST' }, headers);
  check('and even a super admin needs the right reason for one',
    res.status === 422 && res.body?.error?.code === 'REASON_NOT_ALLOWED', res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { dateOfBirth: '1991-01-01', reasonCode: 'CORRECTION' }, headers);
  check('with CORRECTION it goes through', res.status === 200, res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { status: 'SUSPENDED', reasonCode: 'CORRECTION' }, headers);
  check('a field that is not on the DTO at all is refused by name',
    res.status === 400 && JSON.stringify(res.body).includes('status'), res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`, { reasonCode: 'CORRECTION' }, headers);
  check('an edit with nothing in it is refused', res.status === 400, res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`, { headline: 'No reason' }, headers);
  check('and an edit with no reason is 422 REASON_REQUIRED',
    res.status === 422 && res.body?.error?.code === 'REASON_REQUIRED', res.body?.error);

  console.log('\n— Value validation matches the member’s own save —');

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { dateOfBirth: '2015-01-01', reasonCode: 'CORRECTION' }, headers);
  check('a date of birth under 18 is refused', res.status === 400, res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { cityId: 'ATLANTIS', reasonCode: 'CORRECTION' }, headers);
  check('an unknown city is 422 UNKNOWN_CITY',
    res.status === 422 && res.body?.error?.code === 'UNKNOWN_CITY', res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { interests: ['NOT_A_CODE'], reasonCode: 'CORRECTION' }, headers);
  check('an unknown taxonomy code is 422',
    res.status === 422 && res.body?.error?.code === 'UNKNOWN_TAXONOMY_CODE', res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { phoneNumber: '7911123456', reasonCode: 'CORRECTION' }, headers);
  check('half a phone number is refused — a code without a number cannot be rung',
    res.status === 400, res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { phoneNumber: '123', phoneNumberDiallingCode: '+44', reasonCode: 'CORRECTION' }, headers);
  check('and one too short to be a number', res.status === 400, res.body?.error);

  // Clearing one and keeping the other leaves a code with nothing to dial — the same half a number
  // the both-or-neither rule exists to prevent, from the other direction.
  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { phoneNumber: null, phoneNumberDiallingCode: '+44', reasonCode: 'CORRECTION' }, headers);
  check('clearing the number while keeping the code is refused', res.status === 400, res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { phoneNumber: '7911123456', phoneNumberDiallingCode: '+234', reasonCode: 'MEMBER_REQUEST' },
    headers);
  check('both together go through', res.status === 200, res.body?.error);

  const phoneEntry = await prisma.auditLog.findFirst({
    where: { action: 'member.updated', targetId: member.id },
    orderBy: { occurredAt: 'desc' },
  });

  check('and the masked `after` uses the dialling code being written, not the old one',
    JSON.stringify(phoneEntry?.after ?? {}).includes('+234'), phoneEntry?.after);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { phoneNumber: null, phoneNumberDiallingCode: null, reasonCode: 'MEMBER_REQUEST' }, headers);
  check('and clearing both together is allowed', res.status === 200, res.body?.error);

  // An age is calendar arithmetic. Dividing elapsed milliseconds by an average year refuses
  // somebody who turned 18 today, which is the one boundary that matters.
  const eighteenToday = new Date();

  eighteenToday.setUTCFullYear(eighteenToday.getUTCFullYear() - 18);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { dateOfBirth: eighteenToday.toISOString().slice(0, 10), reasonCode: 'CORRECTION' }, headers);
  check('somebody who turned 18 today is 18', res.status === 200, res.body?.error);

  const eighteenTomorrow = new Date();

  eighteenTomorrow.setUTCFullYear(eighteenTomorrow.getUTCFullYear() - 18);
  eighteenTomorrow.setUTCDate(eighteenTomorrow.getUTCDate() + 1);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { dateOfBirth: eighteenTomorrow.toISOString().slice(0, 10), reasonCode: 'CORRECTION' }, headers);
  check('and somebody who turns 18 tomorrow is not', res.status === 400, res.body?.error);

  // The trail has to say what was written, not what was asked for: a loose city spelling resolves
  // to a different id, and a country code is upper-cased on the way in.
  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { cityId: 'manchester', countryOfOriginCode: 'gh', reasonCode: 'CORRECTION' }, headers);
  check('a loose city spelling and a lower-case country are accepted', res.status === 200,
    res.body?.error);

  const resolved = await prisma.userProfile.findUnique({ where: { userId: member.id } });

  check('and stored in their canonical form',
    resolved?.cityId === 'MANCHESTER' && resolved?.countryOfOriginCode === 'GH', resolved?.cityId);

  const resolvedEntry = await prisma.auditLog.findFirst({
    where: { action: 'member.updated', targetId: member.id },
    orderBy: { occurredAt: 'desc' },
  });

  check('which is what the audit entry records, not what was sent',
    resolvedEntry?.after?.cityId === 'MANCHESTER'
      && resolvedEntry?.after?.countryOfOriginCode === 'GH',
    resolvedEntry?.after);

  const rival = await makeUser('act-rival');
  // The harness mints `e2e_act-rival_<stamp>`, which has a hyphen in it and so is a username the
  // member's own profile save would refuse too. Given a legal one here, so the check is about the
  // uniqueness conflict rather than about the pattern.
  const takenName = `e2e_rival_${Date.now()}`;

  await prisma.user.update({ where: { id: rival.id }, data: { username: takenName } });

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { username: takenName, reasonCode: 'CORRECTION' }, headers);
  check('a taken username is 409 USERNAME_TAKEN',
    res.status === 409 && res.body?.error?.code === 'USERNAME_TAKEN', res.body?.error);

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { email: rival.email, reasonCode: 'CORRECTION' }, headers);
  check('a taken email is 409 EMAIL_TAKEN',
    res.status === 409 && res.body?.error?.code === 'EMAIL_TAKEN', res.body?.error);

  console.log('\n— An email change leaves the account unverified —');

  const newEmail = `e2e-act-moved-${Date.now()}@example.test`;

  res = await api(null, 'PATCH', `/admin/members/${member.id}`,
    { email: newEmail, reasonCode: 'MEMBER_REQUEST' }, headers);
  check('the address is changed', res.status === 200, res.body?.error);

  let auth = await prisma.userAuth.findUnique({ where: { userId: member.id } });

  check('and the account is no longer verified — staff can fix a typo, not vouch that somebody reads it',
    auth?.emailVerifiedAt === null, auth?.emailVerifiedAt);

  const entry = await prisma.auditLog.findFirst({
    where: { action: 'member.updated', targetId: member.id },
    orderBy: { occurredAt: 'desc' },
  });

  check('the audit entry records the email masked, never in the clear',
    !JSON.stringify(entry ?? {}).includes(newEmail)
      && JSON.stringify(entry?.after ?? {}).includes('masked'),
    entry?.after);
  check('and a hash, so an investigator can confirm a candidate without a second copy being stored',
    /[0-9a-f]{64}/.test(JSON.stringify(entry?.after ?? {})), entry?.after);

  console.log('\n— Sessions —');

  const session = await prisma.userSession.findFirst({ where: { userId: member.id } });

  res = await api(null, 'POST', `/admin/members/${member.id}/sessions/revoke`,
    { reasonCode: 'SAFETY_CONCERN' }, headers);
  check('a revoke reports how many were live', res.body?.data?.revokedCount >= 1, res.body?.data);
  check('the session row is revoked',
    (await prisma.userSession.findUnique({ where: { id: session.id } }))?.isActive === false,
    'still active');
  check('AND the session id is blacklisted — the half that makes it true now',
    await isBlacklisted(session.id), 'not blacklisted');

  res = await api(null, 'POST', `/admin/members/${member.id}/sessions/revoke`,
    { sessionId: '00000000-0000-0000-0000-000000000000', reasonCode: 'SAFETY_CONCERN' }, headers);
  check('an unknown session is a 404', res.status === 404, res.status);

  res = await api(null, 'POST', `/admin/members/${member.id}/unlock`,
    { reasonCode: 'MEMBER_REQUEST', sessionId: '00000000-0000-0000-0000-000000000000' }, headers);
  check('unlock does not accept a sessionId it would ignore',
    res.status === 400 && JSON.stringify(res.body).includes('sessionId'), res.body?.error);

  res = await api(null, 'POST', `/admin/members/${member.id}/unlock`,
    { reasonCode: 'MEMBER_REQUEST' }, headers);
  check('unlock answers with the member', res.status === 200 && !!res.body?.data?.id, res.body?.error);

  auth = await prisma.userAuth.findUnique({ where: { userId: member.id } });
  check('and clears the lock and the attempt count',
    auth?.isBlocked === false && auth?.failedLoginAttempts === 0, auth);

  res = await api(null, 'POST', '/admin/members/bulk/revoke-sessions',
    { memberIds: [member.id, rival.id], reasonCode: 'SAFETY_CONCERN' }, { ...headers, ...key() });
  check('a bulk revoke reports the members it did', res.body?.data?.members === 2, res.body?.data);

  res = await api(null, 'POST', '/admin/members/bulk/revoke-sessions',
    { memberIds: [member.id, admin.id], reasonCode: 'SAFETY_CONCERN' }, { ...headers, ...key() });
  check('and skips a staff id rather than aborting the batch',
    res.status === 200 && res.body?.data?.members === 1, res.body?.data);

  const bulkEntry = await prisma.auditLog.findFirst({
    where: { action: 'member.bulk_action' },
    orderBy: { occurredAt: 'desc' },
  });

  check('the batch has an entry of its own naming what was asked and what was done',
    bulkEntry?.metadata?.requested === 2 && bulkEntry?.metadata?.members === 1, bulkEntry?.metadata);

  console.log('\n— Suspension —');

  res = await api(null, 'POST', `/admin/members/${member.id}/suspend`,
    { duration: '7d', reasonCode: 'POLICY_VIOLATION' }, { ...headers, ...key() });
  check('a policy violation with no policy named is refused',
    res.status === 422 && res.body?.error?.code === 'REASON_REQUIRED', res.body?.error);

  res = await api(null, 'POST', `/admin/members/${member.id}/suspend`,
    { duration: 'custom', reasonCode: 'SAFETY_CONCERN' }, { ...headers, ...key() });
  check('a custom suspension with no end date is refused', res.status === 400, res.body?.error);

  res = await api(null, 'POST', `/admin/members/${member.id}/suspend`,
    { duration: 'custom', until: '2020-01-01T00:00:00Z', reasonCode: 'SAFETY_CONCERN' },
    { ...headers, ...key() });
  check('and one that ends in the past', res.status === 400, res.body?.error);

  res = await api(null, 'POST', `/admin/members/${member.id}/suspend`,
    { duration: '7d', reasonCode: 'SAFETY_CONCERN', note: 'Scam reports.' },
    { ...headers, ...key() });
  check('a suspension answers with the member', res.status === 200, res.body?.error);
  check('the status and the end date are set',
    res.body?.data?.status === 'SUSPENDED' && !!res.body?.data?.suspendedUntil, res.body?.data);

  const suspension = await prisma.suspension.findFirst({
    where: { userId: member.id, liftedAt: null },
  });

  check('a Suspension record exists, with the reason on it',
    suspension?.reasonCode === 'SAFETY_CONCERN' && suspension?.note === 'Scam reports.',
    suspension?.reasonCode);

  const liveSessions = await prisma.userSession.count({
    where: { userId: member.id, isActive: true },
  });

  check('no session survives a suspension', liveSessions === 0, liveSessions);

  const pushDevices = await prisma.pushDevice.count({ where: { userId: member.id } });

  check('and no push device either', pushDevices === 0, pushDevices);

  const notice = await prisma.notification.findFirst({
    where: { userId: member.id, kind: 'MODERATION' },
    orderBy: { createdAt: 'desc' },
  });

  check('the member is told, as MODERATION in the locked ACCOUNT category',
    notice?.categoryCode === 'ACCOUNT', { kind: notice?.kind, category: notice?.categoryCode });
  check('and the notice carries the reason and the appeal route',
    (notice?.body ?? '').includes('Scam reports.') && (notice?.body ?? '').includes('support'),
    notice?.body);

  res = await api(null, 'POST', `/admin/members/${member.id}/suspend`,
    { duration: '24h', reasonCode: 'SAFETY_CONCERN' }, { ...headers, ...key() });
  check('suspending an already-suspended account is 409, not a second row',
    res.status === 409 && res.body?.error?.code === 'ALREADY_SUSPENDED', res.body?.error);

  res = await api(null, 'POST', `/admin/members/${member.id}/suspend`,
    { duration: '24h', reasonCode: 'SAFETY_CONCERN' }, { ...supportHeaders, ...key() });
  check('support cannot suspend at all', res.status === 403, res.status);

  console.log('\n— Changing and lifting it —');

  const later = new Date(Date.now() + 30 * 86_400_000).toISOString();

  res = await api(null, 'PATCH', `/admin/suspensions/${suspension.id}`,
    { endsAt: later, reasonCode: 'CORRECTION' }, headers);
  check('a suspension can be extended', res.status === 200, res.body?.error);

  let user = await prisma.user.findUnique({ where: { id: member.id } });

  check('and `suspendedUntil` moves with it — left behind, the account comes back on the old date',
    user?.suspendedUntil?.toISOString() === later, user?.suspendedUntil);

  res = await api(null, 'PATCH', `/admin/suspensions/${suspension.id}`,
    { endsAt: '2020-01-01T00:00:00Z', reasonCode: 'CORRECTION' }, headers);
  check('an end in the past is refused — reactivate instead', res.status === 400, res.body?.error);

  // Omitting `endsAt` used to make the suspension permanent, so a typo in the field name turned a
  // seven-day suspension into an indefinite one with no error anywhere.
  res = await api(null, 'PATCH', `/admin/suspensions/${suspension.id}`,
    { reasonCode: 'CORRECTION' }, headers);
  check('omitting endsAt is refused, not read as "make it permanent"',
    res.status === 400 && JSON.stringify(res.body).includes('endsAt'), res.body?.error);

  const stillEnds = await prisma.suspension.findUnique({ where: { id: suspension.id } });

  check('and the suspension still has its end date', stillEnds?.endsAt !== null, stillEnds?.endsAt);

  res = await api(null, 'PATCH', `/admin/suspensions/${suspension.id}`,
    { endsAt: null, reasonCode: 'SAFETY_CONCERN' }, headers);
  check('sending null makes it indefinite, which is the deliberate way to say so',
    res.status === 200 && res.body?.data?.endsAt === null, res.body?.data);

  res = await api(null, 'PATCH', `/admin/suspensions/${suspension.id}`,
    { endsAt: later, reasonCode: 'CORRECTION' }, headers);
  check('and it can be given an end again', res.status === 200, res.body?.error);

  res = await api(null, 'POST', `/admin/members/${member.id}/reactivate`,
    { reasonCode: 'CORRECTION' }, headers);
  check('reactivate answers with the member', res.status === 200, res.body?.error);
  check('and the account is active with no end date',
    res.body?.data?.status === 'ACTIVE' && res.body?.data?.suspendedUntil === null, res.body?.data);

  const lifted = await prisma.suspension.findUnique({ where: { id: suspension.id } });

  check('the suspension is lifted by a person, which is how it differs from the expiry job',
    !!lifted?.liftedAt && lifted?.liftedById === admin.id, lifted?.liftedById);

  res = await api(null, 'POST', `/admin/members/${member.id}/reactivate`,
    { reasonCode: 'CORRECTION' }, headers);
  check('reactivating an active account is 409 INVALID_TRANSITION',
    res.status === 409 && res.body?.error?.code === 'INVALID_TRANSITION', res.body?.error);

  console.log('\n— Warnings and strikes —');

  res = await api(null, 'POST', `/admin/members/${member.id}/warn`,
    { message: 'Please stop posting adverts.', reasonCode: 'POLICY_VIOLATION', policySubtype: 'SPAM' },
    { ...headers, ...key() });
  check('a warning answers with the live strike count',
    res.body?.data?.activeStrikes === 1, res.body?.data);
  check('and does not suggest a suspension at one of three',
    res.body?.data?.suggestSuspension === false, res.body?.data);

  const strike = await prisma.strike.findFirst({
    where: { userId: member.id },
    orderBy: { issuedAt: 'desc' },
  });

  check('the strike records the policy it was about',
    strike?.policySubtype === 'SPAM', strike?.policySubtype);
  check('and that the member was told — which is what makes it a warning',
    !!strike?.notifiedAt, strike?.notifiedAt);
  check('the member’s own message reaches them verbatim',
    strike?.note === 'Please stop posting adverts.', strike?.note);

  for (let i = 0; i < 2; i += 1) {
    res = await api(null, 'POST', `/admin/members/${member.id}/warn`,
      { reasonCode: 'POLICY_VIOLATION', policySubtype: 'SPAM' }, { ...headers, ...key() });
  }

  check('at three it suggests a suspension — and nothing has suspended itself',
    res.body?.data?.activeStrikes === 3 && res.body?.data?.suggestSuspension === true,
    res.body?.data);

  user = await prisma.user.findUnique({ where: { id: member.id } });
  check('the account is still active', user?.status === 'ACTIVE', user?.status);

  res = await api(null, 'POST', `/admin/members/${member.id}/strikes/${strike.id}/revoke`,
    { reasonCode: 'CORRECTION' }, headers);
  check('a strike can be withdrawn', res.status === 200 && res.body?.data?.active === false,
    res.body?.error);
  check('and the row stays, marked', !!res.body?.data?.revokedAt, res.body?.data);

  res = await api(null, 'POST', `/admin/members/${member.id}/strikes/${strike.id}/revoke`,
    { reasonCode: 'CORRECTION' }, headers);
  check('withdrawing it twice is a 404 — there is nothing left to do to it', res.status === 404,
    res.status);

  console.log('\n— Data export —');

  res = await api(null, 'POST', `/admin/members/${member.id}/data-export`,
    { reasonCode: 'LEGAL_GDPR' }, headers);
  check('an export can be started on the member’s behalf',
    res.status === 200 && res.body?.data?.state === 'PENDING', res.body?.error);

  res = await api(null, 'POST', `/admin/members/${member.id}/data-export`,
    { reasonCode: 'LEGAL_GDPR' }, headers);
  check('a second while one is pending is a 409', res.status === 409, res.body?.error);

  res = await api(null, 'POST', `/admin/members/${member.id}/data-export`,
    { reasonCode: 'LEGAL_GDPR' }, safetyHeaders);
  check('and trust & safety cannot start one', res.status === 403, res.status);

  console.log('\n— Anonymisation —');

  const doomed = await makeUser('act-doomed');
  const doomedName = doomed.username;

  res = await api(null, 'POST', `/admin/members/${doomed.id}/anonymise`,
    { confirmUsername: 'wrong', reasonCode: 'LEGAL_GDPR' }, { ...headers, ...key() });
  check('a mistyped confirmation is refused',
    res.status === 422 && res.body?.error?.code === 'CONFIRMATION_MISMATCH', res.body?.error);

  res = await api(null, 'POST', `/admin/members/${doomed.id}/anonymise`,
    { confirmUsername: doomedName, reasonCode: 'LEGAL_GDPR' }, { ...supportHeaders, ...key() });
  check('support cannot anonymise an account', res.status === 403, res.status);

  res = await api(null, 'POST', `/admin/members/${doomed.id}/anonymise`,
    { confirmUsername: doomedName, reasonCode: 'LEGAL_GDPR' }, { ...headers, ...key() });
  check('the right username goes through',
    res.status === 200 && res.body?.data?.anonymised === true, res.body?.error);

  const gone = await prisma.user.findUnique({ where: { id: doomed.id } });

  check('and the account is anonymised', gone?.isAnonymised === true, gone?.isAnonymised);
  check('with the email destroyed', !gone?.email?.includes('act-doomed'), 'email survived');

  const goneEntry = await prisma.auditLog.findFirst({
    where: { action: 'member.anonymised', targetId: doomed.id },
  });

  check('the entry written beforehand is the only remaining way to say whose account it was',
    JSON.stringify(goneEntry?.before ?? {}).includes('masked')
      && !JSON.stringify(goneEntry ?? {}).includes(doomed.email),
    goneEntry?.before);

  res = await api(null, 'POST', `/admin/members/${doomed.id}/anonymise`,
    { confirmUsername: doomedName, reasonCode: 'LEGAL_GDPR' }, { ...headers, ...key() });
  check('and it cannot be done twice — the account is no longer a member', res.status === 404,
    res.status);

  console.log('\n— Every action refuses a staff target (R5) —');

  const ACTIONS = [
    ['PATCH', `/admin/members/${admin.id}`, { headline: 'x', reasonCode: 'CORRECTION' }],
    ['POST', `/admin/members/${admin.id}/sessions/revoke`, { reasonCode: 'SAFETY_CONCERN' }],
    ['POST', `/admin/members/${admin.id}/unlock`, { reasonCode: 'CORRECTION' }],
    ['POST', `/admin/members/${admin.id}/suspend`, { duration: '24h', reasonCode: 'SAFETY_CONCERN' }],
    ['POST', `/admin/members/${admin.id}/reactivate`, { reasonCode: 'CORRECTION' }],
    ['POST', `/admin/members/${admin.id}/warn`, { reasonCode: 'POLICY_VIOLATION', policySubtype: 'SPAM' }],
    ['POST', `/admin/members/${admin.id}/data-export`, { reasonCode: 'LEGAL_GDPR' }],
    ['POST', `/admin/members/${admin.id}/anonymise`,
      { confirmUsername: 'x', reasonCode: 'LEGAL_GDPR' }],
  ];

  let refused = 0;

  for (const [method, path, body] of ACTIONS) {
    const probe = await api(null, method, path, body, { ...headers, ...key() });

    if (probe.status === 404) refused += 1;
    else console.log(`    ${method} ${path.split('/').pop()} answered ${probe.status}`);
  }

  check(`all ${ACTIONS.length} actions 404 on a staff id`, refused === ACTIONS.length, refused);

  await sweep('admin-member-actions');
  await finish();
})().catch(async error => {
  console.error(error);
  process.exit(1);
});
