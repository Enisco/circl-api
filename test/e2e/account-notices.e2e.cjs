/**
 * The three one-field answers from `BACKEND-TODO.md`: whether a decision went the member's way
 * (3.1), whether the address on the account is confirmed (3.5), and whether the professional's own
 * payload carries whole services or summaries of them (2.2).
 *
 * The first two are read by screens that otherwise have to guess. A verification result arrives as
 * `kind: MODERATION` whether it approved or refused, and the app was telling the two apart by
 * matching our own title templates — so "You are verified for Legal", the good news somebody
 * waited days for, rendered with a red warning rail the moment anybody edited the copy. And two
 * flows email the member and then ask them to wait for it, with nothing in any payload saying the
 * address works.
 */
const {
  adminHeaders,
  api,
  approveListing,
  check,
  clearRateLimits,
  fail,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
  uploadPng,
} = require('./harness.cjs');

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
const key = () => ({ 'Idempotency-Key': require('crypto').randomUUID() });

/** The fixed development code. Outside production every OTP is this one. */
const CODE = '111222';

(async () => {
  await sweep('account-notices');
  await clearRateLimits();

  const member = await makeUser('anmember');

  heading('1. Is the address on the account confirmed?');

  let r = await api(member.token, 'GET', '/users/profile');

  check(
    'the account payload says so, one way or the other',
    r.status === 200 && typeof r.body?.data?.isEmailVerified === 'boolean',
    { status: r.status, isEmailVerified: r.body?.data?.isEmailVerified },
  );

  await prisma.userAuth.updateMany({
    where: { userId: member.id },
    data: { emailVerifiedAt: null },
  });

  r = await api(member.token, 'GET', '/users/profile');

  check(
    'false for an address nobody has proved',
    r.body?.data?.isEmailVerified === false,
    r.body?.data?.isEmailVerified,
  );

  heading('2. Changing the sign-in address');

  const nextEmail = `e2e-anmember-moved-${Date.now()}@example.com`;

  r = await api(member.token, 'POST', '/users/me/email/change', { newEmail: nextEmail });

  check('the code goes to the new address', r.status === 202, {
    status: r.status,
    error: r.body?.error,
  });

  r = await api(member.token, 'POST', '/users/me/email/change/confirm', { code: CODE });

  check(
    'and confirming moves the account to it',
    r.status === 200 && r.body?.data?.email === nextEmail,
    {
      status: r.status,
      email: r.body?.data?.email,
      error: r.body?.error,
    },
  );

  r = await api(member.token, 'GET', '/users/profile');

  check(
    'the new address counts as confirmed, because the code just proved it',
    r.body?.data?.isEmailVerified === true,
    r.body?.data?.isEmailVerified,
  );

  heading('3. A decision that went against them');

  const admin = await makeAdmin('an-admin');
  const headers = adminHeaders(admin);

  r = await api(
    null,
    'POST',
    `/admin/members/${member.id}/warn`,
    {
      message: 'Please stop posting adverts.',
      reasonCode: 'POLICY_VIOLATION',
      policySubtype: 'SPAM',
    },
    { ...headers, ...key() },
  );

  check('a warning is issued', r.status === 200 || r.status === 201, r.body?.error);

  r = await api(member.token, 'GET', '/notifications');

  const warned = (r.body?.data ?? []).find(row => row.kind === 'MODERATION');

  check(
    'it reaches the member as a MODERATION row, as before',
    !!warned,
    (r.body?.data ?? []).map(row => row.kind),
  );
  check(
    'and the row says which way it went, without the client reading the title',
    warned?.outcome === 'REJECTED',
    { outcome: warned?.outcome, title: warned?.title },
  );

  heading('4. A decision that went their way');

  let r2 = await api(
    member.token,
    'POST',
    '/community/requests',
    {
      categoryCode: 'VISA_DOCS',
      title: 'Need help understanding my CoS letter',
      description:
        'I got my Certificate of Sponsorship last week and cannot make sense of the sponsor section.',
      cityId: 'MANCHESTER',
    },
    key(),
  );

  const requestId = r2.body?.data?.id;

  check('the member posts something', r2.status === 201 && !!requestId, r2.body?.error);

  r2 = await api(
    null,
    'POST',
    `/admin/content/requests/${requestId}/remove`,
    { reasonCode: 'POLICY_VIOLATION', policySubtype: 'SPAM', note: 'Reads as an advert.' },
    { ...headers, ...key() },
  );

  check('staff take it down', r2.status === 200, r2.body?.error);

  r2 = await api(
    null,
    'POST',
    `/admin/content/requests/${requestId}/restore`,
    { reasonCode: 'CORRECTION', note: 'Looked again — this is a genuine question.' },
    { ...headers, ...key() },
  );

  check('and then put it back', r2.status === 200, r2.body?.error);

  r = await api(member.token, 'GET', '/notifications');

  const rows = r.body?.data ?? [];

  check(
    'the good news carries outcome: APPROVED, so it is not drawn as an alarm',
    rows.some(row => row.outcome === 'APPROVED'),
    rows.map(row => ({ title: row.title, outcome: row.outcome })),
  );
  check(
    'the bad news beside it carries REJECTED',
    rows.some(row => row.outcome === 'REJECTED'),
    rows.map(row => ({ title: row.title, outcome: row.outcome })),
  );
  check(
    'and a row that reports no decision carries outcome: null rather than a default',
    rows.every(row => [null, 'APPROVED', 'REJECTED'].includes(row.outcome)),
    rows.map(row => row.outcome),
  );

  heading('5. The professional’s own services, in full');

  const pro = await makeUser('anpro', { bio: 'Immigration adviser, eight years.' });

  r = await api(pro.token, 'POST', '/professionals/listings', {
    categoryCodes: ['LEGAL'],
    professionTitle: 'Immigration Adviser',
    experienceLevel: 'EXPERT',
    about: 'Eight years on student and skilled worker applications, mostly in Manchester.',
    consentAccepted: true,
  });

  const listingId = r.body?.data?.listing?.id ?? r.body?.data?.id;

  await approveListing(listingId);

  const photo = await uploadPng(pro.token, 'PROFESSIONAL', 1200, 900);

  r = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'Skilled worker visa, end to end',
    description:
      'Eligibility, the sponsor certificate, the online form and the documents, start to finish.',
    categoryCode: 'LEGAL',
    subcategoryCode: 'LEGAL_EMPLOYMENT',
    pricePence: 95000,
    priceBasis: 'PER_JOB',
    mediaKeys: [{ key: photo, role: 'SHOWCASE' }],
    updates: [{ title: 'Fee change from April', body: 'The Home Office fee rises on 9 April.' }],
    milestones: [{ label: '200 applications supported', year: 2025 }],
  });

  check('a service with all four of its parts', r.status === 201, r.body?.error);

  r = await api(pro.token, 'GET', '/professionals/me');

  const service = (r.body?.data?.listing?.services ?? r.body?.data?.services ?? [])[0];

  check(
    'and /professionals/me carries them, rather than name, description and price alone',
    !!service?.category &&
      (service?.media ?? []).length === 1 &&
      (service?.updates ?? []).length === 1 &&
      (service?.milestones ?? []).length === 1,
    {
      category: service?.category,
      media: (service?.media ?? []).length,
      updates: (service?.updates ?? []).length,
      milestones: (service?.milestones ?? []).length,
    },
  );

  heading('6. Deleting the account takes a live export with it');

  const exporter = await makeUser('anexporter');

  await prisma.dataExportRequest.create({
    data: {
      userId: exporter.id,
      status: 'READY',
      downloadKey: `circl/exports/${exporter.id}/e2e-archive.zip`,
      readyAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });

  // What the checks recorded *about* their documents, which is not the same thing as the files.
  // BACKEND-TODO-UPDATED 0.3 question 5: the files were deleted and these numbers were not.
  await prisma.trustCheck.create({
    data: {
      userId: exporter.id,
      check: 'IDENTITY',
      status: 'VERIFIED',
      documentType: 'PASSPORT',
      issuingBody: 'HM Passport Office',
      reference: 'E2E-PASSPORT-9941772',
      checkedBy: 'Circl Trust & Safety',
      verifiedAt: new Date(),
    },
  });
  await prisma.categoryVerification.create({
    data: {
      userId: exporter.id,
      categoryCode: 'LEGAL',
      status: 'APPROVED',
      licenceSeen: 'SRA 884412, seen on the certificate',
      note: 'My practising certificate is attached.',
      decisionNote: 'Checked against the SRA register.',
      checkedBy: 'Circl Trust & Safety',
      decidedAt: new Date(),
    },
  });

  r = await api(exporter.token, 'POST', '/users/me/deletion/request');

  check('the member asks to be deleted', r.status === 200 || r.status === 201, r.body?.error);

  r = await api(exporter.token, 'POST', '/users/me/deletion/confirm', { code: CODE });

  check('and the deletion goes through', r.status === 200 || r.status === 204, {
    status: r.status,
    error: r.body?.error,
  });

  const left = await prisma.dataExportRequest.count({ where: { userId: exporter.id } });

  check(
    'the archive of their whole account does not outlive it behind an emailed link',
    left === 0,
    { left },
  );

  // Scoped to the check this section created: the platform keeps an automatic EMAIL check on every
  // account, and that one carries no document fields — so an unscoped read would pass this whether
  // the scrub ran or not.
  const trust = await prisma.trustCheck.findFirst({
    where: { userId: exporter.id, check: 'IDENTITY' },
  });
  const verification = await prisma.categoryVerification.findFirst({
    where: { userId: exporter.id },
  });

  check(
    'a passport number does not outlive the account the passport belonged to',
    trust !== null &&
      trust.reference === null &&
      trust.documentType === null &&
      trust.issuingBody === null,
    {
      reference: trust?.reference,
      documentType: trust?.documentType,
      issuingBody: trust?.issuingBody,
    },
  );

  check(
    'nor the licence number a reviewer read off a certificate, nor either side\u2019s words',
    verification !== null &&
      verification.licenceSeen === null &&
      verification.note === null &&
      verification.decisionNote === null,
    {
      licenceSeen: verification?.licenceSeen,
      note: verification?.note,
      decisionNote: verification?.decisionNote,
    },
  );

  check(
    'but the fact of the check survives, so a decision can still be answered for',
    trust?.status === 'VERIFIED' &&
      trust?.checkedBy === 'Circl Trust & Safety' &&
      verification?.status === 'APPROVED',
    { trust: trust?.status, verification: verification?.status, checkedBy: trust?.checkedBy },
  );

  const gone = await prisma.user.findUnique({
    where: { id: exporter.id },
    select: { isAnonymised: true },
  });

  check('and the account itself is gone', gone?.isAnonymised === true, gone);

  await sweep('account-notices');
  await finish();
})().catch(fail);
