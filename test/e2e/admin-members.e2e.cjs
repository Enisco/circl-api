/* The member list, the detail page, masking, reveal, and staff notes.
 *
 * Two things are being checked here, and the second one is the point. The first is that the
 * endpoints answer correctly: the filters narrow what they say they narrow, the sorts order by what
 * they say they order by, and the counts are the member's own.
 *
 * The second is that a staff member working a queue cannot accumulate the platform's contact
 * details as a side effect of their job. Every list and detail response is masked for every role,
 * including a super admin's; the plaintext comes only from `reveal`, one member and one field at a
 * time, and every call writes down who looked and why. A list that quietly returned real email
 * addresses to whoever had `members:read` would satisfy every other assertion in this file. */
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

const DOT = '•';

/** A member with a full profile, so the row has something in every column. */
async function member(tag, overrides = {}) {
  const user = await makeUser(tag, {
    cityId: 'LONDON',
    gender: 'FEMALE',
    dateOfBirth: new Date('1995-06-15'),
    countryOfOriginCode: 'NG',
    journeyStage: 'SETTLING_IN',
    heritageTag: 'WEST_AFRICAN',
    onboardingCompleted: true,
    phoneNumberDiallingCode: '+44',
    phoneNumber: '7911123456',
    headline: 'Caterer',
    interests: ['FOOD_COOKING'],
    languages: ['ENGLISH'],
    ...overrides,
  });

  return user;
}

(async () => {
  await sweep('admin-members');
  await clearRateLimits();

  const admin = await makeAdmin('member-admin');
  const headers = adminHeaders(admin);

  // Support: `members:read` and — deliberately — `members:pii_reveal`, because an agent on a call
  // has to be able to confirm the address on the account (§4.13). What they do not have is
  // `guard:read`, which is what the note checks below turn on.
  const support = await makeAdmin('member-support', 'support');
  const supportHeaders = adminHeaders(support);

  // Trust & Safety: `members:read` without `members:pii_reveal`. The role that proves masking is
  // not merely "masked for the roles that cannot see anyway" — they work the whole safety queue
  // and still never see a contact detail they have not deliberately asked for.
  const safety = await makeAdmin('member-safety', 'trust_safety');
  const safetyHeaders = adminHeaders(safety);

  const alice = await member('alice');
  const bob = await member('bob', {
    cityId: 'MANCHESTER',
    gender: 'MALE',
    dateOfBirth: new Date('1975-01-20'),
    countryOfOriginCode: 'GH',
    journeyStage: null,
    onboardingCompleted: false,
    phoneNumber: null,
    phoneNumberDiallingCode: null,
    interests: [],
    languages: [],
  });

  await prisma.user.update({
    where: { id: alice.id },
    data: {
      signupMethod: 'GOOGLE',
      lastPlatform: 'IOS',
      lastAppVersion: '2.1.0',
      lastActiveAt: new Date(),
    },
  });
  await prisma.user.update({
    where: { id: bob.id },
    data: { signupMethod: 'EMAIL', lastPlatform: 'ANDROID', lastAppVersion: '1.9.0' },
  });

  console.log('\n— The list —');

  let res = await api(null, 'GET', '/admin/members?perPage=100', null, headers);
  check('the list answers', res.status === 200, res.body);

  const rows = res.body?.data ?? [];
  const aliceRow = rows.find(row => row.id === alice.id);
  const bobRow = rows.find(row => row.id === bob.id);

  check('both members are listed', !!aliceRow && !!bobRow, rows.length);
  check('the row carries the city', aliceRow?.city?.id === 'LONDON', aliceRow?.city);
  check('and the age band, derived from the birth date', !!aliceRow?.ageBand, aliceRow?.ageBand);
  check(
    'and the country as a code and a label',
    aliceRow?.countryOfOrigin?.code === 'NG' && aliceRow?.countryOfOrigin?.label === 'Nigeria',
    aliceRow?.countryOfOrigin,
  );
  check(
    'and the journey stage with its label',
    aliceRow?.journeyStage?.code === 'SETTLING_IN' && !!aliceRow?.journeyStage?.label,
    aliceRow?.journeyStage,
  );
  check(
    'and the platform and build, from the account rather than a session join',
    aliceRow?.platform === 'IOS' && aliceRow?.appVersion === '2.1.0',
    aliceRow,
  );
  check('and the sign-up method', aliceRow?.signupMethod === 'GOOGLE', aliceRow?.signupMethod);
  check(
    'and which sections they are in',
    aliceRow?.sections &&
      aliceRow.sections.professional === false &&
      aliceRow.sections.connect === false &&
      aliceRow.sections.store === false,
    aliceRow?.sections,
  );
  check('and a strike count', aliceRow?.activeStrikes === 0, aliceRow?.activeStrikes);
  check('and a report count', aliceRow?.reportsReceived === 0, aliceRow?.reportsReceived);

  console.log('\n— Masking (S8.1) —');

  check(
    'the email is masked for a super admin, not only for lesser roles',
    aliceRow?.emailMasked?.includes(DOT) && !aliceRow.emailMasked.includes(alice.email),
    aliceRow?.emailMasked,
  );
  check(
    'the mask keeps the first letter and the public suffix',
    /^e•{3}@e•{3}\.test$/.test(aliceRow?.emailMasked ?? ''),
    aliceRow?.emailMasked,
  );
  check(
    'no row carries a raw email at all',
    rows.every(row => !('email' in row)),
    Object.keys(rows[0] ?? {}),
  );
  check(
    'nor a date of birth, only the band',
    rows.every(row => !('dateOfBirth' in row)),
    Object.keys(rows[0] ?? {}),
  );

  console.log('\n— Staff are not members (R5) —');

  check('the list excludes staff', !rows.some(row => row.id === admin.id), admin.id);

  res = await api(null, 'GET', `/admin/members/${admin.id}`, null, headers);
  check('and a staff id is a 404 rather than a 403', res.status === 404, res.status);

  console.log('\n— Anonymised members are excluded (§2.5) —');

  const ghost = await member('ghost');

  await prisma.user.update({
    where: { id: ghost.id },
    data: { isAnonymised: true, anonymisedAt: new Date() },
  });

  res = await api(null, 'GET', '/admin/members?perPage=100', null, headers);
  check(
    'an anonymised account is not listed',
    !(res.body?.data ?? []).some(row => row.id === ghost.id),
    ghost.id,
  );

  res = await api(null, 'GET', `/admin/members/${ghost.id}`, null, headers);
  check('and its detail page is a 404', res.status === 404, res.status);

  console.log('\n— Filters —');

  res = await api(null, 'GET', '/admin/members?cityIds=LONDON&perPage=100', null, headers);
  check(
    'cityIds narrows to that city',
    (res.body?.data ?? []).some(row => row.id === alice.id) &&
      !(res.body?.data ?? []).some(row => row.id === bob.id),
    res.body?.meta,
  );
  check(
    'and says which filters it applied',
    (res.body?.meta?.filtersApplied ?? []).includes('cityIds'),
    res.body?.meta,
  );

  res = await api(null, 'GET', '/admin/members?cityIds=NOWHERE', null, headers);
  check(
    'an unknown city is a 400 rather than an empty page',
    res.status === 400 && res.body?.error?.code === 'UNKNOWN_CITY',
    res.body?.error,
  );

  res = await api(null, 'GET', '/admin/members?gender=MALE&perPage=100', null, headers);
  check(
    'gender narrows the population',
    (res.body?.data ?? []).some(row => row.id === bob.id) &&
      !(res.body?.data ?? []).some(row => row.id === alice.id),
    res.body?.meta,
  );

  res = await api(null, 'GET', '/admin/members?ageBands=AGE_45_PLUS&perPage=100', null, headers);
  check(
    'an age band filters on the birth date column',
    (res.body?.data ?? []).some(row => row.id === bob.id) &&
      !(res.body?.data ?? []).some(row => row.id === alice.id),
    res.body?.meta,
  );

  res = await api(null, 'GET', '/admin/members?countriesOfOrigin=NG&perPage=100', null, headers);
  check(
    'country of origin narrows it',
    (res.body?.data ?? []).some(row => row.id === alice.id) &&
      !(res.body?.data ?? []).some(row => row.id === bob.id),
    res.body?.meta,
  );

  res = await api(null, 'GET', '/admin/members?interests=FOOD_COOKING&perPage=100', null, headers);
  check(
    'an interest matches inside the JSON array',
    (res.body?.data ?? []).some(row => row.id === alice.id) &&
      !(res.body?.data ?? []).some(row => row.id === bob.id),
    res.body?.meta,
  );

  res = await api(null, 'GET', '/admin/members?interests=NOT_A_THING', null, headers);
  check(
    'an unknown taxonomy code is a 400',
    res.status === 400 && res.body?.error?.code === 'UNKNOWN_TAXONOMY_CODE',
    res.body?.error,
  );

  res = await api(null, 'GET', '/admin/members?platforms=IOS&perPage=100', null, headers);
  check(
    'platform narrows it',
    (res.body?.data ?? []).some(row => row.id === alice.id) &&
      !(res.body?.data ?? []).some(row => row.id === bob.id),
    res.body?.meta,
  );

  res = await api(
    null,
    'GET',
    '/admin/members?onboarding=not_completed&perPage=100',
    null,
    headers,
  );
  check(
    '"not completed" includes the member who has not finished',
    (res.body?.data ?? []).some(row => row.id === bob.id) &&
      !(res.body?.data ?? []).some(row => row.id === alice.id),
    res.body?.meta,
  );

  res = await api(null, 'GET', '/admin/members?signupMethods=GOOGLE&perPage=100', null, headers);
  check(
    'sign-up method narrows it',
    (res.body?.data ?? []).some(row => row.id === alice.id) &&
      !(res.body?.data ?? []).some(row => row.id === bob.id),
    res.body?.meta,
  );

  res = await api(null, 'GET', '/admin/members?lastActiveFrom=2099-01-01', null, headers);
  check(
    'a last-active window in the future matches nobody',
    res.status === 200 && (res.body?.data ?? []).length === 0,
    res.body?.meta,
  );

  console.log('\n— No default date range on the list (§5.4) —');

  const old = await member('old-timer');

  await prisma.user.update({
    where: { id: old.id },
    data: { createdAt: new Date('2024-01-15T12:00:00Z') },
  });

  res = await api(null, 'GET', '/admin/members?perPage=100', null, headers);
  check(
    'a member who joined two years ago is still listed with no range sent',
    (res.body?.data ?? []).some(row => row.id === old.id),
    res.body?.meta,
  );
  check(
    'and the response says no range was applied',
    res.body?.meta?.range === undefined,
    res.body?.meta?.range,
  );

  res = await api(
    null,
    'GET',
    '/admin/members?from=2024-01-01&to=2024-01-31&perPage=100',
    null,
    headers,
  );
  check(
    'sending a range filters by sign-up date',
    (res.body?.data ?? []).some(row => row.id === old.id) &&
      !(res.body?.data ?? []).some(row => row.id === alice.id),
    res.body?.meta,
  );

  res = await api(
    null,
    'GET',
    '/admin/members?from=2020-01-01&to=2026-01-01&granularity=day',
    null,
    headers,
  );
  check(
    'a day-granularity range over 366 days is refused',
    res.status === 400 && res.body?.error?.code === 'FILTER_RANGE_TOO_LARGE',
    res.body?.error,
  );

  res = await api(null, 'GET', '/admin/members?from=2026-05-01&to=2026-01-01', null, headers);
  check('a range that runs backwards is refused', res.status === 400, res.body?.error);

  res = await api(null, 'GET', '/admin/members?page=1&perPage=1', null, headers);
  const realTotal = res.body?.meta?.totalCount;

  check('the total comes back on page one', realTotal > 1, res.body?.meta);

  res = await api(null, 'GET', '/admin/members?page=900&perPage=1', null, headers);
  check(
    'and a page past the end still reports the real total rather than zero',
    res.body?.meta?.totalCount === realTotal && (res.body?.data ?? []).length === 0,
    res.body?.meta,
  );

  console.log('\n— Search —');

  res = await api(
    null,
    'GET',
    `/admin/members?q=${encodeURIComponent('E2E alice')}`,
    null,
    headers,
  );
  check(
    'a two-part name matches across both name columns',
    (res.body?.data ?? []).some(row => row.id === alice.id),
    res.body?.data?.length,
  );

  res = await api(null, 'GET', `/admin/members?q=${alice.id}`, null, headers);
  check(
    'an id matches exactly',
    (res.body?.data ?? []).length === 1 && res.body.data[0].id === alice.id,
    res.body?.data,
  );

  res = await api(
    null,
    'GET',
    `/admin/members?q=${encodeURIComponent(alice.email)}`,
    null,
    headers,
  );
  check(
    'an exact email matches for a caller who may reveal',
    (res.body?.data ?? []).length === 1 && res.body.data[0].id === alice.id,
    res.body?.data,
  );

  res = await api(
    null,
    'GET',
    `/admin/members?q=${encodeURIComponent(alice.email)}`,
    null,
    safetyHeaders,
  );
  check(
    'and matches nothing for a caller who may not — the list cannot confirm an address',
    res.status === 200 && (res.body?.data ?? []).length === 0,
    res.body?.data,
  );

  res = await api(null, 'POST', '/admin/members/search', { q: 'E2E alice', perPage: 10 }, headers);
  check(
    'POST search takes the same filters in the body',
    res.status === 200 && (res.body?.data ?? []).some(row => row.id === alice.id),
    res.body?.data?.length,
  );

  res = await api(
    null,
    'POST',
    '/admin/members/search',
    { cityIds: ['LONDON', 'MANCHESTER'], perPage: 100 },
    headers,
  );
  check(
    'and takes a JSON array where the query string takes a CSV',
    res.status === 200 && (res.body?.data ?? []).some(row => row.id === bob.id),
    res.body?.meta,
  );

  console.log('\n— Sorting —');

  res = await api(null, 'GET', '/admin/members?sort=notAColumn', null, headers);
  check(
    'an unknown sort field is refused rather than ignored',
    res.status === 400,
    res.body?.error,
  );

  await prisma.strike.createMany({
    data: [1, 2].map(() => ({
      userId: bob.id,
      reasonCode: 'POLICY_VIOLATION',
      sourceType: 'MANUAL',
      issuedById: admin.id,
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
    })),
  });
  // One that no longer counts, to prove the sort and the column mean "active".
  await prisma.strike.create({
    data: {
      userId: alice.id,
      reasonCode: 'POLICY_VIOLATION',
      sourceType: 'MANUAL',
      issuedById: admin.id,
      expiresAt: new Date(Date.now() - 86_400_000),
    },
  });

  res = await api(null, 'GET', '/admin/members?sort=strikes&order=desc&perPage=100', null, headers);
  const ordered = res.body?.data ?? [];
  check(
    'sorting by strikes puts the member with two at the top',
    ordered[0]?.id === bob.id && ordered[0]?.activeStrikes === 2,
    ordered.slice(0, 2),
  );
  check(
    'an expired strike does not count',
    ordered.find(row => row.id === alice.id)?.activeStrikes === 0,
    ordered.find(row => row.id === alice.id)?.activeStrikes,
  );

  res = await api(null, 'GET', '/admin/members?hasStrikes=true&perPage=100', null, headers);
  check(
    'hasStrikes=true means live strikes only',
    (res.body?.data ?? []).some(row => row.id === bob.id) &&
      !(res.body?.data ?? []).some(row => row.id === alice.id),
    res.body?.data?.length,
  );

  res = await api(null, 'GET', '/admin/members?hasStrikes=false&perPage=100', null, headers);
  check(
    'and hasStrikes=false is its complement',
    !(res.body?.data ?? []).some(row => row.id === bob.id) &&
      (res.body?.data ?? []).some(row => row.id === alice.id),
    res.body?.data?.length,
  );

  console.log('\n— Detail —');

  res = await api(null, 'GET', `/admin/members/${bob.id}`, null, headers);
  check('the detail page answers', res.status === 200, res.body);

  const detail = res.body?.data;

  check(
    'with a masked phone where there is one',
    detail?.phoneMasked === null,
    detail?.phoneMasked,
  );
  check(
    'and the counts of what they have made',
    detail?.counts && detail.counts.requests === 0 && detail.counts.groups === 0,
    detail?.counts,
  );
  check(
    'and a null rating average rather than a zero',
    detail?.counts?.ratingAverage === null,
    detail?.counts?.ratingAverage,
  );
  check(
    'and the four open-case badges',
    !!detail?.openCases &&
      typeof detail.openCases.reports === 'number' &&
      typeof detail.openCases.support === 'number',
    detail?.openCases,
  );
  check('and the live strike count', detail?.activeStrikes === 2, detail?.activeStrikes);
  check(
    'and no suggestion to suspend at two strikes of three',
    detail?.suggestSuspension === false,
    detail?.suggestSuspension,
  );

  await prisma.strike.create({
    data: {
      userId: bob.id,
      reasonCode: 'POLICY_VIOLATION',
      sourceType: 'MANUAL',
      issuedById: admin.id,
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
    },
  });

  res = await api(null, 'GET', `/admin/members/${bob.id}`, null, headers);
  check(
    'at three it suggests one — and nothing suspends itself',
    res.body?.data?.suggestSuspension === true && res.body?.data?.status === 'ACTIVE',
    { suggest: res.body?.data?.suggestSuspension, status: res.body?.data?.status },
  );

  const aliceDetail = (await api(null, 'GET', `/admin/members/${alice.id}`, null, headers)).body
    ?.data;

  check(
    'a phone number is masked down to its last three digits',
    aliceDetail?.phoneMasked === `+44 ${DOT.repeat(4)} ${DOT.repeat(3)} 456`,
    aliceDetail?.phoneMasked,
  );

  console.log('\n— Sessions —');

  res = await api(null, 'GET', `/admin/members/${alice.id}/sessions`, null, headers);
  check('sessions are listed', res.status === 200 && (res.body?.data ?? []).length >= 1, res.body);
  check(
    'with the IP reduced to its /24',
    res.body?.data?.[0]?.ipMasked === '127.0.0.x',
    res.body?.data?.[0],
  );
  check(
    'and no raw address anywhere in the payload',
    !JSON.stringify(res.body).includes('127.0.0.1'),
    res.body?.data?.[0],
  );

  console.log('\n— Reveal (S8.2) —');

  res = await api(
    null,
    'POST',
    `/admin/members/${alice.id}/reveal`,
    { fields: ['email'], reasonCode: 'SAFETY_CONCERN' },
    safetyHeaders,
  );
  check('a caller without members:pii_reveal is refused', res.status === 403, res.status);

  res = await api(
    null,
    'POST',
    `/admin/members/${alice.id}/reveal`,
    { fields: ['email'] },
    headers,
  );
  check(
    'a reveal with no reason code is refused, by its own error code',
    res.status === 422 && res.body?.error?.code === 'REASON_REQUIRED',
    res.body?.error,
  );

  res = await api(
    null,
    'POST',
    `/admin/members/${alice.id}/reveal`,
    { fields: ['email'], reasonCode: 'POLICY_VIOLATION' },
    headers,
  );
  check(
    'and "policy violation" with no policy named is refused too',
    res.status === 422 && res.body?.error?.code === 'REASON_REQUIRED',
    res.body?.error,
  );

  res = await api(
    null,
    'POST',
    `/admin/members/${alice.id}/reveal`,
    { fields: ['email'], reasonCode: 'POLICY_VIOLATION', policySubtype: 'IMPERSONATION' },
    headers,
  );
  check('naming the policy is enough', res.status === 200, res.body?.error);

  res = await api(
    null,
    'POST',
    `/admin/members/${alice.id}/reveal`,
    { fields: ['email', 'phone'], reasonCode: 'SAFETY_CONCERN', note: 'support call' },
    headers,
  );
  check(
    'a reveal returns the plaintext of the fields asked for',
    res.status === 200 &&
      res.body?.data?.email === alice.email &&
      res.body?.data?.phone === '+447911123456',
    res.body?.data,
  );
  check(
    'and nothing else — the date of birth was not asked for',
    res.body?.data?.dateOfBirth === undefined,
    res.body?.data,
  );
  check('and the response carries the audit id', !!res.body?.meta?.auditId, res.body?.meta);

  const entry = await prisma.auditLog.findUnique({ where: { id: res.body.meta.auditId } });

  check(
    'the audit entry names the action and the target',
    entry?.action === 'member.pii_reveal' && entry?.targetId === alice.id,
    entry?.action,
  );
  check(
    'and the fields that were uncovered',
    JSON.stringify(entry?.metadata ?? {}).includes('email'),
    entry?.metadata,
  );
  check(
    'and never the values',
    !JSON.stringify(entry ?? {}).includes(alice.email) &&
      !JSON.stringify(entry ?? {}).includes('7911123456'),
    entry?.metadata,
  );
  check(
    'and who looked, from the session context',
    entry?.actorId === admin.id && entry?.actorSessionId === admin.sessionId,
    entry?.actorId,
  );

  res = await api(
    null,
    'POST',
    `/admin/members/${alice.id}/reveal`,
    { fields: ['ip'], reasonCode: 'SAFETY_CONCERN' },
    headers,
  );
  check(
    'an IP reveal returns the addresses keyed by session',
    res.status === 200 && Object.values(res.body?.data?.ips ?? {}).includes('127.0.0.1'),
    res.body?.data,
  );

  res = await api(
    null,
    'POST',
    `/admin/members/${alice.id}/reveal`,
    { fields: ['nickname'], reasonCode: 'CORRECTION' },
    headers,
  );
  check('a field that is not revealable is refused', res.status === 400, res.body?.error);

  console.log('\n— Notes (§4.7) —');

  res = await api(
    null,
    'POST',
    `/admin/members/${alice.id}/notes`,
    { body: 'Called about a duplicate account.', isPinned: true },
    headers,
  );
  check('a note can be left about a member', res.status === 201, res.body);

  const noteId = res.body?.data?.id;

  check(
    'the note names its author',
    res.body?.data?.author?.id === admin.id,
    res.body?.data?.author,
  );
  check('and is pinned', res.body?.data?.isPinned === true, res.body?.data);

  res = await api(null, 'GET', `/admin/members/${alice.id}/notes`, null, headers);
  check(
    'the note is listed',
    (res.body?.data ?? []).some(note => note.id === noteId),
    res.body?.data,
  );

  res = await api(null, 'GET', `/admin/members/${alice.id}`, null, headers);
  check(
    'and a pinned note shows on the detail page',
    (res.body?.data?.pinnedNotes ?? []).some(note => note.id === noteId),
    res.body?.data?.pinnedNotes,
  );

  res = await api(
    null,
    'GET',
    `/admin/notes?subjectType=MEMBER&subjectId=${alice.id}`,
    null,
    headers,
  );
  check(
    'the generic endpoint serves the same note',
    (res.body?.data ?? []).some(note => note.id === noteId),
    res.body?.data,
  );

  res = await api(
    null,
    'GET',
    `/admin/notes?subjectType=GUARD_CASE&subjectId=${alice.id}`,
    null,
    supportHeaders,
  );
  check(
    'a caller without the subject’s read permission is refused',
    res.status === 403,
    res.status,
  );

  // R5 applies to a note's subject too. `subjectType: MEMBER` with a staff id is a well-formed
  // request, and answering it would route round Team: notes about a colleague, readable and
  // writable by anybody with `members:read`.
  res = await api(
    null,
    'GET',
    `/admin/notes?subjectType=MEMBER&subjectId=${admin.id}`,
    null,
    headers,
  );
  check('notes about a staff id are refused on read', res.status === 404, res.status);

  res = await api(
    null,
    'POST',
    '/admin/notes',
    { subjectType: 'MEMBER', subjectId: admin.id, body: 'About a colleague' },
    headers,
  );
  check('and on write', res.status === 404, res.status);

  res = await api(null, 'GET', `/admin/members/${ghost.id}/notes`, null, headers);
  check(
    'and notes on an anonymised account are gone with the account',
    res.status === 404,
    res.status,
  );

  res = await api(
    null,
    'POST',
    '/admin/notes',
    {
      subjectType: 'MEMBER',
      subjectId: '00000000-0000-0000-0000-000000000000',
      body: 'About nobody',
    },
    headers,
  );
  check(
    'a note about a subject that does not exist is refused',
    res.status === 404,
    res.body?.error,
  );

  res = await api(
    null,
    'POST',
    '/admin/notes',
    { subjectType: 'REPORT_CASE', subjectId: alice.id, body: 'A member id is not a case id' },
    headers,
  );
  // This used to be the `NOT_AVAILABLE_YET` check: report cases, escalations and support threads
  // had no tables, so a note against any of them was refused as early rather than as wrong. All
  // three shipped, so the refusal is now about the id — a member's id is not a case's — and the
  // "that section has not shipped" branch is left in place for the next subject type somebody
  // adds to the enum without adding it to the lookup.
  check(
    'a note about a case id that is not a case is refused',
    res.status === 404,
    res.body?.error,
  );

  res = await api(
    null,
    'PATCH',
    `/admin/notes/${noteId}`,
    { body: 'Corrected: two accounts.' },
    headers,
  );
  check('the author can edit their own note', res.status === 200, res.body);

  const updated = await prisma.auditLog.findFirst({
    where: { action: 'note.updated', targetId: alice.id },
    orderBy: { occurredAt: 'desc' },
  });

  check(
    'the edit records both versions',
    JSON.stringify(updated?.before ?? {}).includes('duplicate') &&
      JSON.stringify(updated?.after ?? {}).includes('Corrected'),
    { before: updated?.before, after: updated?.after },
  );

  res = await api(
    null,
    'PATCH',
    `/admin/notes/${noteId}`,
    { body: 'Not mine to change.' },
    supportHeaders,
  );
  check('somebody else cannot rewrite it', res.status === 403, res.status);

  res = await api(null, 'DELETE', `/admin/notes/${noteId}`, null, headers);
  check('and the author can withdraw it', res.status === 200, res.body);

  const soft = await prisma.internalNote.findUnique({ where: { id: noteId } });

  check('which is a soft delete — the row stays', !!soft?.deletedAt, soft?.deletedAt);

  res = await api(null, 'GET', `/admin/members/${alice.id}/notes`, null, headers);
  check(
    'and it is gone from the list',
    !(res.body?.data ?? []).some(note => note.id === noteId),
    res.body?.data,
  );

  console.log('\n— The guard stack still applies —');

  res = await api(null, 'GET', '/admin/members', null, {});
  check('no token, no list', res.status === 401 || res.status === 404, res.status);

  const plainMember = await api(alice.token, 'GET', '/admin/members');

  check(
    'a member token does not work here',
    plainMember.status === 401 || plainMember.status === 404,
    plainMember.status,
  );

  res = await api(null, 'GET', '/admin/members?perPage=500', null, headers);
  check('an over-large page size is refused rather than clamped', res.status === 400, res.status);

  res = await api(null, 'GET', '/admin/members?notAField=1', null, headers);
  check(
    'an unknown query field is refused by name',
    res.status === 400 && JSON.stringify(res.body).includes('notAField'),
    res.body?.error,
  );

  await sweep('admin-members');
  await finish();
})().catch(async error => {
  console.error(error);
  process.exit(1);
});
