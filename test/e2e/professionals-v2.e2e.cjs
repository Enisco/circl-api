/* Professionals v2 (BACKEND-PROFESSIONALS-V2.md), end to end.
 *
 * The inversion this checks is the one the whole note is about: a **service** is the thing members
 * search and judge, and a professional is the credential behind it. So most of what follows is
 * about the gate between the two — a `(professional, category)` verification — and the rule that
 * matters more than any other:
 *
 *   **Invisible means invisible.** A service whose category is not approved must not appear in
 *   search, in a list, on a profile, or in a direct fetch by anybody but its owner. An unverified
 *   immigration adviser visible with a small "in review" label is an unverified immigration
 *   adviser taking clients.
 *
 * Every refusal is asserted with its code and, where the note promises it, with `data` rather than
 * `details` — the client branches on those, so a 403 with the right status and the wrong shape is
 * a bug this suite exists to catch. */
const {
  adminHeaders,
  api,
  check,
  fail,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  realPng,
  sweep,
  uploadDocument,
  uploadPng,
  uploadStubVideo,
} = require('./harness.cjs');

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
const key = () => ({ 'Idempotency-Key': `pv2-${Math.random().toString(36).slice(2)}` });

/** A listing for somebody, in an ungated category. */
const listingFor = async user => {
  const made = await api(user.token, 'POST', '/professionals/listings', {
    categoryCodes: ['TECH_SOFTWARE'],
    professionTitle: 'Immigration and web work',
    experienceLevel: 'EXPERT',
    about: 'I help people with visa paperwork, and I build websites for small businesses.',
    cityId: 'MANCHESTER',
    deliveryMode: 'BOTH',
    consentAccepted: true,
  });

  return { status: made.status, id: made.body?.data?.listing?.id, error: made.body?.error };
};

async function main() {
  await sweep('pre-run');

  const pro = await makeUser('pv2-pro', { cityId: 'MANCHESTER' });
  const visitor = await makeUser('pv2-visitor', { cityId: 'MANCHESTER' });
  const boss = await makeAdmin('pv2-boss');
  const asStaff = adminHeaders(boss);

  // ── 1. The taxonomy everything else reads ─────────────────────────────────
  heading('1. categories, subcategories, gates, skills, limits');

  let res = await api(pro.token, 'GET', '/taxonomy');
  const professions = res.body?.data?.professions ?? [];
  const immigration = professions.find(term => term.code === 'IMMIGRATION');
  const skills = res.body?.data?.skills ?? [];
  const limits = res.body?.data?.limits ?? {};

  check('the taxonomy answers', res.status === 200, res.status);
  check(
    'professions carry their own subcategories rather than a parallel key',
    Array.isArray(immigration?.subcategories) && immigration.subcategories.length >= 8,
    immigration?.subcategories?.length,
  );
  check(
    'the gate is on the subcategory, not on the category',
    immigration?.requiresVerification === false &&
      immigration.subcategories.find(child => child.code === 'IMMIGRATION_SOLICITOR')
        ?.requiresVerification === true,
    {
      category: immigration?.requiresVerification,
      solicitor: immigration?.subcategories?.find(c => c.code === 'IMMIGRATION_SOLICITOR'),
    },
  );
  check(
    'and lived-experience guidance is deliberately not gated',
    immigration?.subcategories?.find(child => child.code === 'IMMIGRATION_LIVED_EXPERIENCE')
      ?.requiresVerification === false,
    immigration?.subcategories?.find(c => c.code === 'IMMIGRATION_LIVED_EXPERIENCE'),
  );
  check(
    'the old flag is still sent during the transition, and says no gate',
    immigration?.requiresReview === false,
    immigration?.requiresReview,
  );
  check(
    'a category with no children sends no empty array',
    professions.some(term => !('subcategories' in term)),
    professions
      .filter(term => !('subcategories' in term))
      .map(t => t.code)
      .slice(0, 3),
  );
  check(
    'retired categories are still served, so a listing that holds one still renders',
    professions.some(term => term.code === 'CLEANING' && term.isActive === false),
    professions.find(term => term.code === 'CLEANING'),
  );
  check(
    'skills are tagged with the categories they belong to',
    skills.length > 100 &&
      skills
        .find(skill => skill.code === 'ILR_APPLICATION')
        ?.categoryCodes?.includes('IMMIGRATION'),
    { count: skills.length, ilr: skills.find(s => s.code === 'ILR_APPLICATION') },
  );
  check(
    'and every limit the form enforces is sent',
    limits.maxServiceMedia === 10 &&
      limits.maxServiceVideos === 3 &&
      limits.minServiceDescription === 40 &&
      limits.maxServiceDescription === 1500 &&
      limits.maxSkills === 10 &&
      limits.maxCustomSkills === 3 &&
      limits.maxItemVideos === 3 &&
      limits.maxVideoSeconds === 60,
    limits,
  );

  // ── 2. The listing's own additions ────────────────────────────────────────
  heading('2. skills, contactable hours, and a freely editable profile');

  const created = await listingFor(pro);

  check('a listing is created', created.status === 201, created.error);

  const listingId = created.id;

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}`, {
    skillCodes: ['ILR_APPLICATION', 'SPOUSE_VISA'],
    customSkills: ['Self-sponsorship route'],
    contactHours: [
      { day: 'MONDAY', openMinutes: 0, closeMinutes: 1439 },
      { day: 'TUESDAY', openMinutes: 0, closeMinutes: 1439 },
      { day: 'WEDNESDAY', openMinutes: 0, closeMinutes: 1439 },
      { day: 'THURSDAY', openMinutes: 0, closeMinutes: 1439 },
      { day: 'FRIDAY', openMinutes: 0, closeMinutes: 1439 },
      { day: 'SATURDAY', openMinutes: 0, closeMinutes: 1439 },
      { day: 'SUNDAY', openMinutes: 0, closeMinutes: 1439 },
    ],
  });

  check('skills and hours are saved', res.status === 200, res.body?.error);

  res = await api(pro.token, 'GET', '/professionals/me');
  const me = res.body?.data;

  check(
    'coded skills come back with their labels, and the custom one beside them',
    me?.skills?.length === 2 &&
      me.skills[0].label === 'Indefinite leave to remain' &&
      me.customSkills?.length === 1,
    { skills: me?.skills, custom: me?.customSkills },
  );
  check(
    'and `isContactableNow` is the server’s answer, not the client’s',
    me?.contactHours?.length === 7 && me?.isContactableNow === true,
    { hours: me?.contactHours?.length, now: me?.isContactableNow },
  );

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}`, { priceFrom: 9900 });
  res = await api(pro.token, 'GET', '/professionals/me');

  check(
    'an edit that mentions neither leaves both alone — absent is not empty',
    res.body?.data?.skills?.length === 2 && res.body?.data?.customSkills?.length === 1,
    { skills: res.body?.data?.skills?.length, custom: res.body?.data?.customSkills?.length },
  );

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}`, {
    categoryCodes: ['TECH_SOFTWARE', 'IMMIGRATION'],
  });

  check(
    'a live listing can change its categories now, because holding one grants nothing',
    res.status === 200,
    { status: res.status, code: res.body?.error?.code },
  );

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}`, {
    skillCodes: [],
    customSkills: [],
  });
  res = await api(pro.token, 'GET', '/professionals/me');

  check(
    'while `[]` clears them',
    res.body?.data?.skills?.length === 0 && res.body?.data?.customSkills?.length === 0,
    { skills: res.body?.data?.skills, custom: res.body?.data?.customSkills },
  );

  // ── 3. Services, and the gate ─────────────────────────────────────────────
  heading('3. a service is a first-class object');

  const serviceBody = (over = {}) => ({
    name: 'A small business website',
    description:
      'Five pages, your own domain, and a contact form that emails you when somebody asks.',
    categoryCode: 'TECH_SOFTWARE',
    subcategoryCode: 'TECH_WEB',
    pricePence: 45000,
    ...over,
  });

  res = await api(
    pro.token,
    'POST',
    `/professionals/listings/${listingId}/services`,
    serviceBody(),
  );
  const web = res.body?.data;

  check(
    'an ungated service publishes immediately',
    res.status === 201 && web?.status === 'PUBLISHED',
    {
      status: res.status,
      serviceStatus: web?.status,
      error: res.body?.error,
    },
  );
  check(
    'with the price in pence and the wording the server owns',
    web?.price?.amount === 45000 && web?.priceLabel === 'Starts from £450',
    { price: web?.price, label: web?.priceLabel },
  );
  check(
    'its category and subcategory come back as code and label',
    web?.category?.code === 'TECH_SOFTWARE' && web?.subcategory?.label === 'Web development',
    { category: web?.category, subcategory: web?.subcategory },
  );
  check('and `viewer.isOwner` is on the read', web?.viewer?.isOwner === true, web?.viewer);
  check(
    'with nothing blocking it and no milestones section to render',
    web?.blockedBy === null && web?.milestones?.length === 0 && web?.updates?.length === 0,
    { blockedBy: web?.blockedBy, milestones: web?.milestones, updates: web?.updates },
  );

  res = await api(
    pro.token,
    'POST',
    `/professionals/listings/${listingId}/services`,
    serviceBody({ description: 'Too short.' }),
  );

  check(
    'a one-line description is refused: an offer has to say something',
    res.status === 400 || res.status === 422,
    { status: res.status, message: res.body?.error?.message },
  );

  res = await api(
    pro.token,
    'POST',
    `/professionals/listings/${listingId}/services`,
    serviceBody({ subcategoryCode: undefined }),
  );

  check(
    'a category with children needs one chosen → 422 SUBCATEGORY_REQUIRED',
    res.status === 422 && res.body?.error?.code === 'SUBCATEGORY_REQUIRED',
    { status: res.status, code: res.body?.error?.code },
  );

  res = await api(
    pro.token,
    'POST',
    `/professionals/listings/${listingId}/services`,
    serviceBody({ subcategoryCode: 'IMMIGRATION_SOLICITOR' }),
  );

  check(
    'and a subcategory from another category → 422 SUBCATEGORY_MISMATCH',
    res.status === 422 && res.body?.error?.code === 'SUBCATEGORY_MISMATCH',
    { status: res.status, code: res.body?.error?.code },
  );

  // ── 4. The verification gate ──────────────────────────────────────────────
  heading('4. regulated work, and the verification that unlocks it');

  const gated = () =>
    serviceBody({
      name: 'Spouse visa applications',
      description:
        'A full review of your application and supporting documents before you submit it.',
      categoryCode: 'IMMIGRATION',
      subcategoryCode: 'IMMIGRATION_SOLICITOR',
      pricePence: 25000,
    });

  res = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, gated());

  check(
    'selling regulated work unverified is 403 VERIFICATION_REQUIRED',
    res.status === 403 && res.body?.error?.code === 'VERIFICATION_REQUIRED',
    { status: res.status, code: res.body?.error?.code },
  );
  /**
   * In `data`, not in `details`.
   *
   * The envelope reads `details` as `{field, message}` pairs meant for a form, and a category code
   * in a `message` is a value sitting where a sentence belongs. The client reads `data.categoryCode`
   * in preference to the one on screen, because an edit that moves a service between categories is
   * refused over a category that need not be the one being shown.
   */
  check(
    'carrying the category it is objecting to in `data`',
    res.body?.data?.categoryCode === 'IMMIGRATION' &&
      res.body?.data?.subcategoryCode === 'IMMIGRATION_SOLICITOR' &&
      res.body?.data?.verificationStatus === 'NOT_SUBMITTED',
    res.body?.data,
  );

  // HEIC, which is what an iPhone produces and what the note asks us to accept.
  const heic = await uploadDocument(pro.token, {
    mimeType: 'image/heic',
    fileName: 'sra-certificate.heic',
    bytes: Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('heicmif1'),
      Buffer.alloc(256),
    ]),
  });

  check('a HEIC is accepted as a supporting document now', !!heic.id, heic.error ?? heic.status);

  const pdf = await uploadDocument(pro.token, { fileName: 'sra-certificate.pdf' });

  res = await api(
    pro.token,
    'POST',
    '/professionals/me/verifications',
    {
      categoryCode: 'IMMIGRATION',
      documentIds: [pdf.id, heic.id].filter(Boolean),
      subcategoryCodes: ['IMMIGRATION_SOLICITOR'],
      note: 'SRA 123456',
    },
    key(),
  );

  check(
    'documents are submitted → 202 PENDING',
    res.status === 202 && res.body?.data?.status === 'PENDING',
    {
      status: res.status,
      data: res.body?.data?.status,
      error: res.body?.error,
    },
  );

  const verificationId = res.body?.data?.id;

  res = await api(
    pro.token,
    'POST',
    '/professionals/me/verifications',
    { categoryCode: 'IMMIGRATION', documentIds: [pdf.id] },
    key(),
  );

  check(
    'submitting again while one is pending is 409 VERIFICATION_ALREADY_PENDING',
    res.status === 409 && res.body?.error?.code === 'VERIFICATION_ALREADY_PENDING',
    { status: res.status, code: res.body?.error?.code },
  );

  res = await api(pro.token, 'GET', '/professionals/me/verifications');

  check(
    'the owner sees their own record, with its documents counted',
    res.status === 200 && res.body?.data?.[0]?.documentCount === 2,
    res.body?.data,
  );

  res = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, gated());
  const pending = res.body?.data;

  check(
    'with a submission in review the service is created, not refused',
    res.status === 201 && pending?.status === 'PENDING_VERIFICATION',
    { status: res.status, serviceStatus: pending?.status, error: res.body?.error },
  );
  check(
    'and it says what is holding it, with the reviewer’s note when there is one',
    pending?.blockedBy?.categoryCode === 'IMMIGRATION' &&
      pending?.blockedBy?.verificationStatus === 'PENDING' &&
      pending?.isVerifiedCategory === false,
    pending?.blockedBy,
  );

  // ── 5. Invisible means invisible ──────────────────────────────────────────
  heading('5. a pending service is nowhere but its owner’s screen');

  res = await api(visitor.token, 'GET', `/professionals/services/${pending.id}`);

  check('a stranger asking for it directly gets 404, never 403', res.status === 404, {
    status: res.status,
    code: res.body?.error?.code,
  });

  res = await api(visitor.token, 'GET', `/professionals/${listingId}/services`);

  check(
    'it is absent from the professional’s public service list',
    res.status === 200 && !(res.body?.data ?? []).some(row => row.id === pending.id),
    (res.body?.data ?? []).map(row => `${row.name}:${row.status}`),
  );

  res = await api(pro.token, 'GET', `/professionals/${listingId}/services`);

  check(
    'while the owner sees it beside their live one',
    (res.body?.data ?? []).some(row => row.id === pending.id),
    (res.body?.data ?? []).map(row => `${row.name}:${row.status}`),
  );

  res = await api(visitor.token, 'GET', '/professionals/services?q=spouse%20visa&limit=20');

  check(
    'and it is not in the service search',
    res.status === 200 && !(res.body?.data ?? []).some(row => row.id === pending.id),
    (res.body?.data ?? []).map(row => row.name),
  );

  // ── 6. The decision, and what it does to every waiting service ────────────
  heading('6. one approval, every service in the category');

  res = await api(null, 'GET', `/admin/verifications?status=PENDING&perPage=20`, null, asStaff);
  const queued = (res.body?.data ?? []).find(row => row.id === verificationId);

  check('the review queue carries the submission', res.status === 200 && !!queued, {
    status: res.status,
    rows: res.body?.data?.length,
  });
  check(
    'with what a decision here would publish, so the screen can warn',
    queued?.servicesInCategory >= 1 && queued?.documentCount === 2,
    { services: queued?.servicesInCategory, documents: queued?.documentCount },
  );

  res = await api(null, 'GET', `/admin/verifications/${verificationId}`, null, asStaff);

  check(
    'the detail lists the documents as metadata, never a URL',
    res.status === 200 &&
      res.body?.data?.documents?.length === 2 &&
      !JSON.stringify(res.body.data.documents).includes('http'),
    res.body?.data?.documents,
  );
  check(
    'and what the member said the documents were for',
    res.body?.data?.submittedForSubcategories?.[0]?.code === 'IMMIGRATION_SOLICITOR',
    res.body?.data?.submittedForSubcategories,
  );

  res = await api(
    null,
    'POST',
    `/admin/verifications/${verificationId}/decide`,
    { decision: 'REJECT' },
    { ...asStaff, ...key() },
  );

  check(
    'a decline with no note is refused: it is the only thing that says what to fix',
    res.status === 422,
    { status: res.status, message: res.body?.error?.message },
  );

  res = await api(
    null,
    'POST',
    `/admin/verifications/${verificationId}/decide`,
    {
      decision: 'APPROVE',
      note: 'Checked against the SRA register. Thank you.',
      licenceSeen: 'SRA 123456, admitted 2019',
    },
    { ...asStaff, ...key() },
  );

  check('approving works', res.status === 200 && res.body?.data?.status === 'APPROVED', {
    status: res.status,
    error: res.body?.error,
  });
  check(
    'and says how many services it published',
    res.body?.data?.servicesAffected >= 1,
    res.body?.data?.servicesAffected,
  );

  res = await api(visitor.token, 'GET', `/professionals/services/${pending.id}`);

  check(
    'the waiting service is live, with nothing having walked it',
    res.status === 200 && res.body?.data?.status === 'PUBLISHED',
    { status: res.status, serviceStatus: res.body?.data?.status },
  );
  check(
    'it reads as a verified category, and carries the professional for the tile',
    res.body?.data?.isVerifiedCategory === true &&
      res.body?.data?.professional?.listingId === listingId &&
      res.body?.data?.viewer?.isOwner === false,
    { verified: res.body?.data?.isVerifiedCategory, pro: res.body?.data?.professional },
  );

  res = await api(visitor.token, 'GET', `/professionals/${listingId}`);

  check(
    'the public profile shows the approved category with its provenance',
    res.body?.data?.verifiedCategories?.[0]?.categoryCode === 'IMMIGRATION' &&
      !!res.body?.data?.verifiedCategories?.[0]?.verifiedAt &&
      res.body?.data?.verifiedCategories?.[0]?.checkedBy === 'Circl Trust & Safety',
    res.body?.data?.verifiedCategories,
  );
  check(
    'and never the pending or declined ones, nor any document',
    res.body?.data?.categoryVerifications === undefined,
    Object.keys(res.body?.data ?? {}).filter(field => field.includes('erification')),
  );

  res = await api(
    pro.token,
    'POST',
    '/professionals/me/verifications',
    { categoryCode: 'IMMIGRATION', documentIds: [pdf.id] },
    key(),
  );

  check(
    'and submitting for something already approved is 409, not a second review',
    res.status === 409 && res.body?.error?.code === 'VERIFICATION_ALREADY_APPROVED',
    { status: res.status, code: res.body?.error?.code },
  );

  // ── 7. Editing a service ──────────────────────────────────────────────────
  heading('7. absent is not empty');

  const png = await uploadPng(pro.token, 'PROFESSIONAL', 1200, 900);
  const clip = await uploadStubVideo(pro.token, 'PROFESSIONAL');

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${web.id}`, {
    mediaKeys: [
      { key: png, role: 'SHOWCASE' },
      { key: clip, role: 'TESTIMONIAL' },
    ],
    updates: [{ title: 'Fee change from April', body: 'The Home Office fee rises on 9 April.' }],
    milestones: [{ label: '200 applications supported', year: 2025 }],
  });

  check('media, updates and milestones are written', res.status === 200, res.body?.error);
  check(
    'the media carries its role, and the counts are split by kind',
    res.body?.data?.mediaCounts?.images === 1 &&
      res.body?.data?.mediaCounts?.videos === 1 &&
      res.body?.data?.media?.find(file => file.type === 'VIDEO')?.role === 'TESTIMONIAL',
    { counts: res.body?.data?.mediaCounts, media: res.body?.data?.media },
  );
  check(
    'a milestone with no issuer sends no issuer, rather than an empty one',
    res.body?.data?.milestones?.[0]?.issuer === null &&
      res.body?.data?.milestones?.[0]?.year === 2025,
    res.body?.data?.milestones,
  );

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${web.id}`, {
    name: 'A small business website, built in a week',
  });

  check(
    'an edit of only the name keeps the media, the updates and the milestones',
    res.status === 200 &&
      res.body?.data?.media?.length === 2 &&
      res.body?.data?.updates?.length === 1 &&
      res.body?.data?.milestones?.length === 1,
    {
      media: res.body?.data?.media?.length,
      updates: res.body?.data?.updates?.length,
      milestones: res.body?.data?.milestones?.length,
    },
  );

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${web.id}`, {
    milestones: [],
  });

  check(
    'while `[]` clears them, so the section stops rendering',
    res.body?.data?.milestones?.length === 0 && res.body?.data?.media?.length === 2,
    { milestones: res.body?.data?.milestones, media: res.body?.data?.media?.length },
  );

  res = await api(
    pro.token,
    'PATCH',
    `/professionals/listings/${listingId}/services/${web.id}/visibility`,
    { isVisible: false },
  );

  check('hiding is its own route', res.status === 200 && res.body?.data?.status === 'HIDDEN', {
    status: res.status,
    serviceStatus: res.body?.data?.status,
  });

  res = await api(visitor.token, 'GET', `/professionals/services/${web.id}`);

  check('and a hidden service is a 404 to everybody else', res.status === 404, res.status);

  res = await api(
    pro.token,
    'PATCH',
    `/professionals/listings/${listingId}/services/${web.id}/visibility`,
    { isVisible: true },
  );

  check(
    'showing it again publishes it',
    res.body?.data?.status === 'PUBLISHED',
    res.body?.data?.status,
  );

  // ── 7b. A renewal date that passes ────────────────────────────────────────
  heading('7b. an approval that lapses stops being permission');

  res = await api(
    null,
    'PATCH',
    `/admin/verifications/${verificationId}/expiry`,
    { expiresAt: new Date(Date.now() + 2_000).toISOString() },
    { ...asStaff, ...key() },
  );

  check('a renewal date can be set', res.status === 200, res.status || res.body?.error);

  // Deliberately two seconds, not a nightly job. The gate must treat a lapsed approval as lapsed
  // the moment it runs out: `verifications.expire` exists to make the stored status agree, not to
  // be the thing that enforces it.
  await new Promise(resolve => setTimeout(resolve, 2_500));

  res = await api(visitor.token, 'GET', `/professionals/services/${pending.id}`);

  check('once it has lapsed the regulated service is a 404 again', res.status === 404, res.status);

  res = await api(pro.token, 'GET', `/professionals/services/${pending.id}`);

  check(
    'and its owner is told it lapsed rather than that it was refused',
    res.body?.data?.status === 'SUSPENDED' &&
      res.body?.data?.blockedBy?.verificationStatus === 'EXPIRED',
    res.body?.data?.blockedBy,
  );

  res = await api(
    pro.token,
    'POST',
    '/professionals/me/verifications',
    {
      categoryCode: 'IMMIGRATION',
      documentIds: [(await uploadDocument(pro.token, { fileName: 'renewed.pdf' })).id],
    },
  );

  check(
    'a lapsed approval can be resubmitted, which "already approved" would have refused',
    res.status === 202,
    { status: res.status, error: res.body?.error },
  );

  // Back to where section 8 needs it: approved, with no renewal date.
  res = await api(
    null,
    'POST',
    `/admin/verifications/${verificationId}/decide`,
    { decision: 'APPROVE', licenceSeen: 'SRA 60051, renewed' },
    { ...asStaff, ...key() },
  );

  check(
    'and re-approving it publishes the category again',
    res.status === 200 && res.body?.data?.expiresAt === null,
    { status: res.status, expiresAt: res.body?.data?.expiresAt, error: res.body?.error },
  );

  res = await api(visitor.token, 'GET', `/professionals/services/${pending.id}`);

  check('so the service is public once more', res.status === 200, res.status);

  // ── 7c. A staff takedown is not a verification problem ────────────────────
  heading('7c. a service staff held says so, and does not blame the approval');

  res = await api(
    null,
    'POST',
    `/admin/content/services/${pending.id}/hide`,
    { reasonCode: 'POLICY_VIOLATION', policySubtype: 'MISLEADING', note: 'Checking a claim.' },
    { ...asStaff, ...key() },
  );

  check('staff can hold a service like any other content', res.status === 200, {
    status: res.status,
    error: res.body?.error,
  });

  res = await api(pro.token, 'GET', `/professionals/services/${pending.id}`);

  check(
    'its owner sees SUSPENDED with no blockedBy: the approval is not what is holding it',
    res.body?.data?.status === 'SUSPENDED' && res.body?.data?.blockedBy === null,
    { status: res.body?.data?.status, blockedBy: res.body?.data?.blockedBy },
  );

  res = await api(visitor.token, 'GET', `/professionals/services/${pending.id}`);

  check('and it is a 404 to everybody else', res.status === 404, res.status);

  /**
   * Released by **deciding the item the hold opened**, not by `restore`.
   *
   * A hide is not a decision — it opens a `FLAGGED_CONTENT` item so somebody has to finish the
   * thought — and `restore` is for content that was removed. Approving the item is what a
   * moderator actually does, so it is what this asserts.
   */
  res = await api(
    null,
    'GET',
    '/admin/moderation/queue?type=FLAGGED_CONTENT&perPage=100',
    undefined,
    asStaff,
  );
  const heldItem = (res.body?.data ?? []).find(item => item.content?.targetId === pending.id);

  check('the hold opened a queue item on the service', !!heldItem, {
    rows: res.body?.data?.length,
  });

  await api(
    null,
    'POST',
    `/admin/moderation/queue/${heldItem?.id}/claim`,
    {},
    { ...asStaff, ...key() },
  );

  res = await api(
    null,
    'POST',
    `/admin/moderation/queue/${heldItem?.id}/decide`,
    { decision: 'APPROVE', reasonCode: 'CORRECTION', note: 'The claim checked out.' },
    { ...asStaff, ...key() },
  );

  check('approving it lifts the hold', res.status === 200, res.status || res.body?.error);

  res = await api(visitor.token, 'GET', `/professionals/services/${pending.id}`);

  check('and the gate publishes it again, unchanged', res.status === 200, res.status);

  // ── 8. Revoking, and what it takes down ───────────────────────────────────
  heading('8. a revocation suspends every service in the category');

  res = await api(
    null,
    'POST',
    `/admin/verifications/${verificationId}/revoke`,
    { note: 'The registration has lapsed on the SRA register.' },
    { ...asStaff, ...key() },
  );

  check(
    'revoking says how many services it suspended',
    res.status === 200 && res.body?.data?.servicesSuspended >= 1,
    { status: res.status, suspended: res.body?.data?.servicesSuspended, error: res.body?.error },
  );

  res = await api(visitor.token, 'GET', `/professionals/services/${pending.id}`);

  check('the regulated service is gone from public view', res.status === 404, res.status);

  res = await api(pro.token, 'GET', `/professionals/services/${pending.id}`);

  check(
    'and its owner is told it is suspended, with the reviewer’s words',
    res.body?.data?.status === 'SUSPENDED' &&
      res.body?.data?.blockedBy?.verificationStatus === 'REVOKED' &&
      /lapsed/.test(res.body?.data?.blockedBy?.note ?? ''),
    res.body?.data?.blockedBy,
  );

  res = await api(visitor.token, 'GET', `/professionals/services/${web.id}`);

  check(
    'while their ungated service is untouched: the gate is per category',
    res.status === 200 && res.body?.data?.status === 'PUBLISHED',
    { status: res.status, serviceStatus: res.body?.data?.status },
  );

  res = await api(
    null,
    'PATCH',
    `/admin/verifications/${verificationId}/expiry`,
    { expiresAt: new Date(Date.now() - 86_400_000).toISOString() },
    { ...asStaff, ...key() },
  );

  check(
    'an expiry in the past is refused rather than silently suspending somebody',
    res.status === 422,
    { status: res.status, message: res.body?.error?.message },
  );

  // ── 8b. Turning a gate on from the portal ─────────────────────────────────
  heading('8b. the gate itself is an operator’s decision, with the cost shown');

  res = await api(
    null,
    'GET',
    '/admin/professional-reviews/verification-gates',
    undefined,
    asStaff,
  );
  const gateRows = res.body?.data ?? [];
  const gatedCodes = gateRows.filter(row => row.requiresVerification).map(row => row.code);
  const webGate = gateRows.find(row => row.code === 'TECH_WEB');

  check(
    'every subcategory is listed with its gate and its parent',
    res.status === 200 && gateRows.length > 100 && webGate?.parentCode === 'TECH_SOFTWARE',
    { status: res.status, rows: gateRows.length, web: webGate },
  );
  check(
    'and with what a change would cost: the live services under it',
    webGate?.services >= 1 && webGate?.servicesWithoutApproval >= 1,
    webGate,
  );

  const setGates = (codes, as) =>
    api(
      null,
      'PUT',
      '/admin/professional-reviews/verification-gates',
      { codes, reasonCode: 'SAFETY_CONCERN', note: 'e2e: proving the gate moves live work.' },
      { ...(as ?? asStaff), ...key() },
    );

  res = await setGates(gatedCodes, adminHeaders(await makeAdmin('pv2-support', 'support')));

  check('support cannot change a gate', res.status === 403, res.status);

  res = await setGates([...gatedCodes, 'TECH_WEB']);

  check(
    'gating one says how many live services just went out of sight',
    res.status === 200 &&
      res.body?.data?.applied?.gated?.includes('TECH_WEB') &&
      res.body?.data?.applied?.servicesBlocked >= 1,
    { status: res.status, applied: res.body?.data?.applied, error: res.body?.error },
  );

  res = await api(visitor.token, 'GET', `/professionals/services/${web.id}`);

  check('and the service nobody is approved for is a 404', res.status === 404, res.status);

  res = await api(pro.token, 'GET', `/professionals/services/${web.id}`);

  check(
    'while its owner is told what to do about it',
    res.body?.data?.status === 'PENDING_VERIFICATION' &&
      res.body?.data?.blockedBy?.categoryCode === 'TECH_SOFTWARE' &&
      res.body?.data?.blockedBy?.verificationStatus === 'NOT_SUBMITTED',
    res.body?.data?.blockedBy,
  );

  res = await setGates(gatedCodes);

  check(
    'ungating it publishes the same work again, and counts that too',
    res.status === 200 &&
      res.body?.data?.applied?.ungated?.includes('TECH_WEB') &&
      res.body?.data?.applied?.servicesPublished >= 1,
    res.body?.data?.applied,
  );

  res = await api(visitor.token, 'GET', `/professionals/services/${web.id}`);

  check('so the service is public again with nothing walked', res.status === 200, res.status);

  // ── 9. Search ─────────────────────────────────────────────────────────────
  heading('9. two result sets, each with its own total');

  res = await api(
    visitor.token,
    'GET',
    '/professionals/search?q=website&groups=SERVICE,PROFESSIONAL',
  );
  const groups = res.body?.data?.groups ?? [];

  check('the blended search answers with both groups', res.status === 200 && groups.length === 2, {
    status: res.status,
    groups: groups.map(group => group.type),
  });
  check(
    'each carrying the total match count rather than the number returned',
    groups.every(group => typeof group.meta?.totalCount === 'number'),
    groups.map(group => [group.type, group.items.length, group.meta?.totalCount]),
  );
  check(
    'a service row carries everything a list needs, with no follow-up call',
    (() => {
      const row = groups.find(group => group.type === 'SERVICE')?.items?.[0];

      return (
        !!row &&
        !!row.priceLabel &&
        !!row.category &&
        !!row.professional?.displayName &&
        typeof row.mediaCounts?.videos === 'number' &&
        row.viewer?.isOwner === false
      );
    })(),
    groups.find(group => group.type === 'SERVICE')?.items?.[0],
  );

  res = await api(visitor.token, 'GET', '/professionals/search?q=website&groups=SERVICE');

  check(
    'asking for one group answers with one',
    (res.body?.data?.groups ?? []).length === 1,
    (res.body?.data?.groups ?? []).map(group => group.type),
  );

  /**
   * The half that is the point of the feature: a professional found through the **names of their
   * services**, with the word nowhere on their profile. "Spouse visa" is in a service and not in
   * the headline or the about text.
   */
  res = await api(visitor.token, 'GET', '/professionals/search?q=spouse&groups=PROFESSIONAL');
  const people = res.body?.data?.groups?.find(group => group.type === 'PROFESSIONAL')?.items ?? [];

  check(
    'searching a word that only appears in a service surfaces the professional',
    people.some(row => row.id === listingId),
    people.map(row => row.professionTitle),
  );

  // ── 10. Marketplace video ─────────────────────────────────────────────────
  heading('10. video on a product');

  const seller = await makeUser('pv2-seller', { cityId: 'MANCHESTER' });

  res = await api(seller.token, 'POST', '/commerce/stores', {
    name: 'Mama Ngozi’s Kitchen',
    type: 'LOCAL',
    description: 'Fresh Nigerian groceries and prepared food, cooked the way it is at home.',
    area: 'Moss Side',
    delivers: false,
  });

  const storeId = res.body?.data?.id;

  check('a shop exists to sell from', res.status === 201 && !!storeId, res.body?.error);

  const itemPhoto = await uploadPng(seller.token, 'COMMERCE', 1000, 1000);
  const itemClip = await uploadStubVideo(seller.token, 'COMMERCE');

  res = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Jollof rice, party size',
    description: 'Cooked to order for ten to twelve people.',
    price: 4500,
    categoryCode: 'FOOD_GROCERIES',
    mediaKeys: [
      { key: itemPhoto, role: 'SHOWCASE' },
      { key: itemClip, role: 'TESTIMONIAL' },
    ],
  });

  check('a product takes photos and video together', res.status === 201, res.body?.error);
  check(
    'and `photos` stays images-only while `media` carries both',
    res.body?.data?.photos?.length === 1 &&
      res.body?.data?.media?.length === 2 &&
      res.body?.data?.mediaCounts?.videos === 1,
    {
      photos: res.body?.data?.photos?.length,
      media: res.body?.data?.media,
      counts: res.body?.data?.mediaCounts,
    },
  );

  const tooMany = [];

  for (let index = 0; index < 4; index += 1) {
    tooMany.push({ key: await uploadStubVideo(seller.token, 'COMMERCE'), role: 'SHOWCASE' });
  }

  res = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Too many clips',
    description: 'Four videos, which is one more than the limit.',
    price: 100,
    categoryCode: 'FOOD_GROCERIES',
    mediaKeys: tooMany,
  });

  check(
    'a fourth video is refused by name',
    res.status === 422 && /video/i.test(res.body?.error?.message ?? ''),
    { status: res.status, message: res.body?.error?.message },
  );

  await prisma.store.deleteMany({ where: { ownerId: seller.id } });
  await prisma.professionalListing.deleteMany({ where: { userId: pro.id } });
  await prisma.categoryVerification.deleteMany({ where: { userId: pro.id } });
  await sweep('professionals-v2');
  await finish();
}

main().catch(fail);
