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
      limits.maxItemPhotos === 5 &&
      limits.maxVideoSeconds === 60 &&
      limits.maxVideoBytes === 50 * 1024 * 1024 &&
      // The cap the client was holding its own copy of, until it was served (§8).
      limits.maxServicesPerListing === 30,
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
  const poster = await uploadPng(pro.token, 'PROFESSIONAL', 1080, 1920);

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${web.id}`, {
    mediaKeys: [
      { key: png, role: 'SHOWCASE' },
      { key: clip, role: 'TESTIMONIAL', posterKey: poster },
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
    'a service video carries its poster frame too, and the poster is not a second photo',
    /^https?:\/\//.test(
      res.body?.data?.media?.find(file => file.type === 'VIDEO')?.thumbnailUrl ?? '',
    ) && res.body?.data?.mediaCounts?.images === 1,
    res.body?.data?.media,
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
  const itemPoster = await uploadPng(seller.token, 'COMMERCE', 1080, 1920);

  res = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Jollof rice, party size',
    description: 'Cooked to order for ten to twelve people.',
    price: 4500,
    categoryCode: 'FOOD_GROCERIES',
    mediaKeys: [
      { key: itemPhoto, role: 'SHOWCASE' },
      // The poster the client is already showing in its picker. Nothing here derives a frame from
      // a video, so a tile without one is a grey box (§9.2).
      { key: itemClip, role: 'TESTIMONIAL', posterKey: itemPoster },
    ],
  });

  const itemId = res.body?.data?.id;

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

  const itemMedia = res.body?.data?.media ?? [];
  const itemVideo = itemMedia.find(file => file.type === 'VIDEO');

  check(
    'the video comes back with the poster frame as its thumbnail',
    typeof itemVideo?.thumbnailUrl === 'string' && /^https?:\/\//.test(itemVideo.thumbnailUrl),
    itemVideo,
  );
  check(
    'and the poster is not a sixth photograph in the gallery',
    itemMedia.filter(file => file.type === 'IMAGE').length === 1,
    itemMedia.map(file => `${file.type}:${file.role}`),
  );

  res = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'A poster on a photograph',
    description: 'Which is a client pairing two files up wrongly.',
    price: 100,
    categoryCode: 'FOOD_GROCERIES',
    mediaKeys: [{ key: itemPhoto, role: 'SHOWCASE', posterKey: itemPoster }],
  });

  check(
    'a poster sent for a photo is refused rather than silently dropped',
    res.status === 422,
    { status: res.status, message: res.body?.error?.message },
  );

  // The published video limits, actually enforced. `maxVideoBytes` is checked where the size is
  // declared — before a key is minted and before a byte is stored — because that is the only moment
  // the platform knows how big a file claims to be.
  res = await api(seller.token, 'POST', '/media/uploads', {
    purpose: 'COMMERCE',
    files: [{ mimeType: 'video/mp4', byteSize: 60 * 1024 * 1024, fileName: 'four-minutes.mp4' }],
  });

  check(
    'a product video over the published 50MB is refused at the upload, not at the attach',
    res.status === 422 && res.body?.error?.code === 'MEDIA_TOO_LARGE',
    { status: res.status, error: res.body?.error?.code },
  );

  res = await api(seller.token, 'POST', '/media/uploads', {
    purpose: 'CONNECT',
    files: [{ mimeType: 'video/mp4', byteSize: 60 * 1024 * 1024, fileName: 'a-story.mp4' }],
  });

  check(
    'while a Connect story keeps the looser cap it shipped with',
    res.status === 201,
    { status: res.status, error: res.body?.error },
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
    'a fourth video is refused by name, with the code §8 says to branch on',
    res.status === 422 &&
      res.body?.error?.code === 'MEDIA_LIMIT_REACHED' &&
      /video/i.test(res.body?.error?.message ?? ''),
    { status: res.status, code: res.body?.error?.code, message: res.body?.error?.message },
  );

  // ── 11. §7: nobody is asked to do it twice ────────────────────────────────
  heading('11. an approved listing review carries over to a verification');

  /**
   * The carry-over, run the way a deploy runs it.
   *
   * It lives in the seed rather than in the migration, and that is the thing worth pinning: the
   * rule reads the verification gates, the gates are **seeded**, and `start:prod` runs
   * `migrate deploy` before the app boots — so in the migration the rule saw no subcategories at
   * all and carried nothing over. Invisible on a fresh database, and wrong on the only database it
   * exists for.
   */
  const {
    carryOverListingApprovals,
  } = require('../../dist/prisma/seeders/verification-carryover.seeder.js');

  const legacy = await makeUser('pv2-legacy', { cityId: 'MANCHESTER' });
  const legacyListing = await api(
    legacy.token,
    'POST',
    '/professionals/listings',
    {
      professionTitle: 'Immigration Adviser',
      experienceLevel: 'MID_LEVEL',
      about: 'I have been doing family route applications for six years, mostly in Manchester.',
      categoryCodes: ['IMMIGRATION'],
      cityId: 'MANCHESTER',
      consentAccepted: true,
    },
  );
  const legacyListingId = legacyListing.body?.data?.listing?.id;

  check('a listing in a category with gated work exists', !!legacyListingId, legacyListing.body?.error);

  // The state v2 inherited: a review a human approved, with the documents it rested on. Written
  // directly because the flow that produced it is the one v2 replaced.
  const legacyDoc = await uploadDocument(legacy.token, { fileName: 'iaa-certificate.pdf' });

  await prisma.professionalListing.update({
    where: { id: legacyListingId },
    data: {
      reviewState: 'APPROVED',
      reviewSubmittedAt: new Date(Date.now() - 20 * 86_400_000),
      reviewDecidedAt: new Date(Date.now() - 14 * 86_400_000),
      reviewNote: 'IAA registration checked.',
    },
  });
  await prisma.media.update({
    where: { id: legacyDoc.id },
    data: {
      ownerType: 'LISTING_DOCUMENT',
      ownerId: legacyListingId,
      status: 'ATTACHED',
      attachedAt: new Date(Date.now() - 20 * 86_400_000),
    },
  });

  // And somebody approved under a profession no gated work sits under, who must not be handed a
  // badge nobody earned.
  const ungatedPro = await makeUser('pv2-legacy-tech', { cityId: 'MANCHESTER' });
  const ungatedListing = await api(ungatedPro.token, 'POST', '/professionals/listings', {
    professionTitle: 'React developer',
    experienceLevel: 'MID_LEVEL',
    about: 'I build web apps for small businesses, mostly React and Node, nine years of it.',
    categoryCodes: ['TECH_SOFTWARE'],
    cityId: 'MANCHESTER',
    consentAccepted: true,
  });

  await prisma.professionalListing.update({
    where: { id: ungatedListing.body?.data?.listing?.id },
    data: { reviewState: 'APPROVED', reviewDecidedAt: new Date() },
  });

  const carried = await carryOverListingApprovals(prisma);

  check(
    'the carry-over writes a verification and moves the documents',
    carried.verifications >= 1 && carried.documents >= 1,
    carried,
  );

  const carriedRecord = await prisma.categoryVerification.findUnique({
    where: { userId_categoryCode: { userId: legacy.id, categoryCode: 'IMMIGRATION' } },
  });

  check(
    'the professional is approved for the category they were reviewed under',
    carriedRecord?.status === 'APPROVED',
    carriedRecord?.status,
  );
  check(
    'with the original decision’s date rather than today’s',
    carriedRecord &&
      Date.now() - carriedRecord.decidedAt.getTime() > 13 * 86_400_000,
    carriedRecord?.decidedAt,
  );
  check(
    'the note says where the approval came from, and no licence is invented',
    /Carried over from the profile review/.test(carriedRecord?.note ?? '') &&
      carriedRecord?.licenceSeen === null &&
      carriedRecord?.checkedBy === 'Circl Trust & Safety',
    { note: carriedRecord?.note, licenceSeen: carriedRecord?.licenceSeen },
  );

  const movedDoc = await prisma.media.findUnique({
    where: { id: legacyDoc.id },
    select: { ownerType: true, ownerId: true },
  });

  check(
    'and the evidence is filed under the record that now carries the approval',
    movedDoc?.ownerType === 'CATEGORY_VERIFICATION' && movedDoc?.ownerId === carriedRecord?.id,
    movedDoc,
  );

  res = await api(legacy.token, 'GET', '/professionals/me/verifications');

  check(
    'the member sees it as theirs, with its document',
    res.body?.data?.[0]?.categoryCode === 'IMMIGRATION' &&
      res.body?.data?.[0]?.documentCount === 1,
    res.body?.data,
  );

  check(
    'nobody is approved for work that needed no approval',
    (await prisma.categoryVerification.count({ where: { userId: ungatedPro.id } })) === 0,
  );

  // Every boot runs it. The second run has to be a no-op, or a revocation would be undone by a
  // deploy.
  await prisma.categoryVerification.update({
    where: { id: carriedRecord.id },
    data: { status: 'REVOKED', decisionNote: 'Register says it lapsed.' },
  });

  const again = await carryOverListingApprovals(prisma);
  const afterSecondRun = await prisma.categoryVerification.findUnique({
    where: { id: carriedRecord.id },
    select: { status: true },
  });

  check(
    'running it again writes nothing and leaves a revocation revoked',
    again.verifications === 0 && afterSecondRun?.status === 'REVOKED',
    { again, status: afterSecondRun?.status },
  );

  await prisma.categoryVerification.deleteMany({
    where: { userId: { in: [legacy.id, ungatedPro.id] } },
  });

  // ── 12. What the portal has to be able to see and trust ───────────────────
  heading('12. the queue warns per member, and the content tool sees a service');

  /**
   * Two professionals waiting in the **same** category, with different numbers of services.
   *
   * The count beside each row is what a reviewer is warned with before they decide, and it was
   * grouped by category alone — so each of these two was told about the other's services as well
   * as their own. Two rows, two different right answers, is the only arrangement that catches it.
   */
  const queueA = await makeUser('pv2-queue-a', { cityId: 'MANCHESTER' });
  const queueB = await makeUser('pv2-queue-b', { cityId: 'MANCHESTER' });
  const waiting = async (user, services) => {
    const { id: listing } = await listingFor(user);

    await api(user.token, 'POST', '/professionals/me/verifications', {
      categoryCode: 'IMMIGRATION',
      documentIds: [(await uploadDocument(user.token, { fileName: 'iaa.pdf' })).id],
    });

    for (let index = 0; index < services; index += 1) {
      await api(user.token, 'POST', `/professionals/listings/${listing}/services`, {
        name: `Spouse visa help ${index + 1}`,
        description:
          'A full review of your application and the documents behind it before you submit it.',
        categoryCode: 'IMMIGRATION',
        subcategoryCode: 'IMMIGRATION_SOLICITOR',
        pricePence: 25000,
      });
    }

    return listing;
  };

  await waiting(queueA, 2);
  await waiting(queueB, 1);

  res = await api(null, 'GET', '/admin/verifications?status=PENDING&perPage=100', null, asStaff);

  const rowA = (res.body?.data ?? []).find(row => row.member?.id === queueA.id);
  const rowB = (res.body?.data ?? []).find(row => row.member?.id === queueB.id);

  check('both are in the queue', !!rowA && !!rowB, {
    rows: (res.body?.data ?? []).length,
  });
  check(
    'and each is warned about its own services only, not the other’s',
    rowA?.servicesInCategory === 2 && rowB?.servicesInCategory === 1,
    { a: rowA?.servicesInCategory, b: rowB?.servicesInCategory },
  );

  // A date in the past on a decision is refused here exactly as it is on the expiry route: it
  // would suspend the services it had just published.
  res = await api(
    null,
    'POST',
    `/admin/verifications/${rowA.id}/decide`,
    {
      decision: 'APPROVE',
      licenceSeen: 'IAA F2024-0001',
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
    { ...asStaff, ...key() },
  );

  check('a decision carrying a past expiry is refused', res.status === 422, {
    status: res.status,
    message: res.body?.error?.message,
  });

  const renewal = new Date(Date.now() + 365 * 86_400_000).toISOString();

  await api(
    null,
    'PATCH',
    `/admin/verifications/${rowA.id}/expiry`,
    { expiresAt: renewal },
    { ...asStaff, ...key() },
  );

  res = await api(
    null,
    'POST',
    `/admin/verifications/${rowA.id}/decide`,
    { decision: 'APPROVE', licenceSeen: 'IAA F2024-0001' },
    { ...asStaff, ...key() },
  );

  check(
    'the decision publishes exactly the services the warning named',
    res.status === 200 && res.body?.data?.servicesAffected === 2,
    { status: res.status, affected: res.body?.data?.servicesAffected, error: res.body?.error },
  );
  check(
    'and a decision that says nothing about the renewal date leaves it alone',
    res.body?.data?.expiresAt === renewal,
    { expected: renewal, got: res.body?.data?.expiresAt },
  );

  res = await api(
    null,
    'POST',
    `/admin/verifications/${rowA.id}/decide`,
    { decision: 'REJECT', note: 'Changed my mind about this one.' },
    { ...asStaff, ...key() },
  );

  check(
    'declining a live approval is refused: taking work down goes through revoke',
    res.status === 409 && res.body?.error?.code === 'ALREADY_DECIDED',
    { status: res.status, code: res.body?.error?.code },
  );

  // ── The content tool ──────────────────────────────────────────────────────
  res = await api(
    null,
    'GET',
    '/admin/content/services?categories=TECH_SOFTWARE&perPage=50',
    null,
    asStaff,
  );

  check(
    'services filter by the category they are sold under',
    res.status === 200 &&
      (res.body?.data ?? []).length > 0 &&
      (res.body?.data ?? []).every(row => row.category?.code === 'TECH_SOFTWARE'),
    { status: res.status, codes: (res.body?.data ?? []).map(row => row.category?.code).slice(0, 5) },
  );

  // A milestone back on it, because section 7 proved `[]` clears them and left it cleared. Both
  // kinds of self-reported content have to reach a reviewer, so both are on the service here.
  await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${web.id}`, {
    milestones: [{ label: '200 applications supported', year: 2025 }],
  });

  res = await api(null, 'GET', `/admin/content/services/${web.id}`, null, asStaff);
  const serviceDetail = res.body?.data;

  check(
    'a reviewer can see the media on a service, with the poster marked rather than counted',
    res.status === 200 &&
      serviceDetail?.media?.length === 3 &&
      serviceDetail?.mediaCounts?.images === 1 &&
      serviceDetail?.mediaCounts?.videos === 1 &&
      serviceDetail.media.filter(file => file.isPoster).length === 1,
    { status: res.status, counts: serviceDetail?.mediaCounts, media: serviceDetail?.media?.length },
  );
  check(
    'and the updates and milestones, named as the member’s own claims',
    serviceDetail?.selfReported?.updates?.length === 1 &&
      serviceDetail?.selfReported?.milestones?.length === 1,
    serviceDetail?.selfReported,
  );
  check(
    'the video carries what it is of, and how long it runs',
    serviceDetail?.media?.some(
      file => file.type === 'VIDEO' && file.role === 'TESTIMONIAL' && 'durationMs' in file,
    ),
    serviceDetail?.media?.filter(file => file.type === 'VIDEO'),
  );

  res = await api(null, 'GET', `/admin/content/items/${itemId}`, null, asStaff);
  const itemDetail = res.body?.data;

  check(
    'a product’s video reaches moderation with its role, and its poster is not a fourth photo',
    res.status === 200 &&
      itemDetail?.mediaCounts?.images === 1 &&
      itemDetail?.mediaCounts?.videos === 1 &&
      itemDetail?.media?.some(file => file.type === 'VIDEO' && file.role === 'TESTIMONIAL'),
    { status: res.status, counts: itemDetail?.mediaCounts, media: itemDetail?.media },
  );

  await prisma.categoryVerification.deleteMany({
    where: { userId: { in: [queueA.id, queueB.id] } },
  });

  await prisma.store.deleteMany({ where: { ownerId: seller.id } });
  await prisma.professionalListing.deleteMany({ where: { userId: pro.id } });
  await prisma.categoryVerification.deleteMany({ where: { userId: pro.id } });
  await sweep('professionals-v2');
  await finish();
}

main().catch(fail);
