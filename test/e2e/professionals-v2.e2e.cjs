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
      limits.maxServicesPerListing === 30 &&
      // The three the client asked us to either enforce or name (SERVICE-PRICING §2.2). Served,
      // so both sides read one number and raising it needs no app release.
      limits.maxServicePackages === 6 &&
      limits.maxServicePackageName === 60 &&
      limits.maxServicePackageDescription === 200 &&
      // What the profile gathers, so the client can word "and 6 more on their services" from the
      // same numbers we slice on (PROFILE-SERVICE-AGGREGATES §3.3).
      limits.maxProfileServiceMedia === 24 &&
      limits.maxProfileServiceUpdates === 10 &&
      limits.maxProfileServiceMilestones === 20,
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
    web?.price?.amount === 45000 && web?.priceLabel === '£450',
    { price: web?.price, label: web?.priceLabel },
  );
  /**
   * A flat rate is the price, not a floor.
   *
   * "Starts from £450" on a service with one price invites a buyer to expect it to climb, which
   * is a promise about somebody else's fee that we have no business making. The wording belongs
   * to the kind, and §7d below checks the other half of the rule.
   */
  check(
    'and a flat service is FLAT, with no packages and no fee',
    web?.pricingKind === 'FLAT' &&
      web?.packages?.length === 0 &&
      web?.packageCount === 0 &&
      web?.consultationFeePence === null &&
      web?.consultationFee === null,
    {
      kind: web?.pricingKind,
      packages: web?.packages,
      count: web?.packageCount,
      fee: web?.consultationFeePence,
    },
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

  /**
   * And it is nowhere on the profile either — not as a row, and not as its contents.
   *
   * The profile used to send **every** non-deleted service, so a stranger reading somebody's page
   * saw their draft, hidden and pending work beside their live offers. That was already a
   * disclosure, and gathering each service's media up to the profile would have made it a louder
   * one: an unverified immigration adviser whose photographs appear on their profile is an
   * unverified immigration adviser advertising (PROFILE-SERVICE-AGGREGATES §3.1).
   */
  const pendingPng = await uploadPng(pro.token, 'PROFESSIONAL', 800, 600);

  res = await api(
    pro.token,
    'PATCH',
    `/professionals/listings/${listingId}/services/${pending.id}`,
    {
      mediaKeys: [{ key: pendingPng, role: 'SHOWCASE' }],
      updates: [{ title: 'Taking new cases', body: 'I have room for two more applications.' }],
      milestones: [{ label: 'Admitted as a solicitor', year: 2017, issuer: 'SRA' }],
    },
  );

  check('the owner can still fill in a service that is waiting', res.status === 200, {
    status: res.status,
    error: res.body?.error,
  });

  res = await api(visitor.token, 'GET', `/professionals/${listingId}`);
  const strangerProfile = res.body?.data;

  check(
    'a stranger’s profile does not list the waiting service at all',
    res.status === 200 && !(strangerProfile?.services ?? []).some(row => row.id === pending.id),
    (strangerProfile?.services ?? []).map(row => row.name),
  );
  check(
    'nor any of its photographs, posts or claims',
    !(strangerProfile?.serviceMedia ?? []).some(item => item.serviceId === pending.id) &&
      !(strangerProfile?.serviceUpdates ?? []).some(item => item.serviceId === pending.id) &&
      !(strangerProfile?.serviceMilestones ?? []).some(item => item.serviceId === pending.id),
    {
      media: (strangerProfile?.serviceMedia ?? []).map(item => item.serviceName),
      updates: (strangerProfile?.serviceUpdates ?? []).map(item => item.serviceName),
      milestones: (strangerProfile?.serviceMilestones ?? []).map(item => item.serviceName),
    },
  );
  check(
    'and the counts beside them do not betray it either',
    (strangerProfile?.serviceMilestoneCount ?? 0) === 0,
    {
      mediaCount: strangerProfile?.serviceMediaCount,
      milestoneCount: strangerProfile?.serviceMilestoneCount,
    },
  );

  res = await api(pro.token, 'GET', `/professionals/${listingId}`);
  const ownProfile = res.body?.data;

  check(
    'while the owner sees their waiting service on their own profile',
    (ownProfile?.services ?? []).some(row => row.id === pending.id),
    (ownProfile?.services ?? []).map(row => row.name),
  );
  check(
    'with its photograph, its post and its claim, each naming the service',
    (ownProfile?.serviceMedia ?? []).some(item => item.serviceId === pending.id) &&
      (ownProfile?.serviceUpdates ?? []).some(
        item => item.serviceId === pending.id && item.serviceName === pending.name,
      ) &&
      (ownProfile?.serviceMilestones ?? []).some(item => item.label === 'Admitted as a solicitor'),
    {
      media: ownProfile?.serviceMedia,
      updates: ownProfile?.serviceUpdates,
      milestones: ownProfile?.serviceMilestones,
    },
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

  // ── 7d. Pricing: a flat rate, packages, and a consultation fee ────────────
  /**
   * SERVICE-PRICING, end to end.
   *
   * A service is priced **either** flat **or** in packages, never both, and the consultation fee
   * is a third decision independent of the other two. The rule that carries the most weight is
   * the one about the headline number: a card, a search row and a thread subject can each render
   * one figure and none of them can render a list, so `price` on a packaged service is the
   * cheapest package, **recomputed server-side on every write**. A client's own figure is a hint,
   * because a package added or deleted from anywhere else makes it stale and a stale one has the
   * card advertising a price the page does not offer.
   */
  heading('7d. one price or several, and a consultation that is neither');

  const packaged = async (over = {}) =>
    api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
      name: 'Brand photography day',
      description:
        'A full day on location, the edited photographs, and the licence to use them anywhere.',
      categoryCode: 'TECH_SOFTWARE',
      subcategoryCode: 'TECH_WEB',
      pricingKind: 'PACKAGES',
      packages: [
        { name: 'Half day', pricePence: 45000, description: 'Four hours and twenty photographs.' },
        { name: 'Full day', pricePence: 80000 },
        { name: 'Two days', pricePence: 150000 },
      ],
      ...over,
    });

  res = await packaged();
  const tiers = res.body?.data;

  check('a service can be created priced in packages', res.status === 201, {
    status: res.status,
    error: res.body?.error,
  });
  check(
    'and the three packages come back with ids, in the order they were sent',
    tiers?.packages?.length === 3 &&
      tiers.packages.every(entry => typeof entry.id === 'string' && entry.id.length > 0) &&
      tiers.packages.map(entry => entry.name).join('|') === 'Half day|Full day|Two days',
    tiers?.packages,
  );
  check(
    'each carrying its price both ways, and its sentence where it has one',
    tiers?.packages?.[0]?.pricePence === 45000 &&
      tiers?.packages?.[0]?.price?.amount === 45000 &&
      tiers?.packages?.[0]?.price?.currency === 'GBP' &&
      tiers?.packages?.[0]?.description?.startsWith('Four hours') &&
      tiers?.packages?.[1]?.description === null,
    tiers?.packages,
  );
  /**
   * The headline number, and the whole reason the server owns it.
   *
   * No `pricePence` was sent at all here — on a packaged write there is nothing for the client to
   * send that we would not throw away.
   */
  check(
    'the headline price is the cheapest package, worked out here',
    tiers?.price?.amount === 45000 && tiers?.packageCount === 3,
    { price: tiers?.price, count: tiers?.packageCount },
  );
  check(
    'and the wording is a floor, because the figure is the cheapest of several',
    tiers?.priceLabel === 'Starts from £450' && tiers?.pricingKind === 'PACKAGES',
    { label: tiers?.priceLabel, kind: tiers?.pricingKind },
  );

  // ── The client's own number is a hint, and only that ──
  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${tiers.id}`, {
    pricingKind: 'PACKAGES',
    pricePence: 1,
    packages: tiers.packages.map(entry => ({
      id: entry.id,
      name: entry.name,
      pricePence: entry.pricePence,
      description: entry.description ?? undefined,
    })),
  });

  check(
    'a pricePence the client insists on is ignored on a packaged write',
    res.status === 200 && res.body?.data?.price?.amount === 45000,
    { status: res.status, price: res.body?.data?.price, error: res.body?.error },
  );
  check(
    'and every package kept its id, so a link somebody already sent still resolves',
    (res.body?.data?.packages ?? []).map(entry => entry.id).join('|') ===
      tiers.packages.map(entry => entry.id).join('|'),
    {
      before: tiers.packages.map(entry => entry.id),
      after: (res.body?.data?.packages ?? []).map(entry => entry.id),
    },
  );

  // ── The whole set, in the professional's own order ──
  const kept = res.body?.data?.packages ?? [];

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${tiers.id}`, {
    packages: [
      // The dearest first, which is the professional's decision about what is read first.
      { id: kept[2].id, name: 'Two days', pricePence: 150000 },
      { id: kept[1].id, name: 'A full day on location', pricePence: 90000 },
      { name: 'An hour, for a headshot', pricePence: 12000 },
      // kept[0], the half day, is left out — which removes it.
    ],
  });
  const reordered = res.body?.data;

  check(
    'the array is the whole set: left out is removed, and a new one needs no id',
    res.status === 200 &&
      reordered?.packages?.length === 3 &&
      !reordered.packages.some(entry => entry.id === kept[0].id) &&
      reordered.packages.some(entry => entry.name === 'An hour, for a headshot'),
    { status: res.status, packages: reordered?.packages, error: res.body?.error },
  );
  /**
   * Returned in the order sent, not sorted.
   *
   * Sorting by price would be the obvious thing and the wrong one: the professional decides which
   * option is read first, and a list silently rearranged is one they have no way to explain.
   */
  check(
    'and in the order they arranged it, dearest first, not sorted by price',
    reordered?.packages?.map(entry => entry.pricePence).join(',') === '150000,90000,12000',
    reordered?.packages?.map(entry => [entry.name, entry.pricePence]),
  );
  check(
    'a rename and a re-price on a kept package land on the same row',
    reordered?.packages?.[1]?.id === kept[1].id &&
      reordered?.packages?.[1]?.name === 'A full day on location' &&
      reordered?.packages?.[1]?.pricePence === 90000,
    reordered?.packages?.[1],
  );
  check(
    'and the headline price followed the cheapest package down',
    reordered?.price?.amount === 12000 && reordered?.priceLabel === 'Starts from £120',
    { price: reordered?.price, label: reordered?.priceLabel },
  );

  // ── Refusals ──
  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${tiers.id}`, {
    packages: [
      { id: kept[0].id, name: 'The one that was removed', pricePence: 10000 },
      { id: reordered.packages[0].id, name: 'Two days', pricePence: 150000 },
    ],
  });

  /**
   * Refused, not ignored.
   *
   * An id this service does not hold means the client is working from a stale read. Applying the
   * rest of the set and dropping the unknown entry would remove a package the professional never
   * touched, which is the one outcome that must not happen.
   */
  check(
    'an id this service does not have is 422, naming it',
    res.status === 422 && (res.body?.data?.unknown ?? []).includes(kept[0].id),
    { status: res.status, code: res.body?.error?.code, data: res.body?.data },
  );

  res = await api(pro.token, 'GET', `/professionals/services/${tiers.id}`);

  check(
    'and the refused write changed nothing at all',
    res.body?.data?.packages?.length === 3 &&
      res.body?.data?.packages?.map(entry => entry.pricePence).join(',') === '150000,90000,12000',
    res.body?.data?.packages?.map(entry => [entry.name, entry.pricePence]),
  );

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${tiers.id}`, {
    pricingKind: 'PACKAGES',
    packages: [],
  });

  check('priced in packages with none written is refused', res.status === 422, {
    status: res.status,
    message: res.body?.error?.message,
  });

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${tiers.id}`, {
    pricingKind: 'FLAT',
    pricePence: 50000,
    packages: [{ name: 'Both at once', pricePence: 10000 }],
  });

  check(
    'and so is a flat rate sent beside a package list: a page cannot show both',
    res.status === 422,
    { status: res.status, message: res.body?.error?.message },
  );

  const flatOne = await api(
    pro.token,
    'POST',
    `/professionals/listings/${listingId}/services`,
    serviceBody({ name: 'A flat service that is sent packages' }),
  );

  res = await api(
    pro.token,
    'PATCH',
    `/professionals/listings/${listingId}/services/${flatOne.body?.data?.id}`,
    { packages: [{ name: 'Smuggled in', pricePence: 10000 }] },
  );

  /**
   * The same refusal, reached the other way.
   *
   * Packages sent to a flat service without saying the kind has changed would otherwise store a
   * service whose `pricingKind` is `FLAT`, whose price is the flat rate, and which nonetheless
   * reports three packages. A client reads that as a page with two prices on it.
   */
  check(
    'packages sent to a flat service without naming the kind are refused too',
    res.status === 422,
    { status: res.status, message: res.body?.error?.message },
  );

  await prisma.professionalService.deleteMany({ where: { id: flatOne.body?.data?.id } });

  res = await packaged({
    name: 'A service that names a package it cannot have',
    packages: [{ id: kept[1].id, name: 'Full day', pricePence: 80000 }],
  });

  check(
    'an id on a create names nothing, so it is refused there too',
    res.status === 422 && (res.body?.data?.ids ?? []).includes(kept[1].id),
    { status: res.status, data: res.body?.data },
  );

  res = await packaged({
    name: 'Seven packages',
    packages: Array.from({ length: 7 }, (_, index) => ({
      name: `Option ${index + 1}`,
      pricePence: 10000 * (index + 1),
    })),
  });

  check(
    'seven packages is one too many, and the cap is the server’s to hold',
    res.status === 400 || res.status === 422,
    { status: res.status, message: res.body?.error?.message },
  );

  res = await packaged({
    name: 'A package with no name',
    packages: [{ name: '', pricePence: 10000 }],
  });

  check('a package with no name is refused', res.status === 400 || res.status === 422, res.status);

  res = await packaged({
    name: 'A free package',
    packages: [{ name: 'Nothing at all', pricePence: 0 }],
  });

  check('and one priced at zero is refused', res.status === 400 || res.status === 422, res.status);

  res = await packaged({
    name: 'A package named at length',
    packages: [{ name: 'x'.repeat(61), pricePence: 10000 }],
  });

  /**
   * The other two caps the client asked us to hold (SERVICE-PRICING §2.2).
   *
   * They are also *served*, as `maxServicePackageName` and `maxServicePackageDescription`, so the
   * form and the write read one number — a limit only the client holds is one somebody gets past
   * with a replayed request, and one only the server holds is a refusal at save.
   */
  check(
    'a package name over sixty characters is refused',
    res.status === 400 || res.status === 422,
    {
      status: res.status,
      message: res.body?.error?.message,
    },
  );

  res = await packaged({
    name: 'A package described at length',
    packages: [{ name: 'Fine', pricePence: 10000, description: 'y'.repeat(201) }],
  });

  check('and a description over two hundred', res.status === 400 || res.status === 422, {
    status: res.status,
    message: res.body?.error?.message,
  });

  res = await packaged({
    name: 'A package right on both limits',
    packages: [{ name: 'z'.repeat(60), pricePence: 10000, description: 'w'.repeat(200) }],
  });

  // The boundary itself is allowed, or the served number would be a character out and every form
  // built against it would refuse a name the member was told they could use.
  check('while exactly sixty and exactly two hundred are allowed', res.status === 201, {
    status: res.status,
    error: res.body?.error,
  });

  await prisma.professionalService.deleteMany({ where: { id: res.body?.data?.id } });

  // ── The consultation fee: a third decision, and not part of the price ─────
  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${tiers.id}`, {
    consultationFeePence: 4000,
  });

  check(
    'a consultation fee is set on its own, with the packages untouched',
    res.status === 200 &&
      res.body?.data?.consultationFeePence === 4000 &&
      res.body?.data?.consultationFee?.amount === 4000 &&
      res.body?.data?.packages?.length === 3,
    {
      status: res.status,
      fee: res.body?.data?.consultationFeePence,
      packages: res.body?.data?.packages?.length,
      error: res.body?.error,
    },
  );
  /**
   * Never folded in, and never the cheapest package.
   *
   * £40 is less than the £120 hour, so a fee that leaked into the pricing would have taken the
   * headline figure down with it. A buyer reading one number for two things has been misled.
   */
  check(
    'and the price is still the cheapest package, not the fee',
    res.body?.data?.price?.amount === 12000 && res.body?.data?.priceLabel === 'Starts from £120',
    { price: res.body?.data?.price, label: res.body?.data?.priceLabel },
  );

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${tiers.id}`, {
    name: 'Brand photography',
  });

  check(
    'an edit that does not mention the fee leaves it alone',
    res.status === 200 && res.body?.data?.consultationFeePence === 4000,
    { status: res.status, fee: res.body?.data?.consultationFeePence },
  );

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${tiers.id}`, {
    consultationFeePence: null,
  });

  /**
   * An explicit null is a different claim from a £0 fee, and from an absent key.
   *
   * `null` is "this professional does not charge for a first conversation", which is not the same
   * as free — and `enableImplicitConversion` would have turned it into `0`, a fee the page would
   * print. `NullableNumber` in the DTO is what keeps the two apart.
   */
  check(
    'an explicit null removes the fee rather than setting it to nothing',
    res.status === 200 &&
      res.body?.data?.consultationFeePence === null &&
      res.body?.data?.consultationFee === null,
    { status: res.status, fee: res.body?.data?.consultationFeePence, error: res.body?.error },
  );

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${tiers.id}`, {
    consultationFeePence: 0,
  });

  check(
    'while a fee of nothing is refused: send null to mean no fee',
    res.status === 400 || res.status === 422,
    { status: res.status, message: res.body?.error?.message },
  );

  // ── The price filter reads the recomputed number ──
  res = await api(visitor.token, 'GET', '/professionals/services?maxPricePence=20000');

  check(
    'a price filter finds a packaged service by its cheapest package',
    (res.body?.data ?? []).some(row => row.id === tiers.id),
    {
      ids: (res.body?.data ?? []).map(row => [row.name, row.price?.amount]),
    },
  );

  // ── A card does not print a price list ───────────────────────────────────
  res = await api(visitor.token, 'GET', `/professionals/${listingId}`);
  const card = (res.body?.data?.services ?? []).find(row => row.id === tiers.id);

  check(
    'a profile card says how many packages there are rather than listing them',
    card?.pricingKind === 'PACKAGES' &&
      card?.packageCount === 3 &&
      card?.price?.amount === 12000 &&
      card?.consultationFeePence === null,
    card,
  );

  res = await api(pro.token, 'GET', '/professionals/me');
  const mine = (res.body?.data?.services ?? []).find(row => row.id === tiers.id);

  /**
   * The editor's own payload, which has to be the whole service.
   *
   * The editor opens on what `me` hands it and the first save writes that back, so a trimmed
   * payload here is a save that silently drops the packages it was never told about.
   */
  check(
    'while the owner’s own panel carries the packages in full, for the editor to open on',
    mine?.packages?.length === 3 &&
      mine.packages.map(entry => entry.pricePence).join(',') === '150000,90000,12000',
    mine?.packages,
  );

  // ── The thread strip about a packaged service ───────────────────────
  res = await api(visitor.token, 'POST', '/messages', {
    context: { kind: 'SERVICE', id: tiers.id },
  });

  /**
   * The strip is a record, and a record that says £120 for a service whose options run to £1,500
   * is a wrong one.
   *
   * It stores the service's own price, which on a packaged service is the cheapest package — the
   * only number a one-line strip can hold. "From" is the honest word for it. A flat service's
   * strip is unchanged and still reads the figure alone, which `section-workflows` holds.
   */
  check(
    'a thread about a packaged service says the figure is a floor',
    res.status === 201 && res.body?.data?.context?.trailing === 'From £120.00',
    { status: res.status, context: res.body?.data?.context, error: res.body?.error },
  );

  await prisma.conversation.deleteMany({ where: { contextId: tiers.id } });

  // ── The older bulk save, which would otherwise destroy the price list ────
  res = await api(pro.token, 'PUT', `/professionals/listings/${listingId}/services`, {
    services: [
      {
        name: 'Everything, one price',
        description: 'A bulk save from an old build.',
        price: 50000,
      },
    ],
  });

  /**
   * Refused, because this route deletes the rows and writes new ones.
   *
   * Its body cannot carry packages, so letting it through would hand the professional back
   * flat-rate services with new ids and no price list — silently, and with nothing to recover it
   * from. Stranding one screen on an old build is the better failure, and §10's rule about not
   * stranding older clients does not extend to letting one destroy data it cannot see.
   */
  check(
    'the older bulk save is refused while a service is priced in packages',
    res.status === 422 && res.body?.data?.packagedServices >= 1,
    { status: res.status, data: res.body?.data, message: res.body?.error?.message },
  );

  res = await api(pro.token, 'GET', `/professionals/services/${tiers.id}`);

  check(
    'and the packages it could not save are all still there',
    res.body?.data?.packages?.length === 3,
    res.body?.data?.packages?.map(entry => entry.name),
  );

  // ── Back to a flat rate ──────────────────────────────────────────────────
  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${tiers.id}`, {
    pricingKind: 'FLAT',
    pricePence: 60000,
    packages: [],
  });

  check(
    'moving back to a flat rate clears the packages and takes the price given',
    res.status === 200 &&
      res.body?.data?.pricingKind === 'FLAT' &&
      res.body?.data?.packages?.length === 0 &&
      res.body?.data?.packageCount === 0 &&
      res.body?.data?.price?.amount === 60000,
    {
      status: res.status,
      kind: res.body?.data?.pricingKind,
      packages: res.body?.data?.packages,
      price: res.body?.data?.price,
      error: res.body?.error,
    },
  );
  /**
   * The wording has to move with the kind.
   *
   * This is the failure SERVICE-PRICING §3 is about, in reverse: a service that was packaged at
   * £120 now priced flat at £600 must not still read "Starts from", and one that moves the other
   * way must not read as a fixed price.
   */
  check(
    'and the wording stops being a floor the moment the kind changes',
    res.body?.data?.priceLabel === '£600',
    res.body?.data?.priceLabel,
  );

  res = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${tiers.id}`, {
    pricingKind: 'FLAT',
    name: 'Brand photography, one price',
  });

  /**
   * The app sends `pricingKind` on **every** write, so this is the shape of most of them.
   *
   * A flat kind arriving with no price must not read as "clear the price": absent is not empty
   * here as everywhere else, and the first version of this read it the other way and would have
   * wiped the rate off any service whose owner was editing its name.
   */
  check(
    'a flat write that mentions no price leaves the price alone',
    res.status === 200 && res.body?.data?.price?.amount === 60000,
    { status: res.status, price: res.body?.data?.price, error: res.body?.error },
  );

  // ── A create that sets the fee, and a move to flat that names no price ────
  res = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'A consultation charged for from the start',
    description: 'Checking that a fee can be set on the create rather than only on a later edit.',
    categoryCode: 'TECH_SOFTWARE',
    subcategoryCode: 'TECH_WEB',
    pricePence: 30000,
    consultationFeePence: 2500,
  });
  const charged = res.body?.data;

  check(
    'a consultation fee can be set on the create, not only on an edit',
    res.status === 201 &&
      charged?.consultationFeePence === 2500 &&
      charged?.consultationFee?.amount === 2500 &&
      charged?.price?.amount === 30000,
    {
      status: res.status,
      fee: charged?.consultationFeePence,
      price: charged?.price,
      error: res.body?.error,
    },
  );

  const chargedPath = `/professionals/listings/${listingId}/services/${charged.id}`;

  res = await api(pro.token, 'PATCH', chargedPath, {
    pricingKind: 'PACKAGES',
    packages: [
      { name: 'The cheap one', pricePence: 11000 },
      { name: 'The dear one', pricePence: 90000 },
    ],
  });

  check(
    'a flat service moves to packages, and the price becomes the cheapest',
    res.status === 200 && res.body?.data?.price?.amount === 11000,
    { status: res.status, price: res.body?.data?.price, error: res.body?.error },
  );

  res = await api(pro.token, 'PATCH', chargedPath, {
    pricingKind: 'FLAT',
    packages: [],
  });

  /**
   * A move back to flat that names no price keeps the number the page was last showing.
   *
   * The alternative is nulling it, which would quietly turn a priced service into an "on request"
   * one. Carrying the last figure over is the smaller surprise: the cheapest package is what the
   * card was quoting a moment ago, so that is what the flat rate becomes until somebody edits it.
   */
  check(
    'and a move back to flat with no price keeps the figure the card was quoting',
    res.status === 200 &&
      res.body?.data?.pricingKind === 'FLAT' &&
      res.body?.data?.price?.amount === 11000 &&
      res.body?.data?.priceLabel === '£110' &&
      res.body?.data?.packageCount === 0,
    {
      status: res.status,
      kind: res.body?.data?.pricingKind,
      price: res.body?.data?.price,
      label: res.body?.data?.priceLabel,
      error: res.body?.error,
    },
  );
  check(
    'with the consultation fee untouched throughout: it is a separate decision',
    res.body?.data?.consultationFeePence === 2500,
    res.body?.data?.consultationFeePence,
  );

  await prisma.professionalService.deleteMany({ where: { id: charged.id } });

  await prisma.professionalService.deleteMany({ where: { id: tiers.id } });

  // ── 7e. Booking one package rather than the cheapest ──────────────────────
  /**
   * The figure a booking quotes has to be the one the buyer pressed.
   *
   * A service's stored price is its **cheapest** package, because that is the one number a card
   * can render. It is the wrong number for a booking: somebody who chose "Two days, £1,500" must
   * not be sent a booking that says £450, and neither must the professional. So the booking body
   * takes an optional `packageId`, and the name travels with the price as a snapshot — a record
   * that stays legible after the professional deletes the option it came from.
   */
  heading('7e. a booking quotes the package the buyer chose');

  res = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'Wedding photography',
    description: 'Coverage of the day, the edited photographs, and an album you can hold.',
    categoryCode: 'TECH_SOFTWARE',
    subcategoryCode: 'TECH_WEB',
    pricingKind: 'PACKAGES',
    packages: [
      { name: 'Half day', pricePence: 45000 },
      { name: 'Two days', pricePence: 150000, description: 'The day before as well.' },
    ],
  });
  const wedding = res.body?.data;
  const twoDays = wedding?.packages?.find(entry => entry.name === 'Two days');

  check(
    'a packaged service to book, whose headline price is the cheaper option',
    res.status === 201 && wedding?.price?.amount === 45000 && !!twoDays?.id,
    {
      status: res.status,
      price: wedding?.price,
      packages: wedding?.packages,
      error: res.body?.error,
    },
  );

  res = await api(visitor.token, 'POST', '/bookings', {
    listingId,
    serviceId: wedding.id,
    packageId: twoDays.id,
  });
  const booked = res.body?.data;

  check('a booking names the package it is for', res.status === 201, {
    status: res.status,
    error: res.body?.error,
  });
  check('and quotes that package, not the cheapest one', booked?.quotedAmount?.amount === 150000, {
    quoted: booked?.quotedAmount,
    error: res.body?.error,
  });
  check(
    'with the option recorded beside the service, both readable',
    booked?.serviceName === 'Wedding photography' &&
      booked?.package?.name === 'Two days' &&
      booked?.package?.id === twoDays.id,
    { serviceName: booked?.serviceName, package: booked?.package },
  );

  res = await api(visitor.token, 'GET', '/bookings?role=CLIENT');
  const row = (res.body?.data ?? []).find(entry => entry.id === booked?.id);

  check(
    'a list row carries the option too, so the client need not open it to see which',
    row?.packageName === 'Two days',
    row,
  );

  /**
   * A row has to carry a figure, and `agreedAmount` is not one.
   *
   * `agreedAmount` is optional on the create body, written once and never revised — so it is null
   * on every booking the app makes without asking the member to type a number. The row used to
   * carry only that, which left a packaged booking showing no price at all on the one screen a
   * client opens first. Both travel now, and `agreedAmount ?? quotedAmount` answers "the number
   * for this booking" on the row and the detail alike (SERVICE-PRICING-REPLY §3.1).
   */
  check(
    'and the figure it was booked at, which is the package price',
    row?.quotedAmount?.amount === 150000,
    { quoted: row?.quotedAmount, agreed: row?.agreedAmount },
  );
  check(
    'while agreedAmount stays null: nobody typed one, so there is nothing to report',
    row?.agreedAmount === null,
    row?.agreedAmount,
  );

  /**
   * The thread strip is what both of them read for the life of the booking.
   *
   * "Wedding photography" alone is ambiguous on a service with two options, and the strip is the
   * one line neither party can expand.
   */
  res = await api(visitor.token, 'GET', `/messages/${booked?.conversationId}`);

  check(
    'and the thread strip names the option, with that package’s price',
    res.body?.data?.context?.title === 'Wedding photography — Two days' &&
      res.body?.data?.context?.trailing === '£1500.00',
    res.body?.data?.context,
  );

  // ── Refusals ──
  res = await api(visitor.token, 'POST', '/bookings', {
    listingId,
    serviceId: wedding.id,
    packageId: '00000000-0000-4000-8000-000000000000',
  });

  /**
   * Refused rather than quietly booking the cheapest.
   *
   * An id that is not on this service means the professional removed that option since the page
   * loaded. Falling back to the service's own price would book somebody onto a figure they never
   * saw, which is worse than making them look at the options again — so the refusal hands back
   * the ones that do exist.
   */
  check(
    'a package that is not on the service is 422, with the options that are',
    res.status === 422 &&
      (res.body?.data?.available ?? []).some(entry => entry.name === 'Two days'),
    { status: res.status, data: res.body?.data },
  );

  res = await api(visitor.token, 'POST', '/bookings', {
    listingId,
    serviceId: web.id,
    packageId: twoDays.id,
  });

  check('a package on a flat-rate service names nothing, so it is refused', res.status === 422, {
    status: res.status,
    message: res.body?.error?.message,
  });

  res = await api(visitor.token, 'POST', '/bookings', { listingId, packageId: twoDays.id });

  check('and a package with no service is refused: a package belongs to one', res.status === 422, {
    status: res.status,
    message: res.body?.error?.message,
  });

  res = await api(visitor.token, 'POST', '/bookings', { listingId, serviceId: wedding.id });
  const unpackaged = res.body?.data;

  check(
    'booking a packaged service without choosing still works, at the cheapest',
    res.status === 201 &&
      unpackaged?.quotedAmount?.amount === 45000 &&
      unpackaged?.package === null,
    { status: res.status, quoted: unpackaged?.quotedAmount, package: unpackaged?.package },
  );

  /**
   * The snapshot outlives the row it came from.
   *
   * The professional removing an option must not take a booking's record with it — the id goes,
   * because it no longer names anything, and the name and the price stay, because what the two of
   * them agreed is still what they agreed.
   */
  await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${wedding.id}`, {
    packages: [
      {
        id: wedding.packages.find(entry => entry.name === 'Half day').id,
        name: 'Half day',
        pricePence: 45000,
      },
    ],
  });

  res = await api(visitor.token, 'GET', `/bookings/${booked?.id}`);

  check(
    'deleting the booked package leaves the booking legible: the name and price survive',
    res.body?.data?.package?.name === 'Two days' &&
      res.body?.data?.package?.id === null &&
      res.body?.data?.quotedAmount?.amount === 150000,
    { package: res.body?.data?.package, quoted: res.body?.data?.quotedAmount },
  );

  await prisma.booking.deleteMany({ where: { id: { in: [booked?.id, unpackaged?.id] } } });
  await prisma.professionalService.deleteMany({ where: { id: wedding.id } });

  // ── 7f. The profile gathers what the services carry ───────────────────────
  /**
   * A profile is where somebody decides, and the evidence was one tap further in.
   *
   * The photographs, the posts and the claimed credentials all live on a service, reachable only
   * by opening the services one at a time — so a visitor decided on a price list. The profile now
   * gathers all three up one level, flat, capped and attributed, and every item names the service
   * it came from because an unplaceable photograph on somebody's profile is a picture rather than
   * evidence (PROFILE-SERVICE-AGGREGATES).
   *
   * On its own service rather than on `web`, which later sections read for an exact media count.
   */
  heading('7f. a profile gathers its services’ work, attributed');

  const shotA = await uploadPng(pro.token, 'PROFESSIONAL', 1600, 1200);
  const shotB = await uploadPng(pro.token, 'PROFESSIONAL', 1200, 1600);

  res = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'Brand photography',
    description: 'A morning in your workplace, and the edited photographs a week later.',
    categoryCode: 'TECH_SOFTWARE',
    subcategoryCode: 'TECH_WEB',
    pricePence: 40000,
    mediaKeys: [
      { key: shotA, role: 'SHOWCASE' },
      { key: shotB, role: 'PROMO' },
    ],
    updates: [
      { title: 'Booked until March', body: 'I am taking work from the start of March.' },
      { title: 'New pricing', body: 'Smaller shoots now start lower than they did.' },
    ],
    // Deliberately not in year order: 2025 first, then 2017. A milestone is a claim rather than a
    // record, and sorting claims by date dresses them as one.
    milestones: [
      { label: '200 shoots delivered', year: 2025 },
      { label: 'First commercial client', year: 2017 },
    ],
  });
  const gallery = res.body?.data;

  check(
    'a second service carries work of its own',
    res.status === 201 && gallery?.media?.length === 2 && gallery?.updates?.length === 2,
    { status: res.status, error: res.body?.error },
  );

  /**
   * One update backdated, because `publishedAt` is stamped on write.
   *
   * Two updates written in the same request are a few milliseconds apart, which proves nothing
   * about ordering across services. Backdating the other service's post makes "newest first"
   * something the test can actually fail.
   */
  await prisma.serviceUpdate.updateMany({
    where: { serviceId: pending.id },
    data: { publishedAt: new Date('2026-01-04T09:00:00.000Z') },
  });

  res = await api(visitor.token, 'GET', `/professionals/${listingId}`);
  const gathered = res.body?.data;
  const media = gathered?.serviceMedia ?? [];
  const updates = gathered?.serviceUpdates ?? [];
  const milestones = gathered?.serviceMilestones ?? [];

  check(
    'the profile carries all three arrays, drawn from more than one service',
    res.status === 200 &&
      media.length >= 3 &&
      updates.length >= 3 &&
      milestones.length >= 3 &&
      new Set(media.map(item => item.serviceId)).size >= 2,
    {
      media: media.length,
      updates: updates.length,
      milestones: milestones.length,
      services: [...new Set(media.map(item => item.serviceName))],
    },
  );

  const listed = new Set((gathered?.services ?? []).map(row => row.id));

  check(
    'every item names a service the viewer can actually open',
    [...media, ...updates, ...milestones].every(
      item => !!item.serviceId && !!item.serviceName && listed.has(item.serviceId),
    ),
    [...media, ...updates, ...milestones]
      .filter(item => !item.serviceId || !listed.has(item.serviceId))
      .slice(0, 3),
  );
  check(
    'and the name is the service’s name as it is now, not a stored copy',
    media.every(
      item =>
        item.serviceName ===
        (gathered?.services ?? []).find(row => row.id === item.serviceId)?.name,
    ),
    media.map(item => item.serviceName),
  );

  // Service order, then the professional's own order inside each service: a photograph they chose
  // to lead their service should still lead it after being gathered up.
  const shots = media.filter(item => item.serviceId === gallery?.id);
  const firstShot = media.findIndex(item => item.serviceId === gallery?.id);

  check(
    'media keeps service order, then the order within each service',
    shots.length === 2 &&
      shots[0].role === 'SHOWCASE' &&
      shots[1].role === 'PROMO' &&
      media
        .slice(firstShot, firstShot + shots.length)
        .every(item => item.serviceId === gallery?.id),
    media.map(item => `${item.serviceName}:${item.role}`),
  );

  check(
    'updates are newest first across every service, so the backdated one is last',
    updates.every(
      (item, index) => index === 0 || item.publishedAt <= updates[index - 1].publishedAt,
    ) && updates[updates.length - 1].serviceId === pending.id,
    updates.map(item => `${item.serviceName}:${item.publishedAt}`),
  );

  const claims = milestones.filter(item => item.serviceId === gallery?.id);

  check(
    'milestones keep the professional’s order and are never sorted by year',
    claims.length === 2 && claims[0].year === 2025 && claims[1].year === 2017,
    milestones.map(item => `${item.label}:${item.year}`),
  );

  check(
    'each array carries its total, so a client can say how many more there are',
    gathered?.serviceMediaCount === media.length &&
      gathered?.serviceUpdateCount === updates.length &&
      gathered?.serviceMilestoneCount === milestones.length,
    {
      media: [media.length, gathered?.serviceMediaCount],
      updates: [updates.length, gathered?.serviceUpdateCount],
      milestones: [milestones.length, gathered?.serviceMilestoneCount],
    },
  );

  /**
   * The cap bites on the array and not on the count.
   *
   * Over the cap of ten, the client is sent ten and told the total, which is how it draws "and 2
   * more on their services" rather than truncating in silence.
   */
  const updatesBefore = gathered?.serviceUpdateCount ?? 0;

  await prisma.serviceUpdate.createMany({
    data: Array.from({ length: 9 }, (_, index) => ({
      serviceId: gallery?.id,
      body: `Filler post ${index + 1}, written to push the array past its cap.`,
      publishedAt: new Date(Date.now() - (index + 1) * 60_000),
    })),
  });

  res = await api(visitor.token, 'GET', `/professionals/${listingId}`);

  check(
    'over the cap, the array is cut and the total is not',
    res.body?.data?.serviceUpdates?.length === 10 &&
      res.body?.data?.serviceUpdateCount === updatesBefore + 9,
    {
      sent: res.body?.data?.serviceUpdates?.length,
      total: res.body?.data?.serviceUpdateCount,
      before: updatesBefore,
    },
  );
  check(
    'and what survives the cut is the newest, not the first ten found',
    (res.body?.data?.serviceUpdates ?? []).every(
      (item, index, all) => index === 0 || item.publishedAt <= all[index - 1].publishedAt,
    ) && !(res.body?.data?.serviceUpdates ?? []).some(item => item.serviceId === pending.id),
    (res.body?.data?.serviceUpdates ?? []).map(item => item.publishedAt),
  );

  await prisma.professionalService.deleteMany({ where: { id: gallery?.id } });

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
