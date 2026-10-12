/* The data every active-user, retention and enforcement number is built from.
 *
 * All of it has to be written as it happens. A day somebody was present cannot be recovered from a
 * "last seen" column afterwards, the build they were running cannot be recovered at all, and a
 * suspension whose end date passed while nobody was looking is the platform keeping somebody out
 * by mistake — which they cannot report, because they cannot sign in to say so. */
const {
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

const londonDay = at =>
  new Date(
    `${new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at)}T00:00:00.000Z`,
  );

(async () => {
  await sweep('insight');
  await clearRateLimits();

  console.log('\n── Being here is recorded, once every fifteen minutes ──────');

  const member = await makeUser('insight-active');

  await forgetCacheKeys(`user:active:${member.id}`);

  let before = await prisma.user.findUnique({
    where: { id: member.id },
    select: { lastActiveAt: true },
  });
  check(
    'a new member has never been seen, and says so rather than guessing',
    before?.lastActiveAt === null,
    before?.lastActiveAt,
  );

  let r = await api(member.token, 'GET', '/users/profile', null, {
    'x-app-version': '3.4.1',
    'x-client-platform': 'ANDROID',
  });
  check('an ordinary authenticated request succeeds', r.status === 200, r.body?.error);

  // The gate writes outside the request, so give it a moment rather than racing it.
  await new Promise(resolve => setTimeout(resolve, 400));

  const after = await prisma.user.findUnique({
    where: { id: member.id },
    select: { lastActiveAt: true },
  });
  check('and records that they were here', after?.lastActiveAt !== null, after?.lastActiveAt);

  const today = londonDay(new Date());
  const day = await prisma.userDailyActivity.findUnique({
    where: { userId_day: { userId: member.id, day: today } },
  });
  check('with a row for the London day', day !== null, day);
  check(
    'carrying the platform and build they were on, as sent',
    day?.platform === 'ANDROID' && day?.appVersion === '3.4.1',
    {
      platform: day?.platform,
      appVersion: day?.appVersion,
    },
  );

  // Looked up where the write happens, not read off the request. The member strategy does not
  // load the profile, so taking the city from the authenticated user gave undefined every time
  // and left this column empty on every row the live gate wrote.
  const profile = await prisma.userProfile.findUnique({
    where: { userId: member.id },
    select: { cityId: true },
  });
  check(
    'and the city they were in that day, not an empty column',
    day?.cityId !== null && day?.cityId === profile?.cityId,
    { row: day?.cityId, profile: profile?.cityId },
  );

  const firstSeen = day?.firstSeenAt;

  await api(member.token, 'GET', '/users/profile', null, {
    'x-app-version': '9.9.9',
    'x-client-platform': 'IOS',
  });
  await new Promise(resolve => setTimeout(resolve, 400));

  const second = await prisma.userDailyActivity.findUnique({
    where: { userId_day: { userId: member.id, day: today } },
  });
  check(
    'a second visit the same day does not overwrite the first',
    second?.firstSeenAt?.getTime() === firstSeen?.getTime() && second?.appVersion === '3.4.1',
    { firstSeenAt: second?.firstSeenAt, appVersion: second?.appVersion },
  );

  const dayCount = await prisma.userDailyActivity.count({ where: { userId: member.id } });
  check('and there is still exactly one row for the day', dayCount === 1, dayCount);

  console.log('\n── The session records which build it came from ────────────');

  const session = await prisma.userSession.findFirst({
    where: { userId: member.id },
    select: { appVersion: true, platform: true, osVersion: true },
  });
  // The harness creates the session row directly, so this records what the SIGN-IN path writes
  // rather than what a header on a later request says.
  check('a session row exists to carry it', session !== null, session);

  console.log('\n── How the account came to exist ───────────────────────────');

  const signup = await prisma.user.findUnique({
    where: { id: member.id },
    select: { signupMethod: true },
  });
  // The harness creates members directly, so this is null for them; what matters is that every
  // member who went through registration has one, which the backfill guaranteed for the rest.
  const nullMembers = await prisma.user.count({
    where: {
      isStaff: false,
      // Anonymised accounts are excluded from every member metric (§2.5), so whether they carry a
      // signup method is not a question the analytics ever asks. Deleting an account is not
      // supposed to leave a hole in a chart, and this is how it does not.
      isAnonymised: false,
      signupMethod: null,
      email: { not: { startsWith: 'e2e-' } },
    },
  });
  check('no live member is left without a signup method', nullMembers === 0, nullMembers);
  check(
    'and staff have none, because staff are invited rather than signing up',
    (await prisma.user.count({ where: { isStaff: true, signupMethod: { not: null } } })) === 0,
    'a staff account claims a signup method',
  );

  console.log('\n── A suspension ends when it said it would ─────────────────');

  const admin = await makeAdmin('insight-admin', 'super_admin');
  const subject = await makeUser('insight-suspended');

  // Suspended, with an end date that has already passed: the state the job exists to clear up.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: subject.id },
      data: { status: 'SUSPENDED', suspendedUntil: new Date(Date.now() - 60_000) },
    }),
    prisma.suspension.create({
      data: {
        userId: subject.id,
        endsAt: new Date(Date.now() - 60_000),
        reasonCode: 'POLICY_VIOLATION',
        policySubtype: 'SPAM',
        sourceType: 'MANUAL',
        issuedById: admin.id,
      },
    }),
  ]);

  r = await api(subject.token, 'GET', '/users/profile');
  check('a suspended member cannot use the app', r.status === 403, r.status);

  const {
    EnforcementService,
  } = require('../../dist/src/modules/admin/services/enforcement.service');
  const { AuditService } = require('../../dist/src/modules/admin/audit/audit.service');
  const enforcement = new EnforcementService(prisma, new AuditService(prisma));

  const lifted = await enforcement.expireSuspensions();
  check('the expiry job ends it', lifted >= 1, lifted);

  const restored = await prisma.user.findUnique({
    where: { id: subject.id },
    select: { status: true, suspendedUntil: true },
  });
  check(
    'and the account is usable again',
    restored?.status === 'ACTIVE' && restored?.suspendedUntil === null,
    restored,
  );

  const record = await prisma.suspension.findFirst({ where: { userId: subject.id } });
  check(
    'the suspension is marked lifted with a reason',
    record?.liftedAt !== null,
    record?.liftReason,
  );
  check(
    'and with nobody named, because the clock did it — not a person',
    record?.liftedById === null,
    record?.liftedById,
  );

  const entry = await prisma.auditLog.findFirst({
    where: { action: 'member.suspension_expired', targetId: subject.id },
  });
  check('it is in the audit trail with no actor', entry !== null && entry.actorId === null, entry);
  check(
    'and says the account was reactivated',
    entry?.metadata?.reactivated === true,
    entry?.metadata,
  );

  console.log('\n── A longer suspension is not undone by a shorter one ──────');

  const both = await makeUser('insight-two');

  await prisma.user.update({ where: { id: both.id }, data: { status: 'SUSPENDED' } });
  await prisma.suspension.createMany({
    data: [
      {
        userId: both.id,
        endsAt: new Date(Date.now() - 60_000),
        reasonCode: 'POLICY_VIOLATION',
        sourceType: 'MANUAL',
        issuedById: admin.id,
      },
      {
        userId: both.id,
        endsAt: new Date(Date.now() + 86_400_000),
        reasonCode: 'SAFETY_CONCERN',
        sourceType: 'MANUAL',
        issuedById: admin.id,
      },
    ],
  });

  await enforcement.expireSuspensions();

  const stillOut = await prisma.user.findUnique({
    where: { id: both.id },
    select: { status: true },
  });
  check(
    'the expired one is closed but the account stays suspended',
    stillOut?.status === 'SUSPENDED',
    stillOut?.status,
  );

  const closed = await prisma.suspension.count({
    where: { userId: both.id, liftedAt: { not: null } },
  });
  check('exactly one of the two was closed', closed === 1, closed);

  await sweep('insight');
  await finish();
})().catch(async error => {
  console.error(error);
  process.exit(1);
});
