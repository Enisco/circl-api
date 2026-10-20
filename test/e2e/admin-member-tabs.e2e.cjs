/* The member detail page's tabs.
 *
 * Fourteen endpoints behind one page, and the thing worth checking about each is not that it
 * answers — it is what it refuses. The threads tab must never carry a message body; the reports tab
 * must hide who reported somebody from a caller who only has `reports:read`; the blocks tab is
 * behind a different permission from the rest of the page; the audit tab must scope in the query
 * rather than trust the portal to hide rows it has already sent. Those four are the file. */
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

(async () => {
  await sweep('admin-member-tabs');
  await clearRateLimits();

  const admin = await makeAdmin('tabs-admin');
  const headers = adminHeaders(admin);
  const safety = await makeAdmin('tabs-safety', 'trust_safety');
  const safetyHeaders = adminHeaders(safety);
  const support = await makeAdmin('tabs-support', 'support');
  const supportHeaders = adminHeaders(support);

  const member = await makeUser('tabs-member', {
    cityId: 'LONDON',
    gender: 'FEMALE',
    dateOfBirth: new Date('1990-04-10'),
    countryOfOriginCode: 'NG',
    journeyStage: 'SETTLING_IN',
    heritageTag: 'WEST_AFRICAN',
    languages: ['ENGLISH'],
    interests: ['FOOD_COOKING'],
    headline: 'Caterer',
    bio: 'I cook.',
    onboardingCompleted: true,
    phoneNumberDiallingCode: '+44',
    phoneNumber: '7911123456',
  });
  const other = await makeUser('tabs-other');

  console.log('\n— Profile —');

  let res = await api(null, 'GET', `/admin/members/${member.id}/profile`, null, headers);
  check('the profile answers', res.status === 200, res.body);
  check(
    'contact details are masked',
    !!res.body?.data?.emailMasked && !JSON.stringify(res.body.data).includes(member.email),
    res.body?.data?.emailMasked,
  );
  check(
    'the date of birth is a band, never the date',
    !!res.body?.data?.ageBand && !JSON.stringify(res.body.data).includes('1990-04-10'),
    res.body?.data?.ageBand,
  );
  check(
    'and the fact that one is set is stated separately',
    res.body?.data?.dateOfBirthSet === true,
    res.body?.data?.dateOfBirthSet,
  );
  check(
    'the dialling code is shown while the number is masked',
    res.body?.data?.phoneNumberDiallingCode === '+44' &&
      !JSON.stringify(res.body.data).includes('7911123456'),
    { code: res.body?.data?.phoneNumberDiallingCode, masked: res.body?.data?.phoneMasked },
  );
  check(
    'JSON array columns come back as arrays of codes',
    Array.isArray(res.body?.data?.interests) && res.body.data.interests.includes('FOOD_COOKING'),
    res.body?.data?.interests,
  );

  check(
    'a super admin may edit the date of birth',
    (res.body?.data?.editableFields ?? []).includes('dateOfBirth'),
    res.body?.data?.editableFields,
  );

  res = await api(null, 'GET', `/admin/members/${member.id}/profile`, null, supportHeaders);
  check(
    'support may edit names but not the date of birth',
    (res.body?.data?.editableFields ?? []).includes('firstName') &&
      !(res.body?.data?.editableFields ?? []).includes('dateOfBirth'),
    res.body?.data?.editableFields,
  );

  res = await api(null, 'GET', `/admin/members/${member.id}/profile`, null, safetyHeaders);
  check(
    'trust & safety get the avatar and nothing else',
    JSON.stringify(res.body?.data?.editableFields) === JSON.stringify(['removeAvatar']),
    res.body?.data?.editableFields,
  );

  console.log('\n— Sections —');

  res = await api(null, 'GET', `/admin/members/${member.id}/sections`, null, headers);
  check('sections answer', res.status === 200, res.body);
  check(
    'community counts are always present',
    typeof res.body?.data?.community?.requests === 'number',
    res.body?.data?.community,
  );
  check(
    'a section the member is not in is null, not zeroed — "no listing" and "a listing with no ' +
      'jobs" are different facts',
    res.body?.data?.professional === null &&
      res.body?.data?.connect === null &&
      res.body?.data?.store === null,
    { professional: res.body?.data?.professional, store: res.body?.data?.store },
  );

  // A member in all three sections. Without this the three summary blocks are only ever exercised
  // as `null`, and so are the two content arms that reach their tables through a join — which is
  // exactly where a wrong column name hides.
  const listing = await prisma.professionalListing.create({
    data: {
      userId: member.id,
      professionTitle: 'Caterer',
      cityId: 'LONDON',
      about: 'I cook.',
      experienceLevel: 'MID_LEVEL',
    },
  });
  const connect = await prisma.connectProfile.create({
    data: { userId: member.id, typeCode: 'FRIENDSHIP', lookingFor: 'Friends in London' },
  });
  const shop = await prisma.store.create({
    data: {
      ownerId: member.id,
      name: 'E2E tabs shop',
      description: 'A shop for the tabs suite.',
      cityId: 'LONDON',
      area: 'Peckham',
    },
  });

  await prisma.storeItem.create({
    data: { storeId: shop.id, name: 'Jollof rice', price: 800, categoryCode: 'FOOD_DRINK' },
  });
  await prisma.connectPost.create({
    data: { profileId: connect.id, kind: 'PHOTO', caption: 'A photo' },
  });
  await prisma.enquiry.create({
    data: {
      storeId: shop.id,
      buyerId: other.id,
      sellerId: member.id,
      reference: `E2E-${Date.now()}`,
      fulfilment: 'COLLECTION',
      estimatedTotal: 800,
    },
  });

  res = await api(null, 'GET', `/admin/members/${member.id}/sections`, null, headers);
  check(
    'the professional block reports the listing',
    res.body?.data?.professional?.listingId === listing.id &&
      res.body.data.professional.professionTitle === 'Caterer',
    res.body?.data?.professional,
  );
  check(
    'the Connect block counts posts through the profile',
    res.body?.data?.connect?.connectionType === 'FRIENDSHIP' && res.body.data.connect.posts === 1,
    res.body?.data?.connect,
  );
  check(
    'and the shop block counts items and enquiries',
    res.body?.data?.store?.items === 1 && res.body.data.store.enquiries === 1,
    res.body?.data?.store,
  );

  console.log('\n— Activity —');

  res = await api(null, 'GET', `/admin/members/${member.id}/activity`, null, headers);
  check('the timeline answers', res.status === 200, res.body);

  const items = res.body?.data ?? [];

  check(
    'it includes the sign-up',
    items.some(item => item.type === 'SIGNUP'),
    items.map(i => i.type),
  );
  check(
    'and the session the harness created reads as a sign-in',
    items.some(item => item.type === 'LOGIN'),
    items.map(i => i.type),
  );
  check(
    'every row has a sentence rather than an enum',
    items.every(item => typeof item.label === 'string' && item.label.length > 3),
    items.slice(0, 3),
  );
  check(
    'newest first',
    items.length < 2 || items[0].occurredAt >= items[items.length - 1].occurredAt,
    items.map(i => i.occurredAt),
  );

  res = await api(null, 'GET', `/admin/members/${member.id}/activity?types=SIGNUP`, null, headers);
  check(
    'types drops whole sources',
    (res.body?.data ?? []).every(item => item.type === 'SIGNUP') &&
      res.body?.meta?.totalCount === 1,
    res.body?.meta,
  );

  res = await api(
    null,
    'GET',
    `/admin/members/${member.id}/activity?types=NOT_A_TYPE`,
    null,
    headers,
  );
  check('an unknown type is refused', res.status === 400, res.body?.error);

  // Same latent trap as the content tab: whichever arm `types` leaves first supplies the column
  // names for the whole union.
  let timelineFilterable = 0;

  for (const type of [
    'SIGNUP',
    'LOGIN',
    'CREATE',
    'RESPOND',
    'JOIN',
    'ENQUIRE',
    'BOOK',
    'REPORT_FILED',
    'REPORTED',
    'ENFORCEMENT',
    'PROFILE_EDIT',
  ]) {
    const probe = await api(
      null,
      'GET',
      `/admin/members/${member.id}/activity?types=${type}`,
      null,
      headers,
    );

    if (probe.status === 200) timelineFilterable += 1;
    else console.log(`    types=${type} answered ${probe.status}`);
  }

  check(
    'all eleven activity types are filterable on their own',
    timelineFilterable === 11,
    timelineFilterable,
  );

  console.log('\n— Content —');

  const request = await prisma.communityRequest.create({
    data: {
      authorId: member.id,
      title: 'E2E tabs request',
      description: 'Looking for a caterer.',
      cityId: 'LONDON',
      categoryCode: 'FOOD_COOKING',
    },
  });
  const guide = await prisma.guide.create({
    data: {
      authorId: member.id,
      title: 'E2E tabs guide',
      intro: 'How to.',
      topicCode: 'HOUSING',
      blocks: [{ type: 'PARAGRAPH', text: 'A step.' }],
    },
  });

  res = await api(null, 'GET', `/admin/members/${member.id}/content`, null, headers);
  check('content answers', res.status === 200, res.body);
  check(
    'it unions across content types',
    (res.body?.data ?? []).some(row => row.targetId === request.id) &&
      (res.body?.data ?? []).some(row => row.targetId === guide.id),
    (res.body?.data ?? []).map(row => row.targetType),
  );
  check(
    'including the two arms that reach their table through a join',
    (res.body?.data ?? []).some(row => row.targetType === 'STORE_ITEM') &&
      (res.body?.data ?? []).some(row => row.targetType === 'CONNECT_POST'),
    (res.body?.data ?? []).map(row => row.targetType),
  );
  check(
    'each row knows what it is and where it lives',
    (res.body?.data ?? []).every(row => !!row.targetType && !!row.adminUrl),
    res.body?.data?.[0],
  );
  // The path is the content registry's slug, because that is what the portal routes on and what
  // this API's own `admin/content/:slug` endpoints are named after. A hand-written second copy
  // sent `/guides` and `/content/store-items`, neither of which is a page.
  const pathOf = type => (res.body?.data ?? []).find(row => row.targetType === type)?.adminUrl;

  check(
    'and the path is the registry slug, not a second copy of the routing table',
    pathOf('GUIDE') === `/content/guides/${guide.id}` &&
      (pathOf('STORE_ITEM') ?? '').startsWith('/content/items/') &&
      (pathOf('CONNECT_POST') ?? '').startsWith('/content/connect-posts/'),
    {
      guide: pathOf('GUIDE'),
      item: pathOf('STORE_ITEM'),
      post: pathOf('CONNECT_POST'),
    },
  );
  check(
    'an excerpt is truncated, and risk is null where nothing has looked',
    (res.body?.data ?? []).every(row => (row.excerpt ?? '').length <= 280) &&
      (res.body?.data ?? []).every(row => row.risk === null),
    res.body?.data?.[0],
  );
  check(
    'visibility comes through where the table has one',
    res.body?.data?.find(row => row.targetId === request.id)?.visibility === 'PUBLIC',
    res.body?.data?.find(row => row.targetId === request.id),
  );

  res = await api(
    null,
    'GET',
    `/admin/members/${member.id}/content?targetType=GUIDE`,
    null,
    headers,
  );
  check(
    'targetType narrows it to one arm',
    (res.body?.data ?? []).length === 1 && res.body.data[0].targetId === guide.id,
    { rows: res.body?.data, status: res.status, error: res.body?.error },
  );

  // Every arm, not just the first: a UNION takes its column names from whichever arm leads, so a
  // filter that reorders them used to fail with "column c.target_type does not exist".
  let filterable = 0;

  for (const type of [
    'REQUEST',
    'OFFER',
    'UPDATE',
    'RESPONSE',
    'UPDATE_REPLY',
    'GUIDE',
    'GROUP_POST',
    'GROUP_POST_REPLY',
    'CONNECT_POST',
    'CONNECT_STORY',
    'STORE_ITEM',
  ]) {
    const probe = await api(
      null,
      'GET',
      `/admin/members/${member.id}/content?targetType=${type}`,
      null,
      headers,
    );

    if (probe.status === 200) filterable += 1;
    else console.log(`    targetType=${type} answered ${probe.status}`);
  }

  check('all eleven content types are filterable on their own', filterable === 11, filterable);

  res = await api(
    null,
    'GET',
    `/admin/members/${member.id}/content?visibilityState=VISIBLE`,
    null,
    headers,
  );
  check(
    'filtering by a state that exists works',
    (res.body?.data ?? []).length >= 2,
    res.body?.meta,
  );

  res = await api(
    null,
    'GET',
    `/admin/members/${member.id}/content?visibilityState=REJECTED`,
    null,
    headers,
  );
  check(
    'and a state that cannot be derived yet is an honest empty page',
    res.status === 200 && (res.body?.data ?? []).length === 0,
    res.body?.meta,
  );

  res = await api(null, 'GET', `/admin/members/${member.id}/content`, null, safetyHeaders);
  check(
    'trust & safety can read content (members:read + content:read)',
    res.status === 200,
    res.status,
  );

  console.log('\n— Threads —');

  const conversation = await prisma.conversation.create({
    data: {
      kind: 'DIRECT',
      participantKey: [member.id, other.id].sort().join(':'),
      messageCount: 1,
      lastMessageAt: new Date(),
      participants: { create: [{ userId: member.id }, { userId: other.id }] },
      messages: {
        create: {
          senderId: member.id,
          body: 'SECRET-BODY-SHOULD-NEVER-APPEAR',
          clientId: 'e2e-tabs-1',
        },
      },
    },
  });

  res = await api(null, 'GET', `/admin/members/${member.id}/threads`, null, headers);
  check('threads answer', res.status === 200, res.body);
  check(
    'the thread is listed with its counterpart',
    (res.body?.data ?? []).some(
      row =>
        row.conversationId === conversation.id &&
        row.counterpart?.some(person => person.id === other.id),
    ),
    res.body?.data?.[0],
  );
  check(
    'and no message body appears anywhere in the payload',
    !JSON.stringify(res.body).includes('SECRET-BODY-SHOULD-NEVER-APPEAR'),
    'leaked',
  );
  check(
    'message count and timestamps are there instead',
    (res.body?.data ?? [])[0]?.messageCount === 1,
    res.body?.data?.[0],
  );

  res = await api(null, 'GET', `/admin/members/${member.id}/threads`, null, supportHeaders);
  check('support holds messages:read, so the list is open to them', res.status === 200, res.status);

  console.log('\n— Reports and R9 —');

  const report = await prisma.report.create({
    data: {
      reporterId: other.id,
      targetType: 'REQUEST',
      targetId: request.id,
      targetUserId: member.id,
      reasonCode: 'SPAM',
    },
  });

  res = await api(
    null,
    'GET',
    `/admin/members/${member.id}/reports?direction=received`,
    null,
    headers,
  );
  check(
    'a received report is listed',
    (res.body?.data ?? []).some(row => row.id === report.id),
    res.body?.data,
  );
  check(
    'and a caller with moderation:read sees who reported them',
    res.body?.data?.find(row => row.id === report.id)?.counterpart?.id === other.id,
    res.body?.data?.find(row => row.id === report.id)?.counterpart,
  );

  res = await api(
    null,
    'GET',
    `/admin/members/${member.id}/reports?direction=received`,
    null,
    supportHeaders,
  );
  check(
    'support sees the report but not the reporter (R9)',
    (res.body?.data ?? []).some(row => row.id === report.id) &&
      res.body.data.find(row => row.id === report.id)?.counterpart === null,
    res.body?.data?.find(row => row.id === report.id),
  );
  check(
    'and the response says the counterpart was withheld',
    res.body?.meta?.counterpartHidden === true,
    res.body?.meta,
  );
  check(
    'the reporter’s id is nowhere in the payload',
    !JSON.stringify(res.body).includes(other.id),
    'leaked',
  );

  res = await api(
    null,
    'GET',
    `/admin/members/${other.id}/reports?direction=filed`,
    null,
    supportHeaders,
  );
  check(
    'a filed report still names who it was about — that is not the reprisal risk',
    res.body?.data?.find(row => row.id === report.id)?.counterpart?.id === member.id,
    res.body?.data?.find(row => row.id === report.id)?.counterpart,
  );

  console.log('\n— Reviews, groups, deals —');

  const review = await prisma.review.create({
    data: {
      subjectUserId: member.id,
      reviewerId: other.id,
      rating: 5,
      comment: 'Great.',
      context: 'PRIOR_WORK',
    },
  });

  res = await api(
    null,
    'GET',
    `/admin/members/${member.id}/reviews?direction=received`,
    null,
    headers,
  );
  check(
    'a received review is listed with its author',
    res.body?.data?.find(row => row.id === review.id)?.counterpart?.id === other.id,
    res.body?.data,
  );
  check(
    'and says whether it counts to the average',
    res.body?.data?.find(row => row.id === review.id)?.countsToAverage === true,
    res.body?.data,
  );

  res = await api(null, 'GET', `/admin/members/${other.id}/reviews?direction=given`, null, headers);
  check(
    'the other direction reads from the same row',
    res.body?.data?.find(row => row.id === review.id)?.counterpart?.id === member.id,
    res.body?.data,
  );

  const group = await prisma.group.create({
    data: {
      name: 'E2E tabs group',
      description: 'A group for the tabs suite.',
      rules: ['Be kind.'],
      createdById: other.id,
      cityId: 'LONDON',
      categoryCode: 'FOOD_COOKING',
      memberships: { create: { userId: member.id, state: 'PENDING' } },
    },
  });

  res = await api(null, 'GET', `/admin/members/${member.id}/groups`, null, headers);
  check(
    'a pending membership is listed with no joinedAt',
    res.body?.data?.find(row => row.group.id === group.id)?.state === 'PENDING' &&
      res.body.data.find(row => row.group.id === group.id)?.joinedAt === null,
    res.body?.data,
  );
  check('but with the date they asked', !!res.body?.data?.[0]?.requestedAt, res.body?.data?.[0]);

  res = await api(null, 'GET', `/admin/members/${member.id}/deals`, null, headers);
  check('deals answer, empty', res.status === 200 && (res.body?.data ?? []).length === 0, res.body);

  console.log('\n— Enforcement —');

  const told = await prisma.strike.create({
    data: {
      userId: member.id,
      reasonCode: 'POLICY_VIOLATION',
      policySubtype: 'SPAM',
      sourceType: 'MANUAL',
      issuedById: admin.id,
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
      notifiedAt: new Date(),
    },
  });
  const silent = await prisma.strike.create({
    data: {
      userId: member.id,
      reasonCode: 'POLICY_VIOLATION',
      sourceType: 'MANUAL',
      issuedById: admin.id,
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
    },
  });

  res = await api(null, 'GET', `/admin/members/${member.id}/enforcement`, null, headers);
  check('both strikes are listed', (res.body?.data?.strikes ?? []).length === 2, res.body?.data);
  check(
    'warnings are only the ones the member was told about',
    (res.body?.data?.warnings ?? []).length === 1 && res.body.data.warnings[0].id === told.id,
    res.body?.data?.warnings?.map(w => w.id),
  );
  check(
    'the strike nobody told them about is still a strike',
    res.body?.data?.strikes?.find(s => s.id === silent.id)?.active === true &&
      res.body.data.activeStrikes === 2,
    res.body?.data?.activeStrikes,
  );
  check(
    'and names who issued it',
    res.body?.data?.strikes?.[0]?.issuedBy?.id === admin.id,
    res.body?.data?.strikes?.[0]?.issuedBy,
  );

  const suspension = await prisma.suspension.create({
    data: {
      userId: member.id,
      reasonCode: 'SAFETY_CONCERN',
      sourceType: 'MANUAL',
      issuedById: admin.id,
      endsAt: new Date(Date.now() - 86_400_000),
      liftedAt: new Date(),
    },
  });

  res = await api(null, 'GET', `/admin/members/${member.id}/enforcement`, null, headers);
  check(
    'a suspension lifted with nobody named reads as the expiry job',
    res.body?.data?.suspensions?.find(s => s.id === suspension.id)?.liftedByJob === true,
    res.body?.data?.suspensions?.[0],
  );
  check(
    'and is no longer active',
    res.body?.data?.suspensions?.find(s => s.id === suspension.id)?.active === false,
    res.body?.data?.suspensions?.[0],
  );

  console.log('\n— Linkable cases —');

  const guardThread = await prisma.guardThread.create({
    data: { userId: member.id, subject: 'E2E tabs guard', state: 'OPEN' },
  });

  res = await api(null, 'GET', `/admin/members/${member.id}/linkable-cases`, null, headers);
  check(
    'a Guard case is offered to a caller with guard:read',
    (res.body?.data ?? []).some(row => row.type === 'GUARD_CASE' && row.id === guardThread.id),
    res.body?.data,
  );
  check(
    'every option has a label a person can read',
    (res.body?.data ?? []).every(row => typeof row.label === 'string' && row.label.length > 3),
    res.body?.data?.[0],
  );

  res = await api(null, 'GET', `/admin/members/${member.id}/linkable-cases`, null, supportHeaders);
  check(
    'and withheld from one without it — not shown-but-unusable',
    !(res.body?.data ?? []).some(row => row.type === 'GUARD_CASE'),
    (res.body?.data ?? []).map(row => row.type),
  );

  console.log('\n— Blocks —');

  await prisma.block.create({ data: { blockerId: other.id, blockedId: member.id } });

  res = await api(null, 'GET', `/admin/members/${member.id}/blocks`, null, headers);
  check(
    'blocks answer with counts both ways',
    res.body?.data?.blockedBy === 1 && res.body?.data?.blocking === 0,
    res.body?.data,
  );
  check(
    'and the recent ones carry a direction',
    res.body?.data?.recent?.[0]?.direction === 'BLOCKED_BY',
    res.body?.data?.recent?.[0],
  );

  res = await api(null, 'GET', `/admin/members/${member.id}/blocks`, null, supportHeaders);
  check(
    'support does not hold moderation:read, so blocks are refused',
    res.status === 403,
    res.status,
  );

  console.log('\n— Audit scope (R8) —');

  res = await api(
    null,
    'POST',
    `/admin/members/${member.id}/reveal`,
    { fields: ['email'], reasonCode: 'SAFETY_CONCERN' },
    headers,
  );
  check('an entry exists to read', res.status === 200, res.body?.error);

  res = await api(null, 'GET', `/admin/members/${member.id}/audit`, null, headers);
  check(
    'audit:read sees the entry',
    (res.body?.data ?? []).some(row => row.action === 'member.pii_reveal'),
    res.body?.meta,
  );
  check(
    'each entry names the actor and the area',
    res.body?.data?.[0]?.actor?.id === admin.id && !!res.body?.data?.[0]?.area,
    res.body?.data?.[0],
  );
  check(
    'and points at the member’s own page',
    res.body?.data?.[0]?.target?.adminUrl === `/members/${member.id}`,
    res.body?.data?.[0]?.target,
  );

  res = await api(null, 'GET', `/admin/members/${member.id}/audit`, null, supportHeaders);
  check(
    'audit:read_self sees nothing it did not do itself',
    res.status === 200 && (res.body?.data ?? []).length === 0,
    res.body?.meta,
  );

  res = await api(null, 'GET', `/admin/members/${member.id}/audit`, null, safetyHeaders);
  check(
    'audit:read_area does not reach a MEMBERS-area entry either',
    res.status === 200 && !(res.body?.data ?? []).some(row => row.action === 'member.pii_reveal'),
    res.body?.data?.map(row => row.action),
  );

  console.log('\n— Every tab refuses a staff id and an anonymised account —');

  const TABS = [
    'profile',
    'sections',
    'activity',
    'content',
    'threads',
    'deals',
    'reports',
    'reviews',
    'groups',
    'sessions',
    'enforcement',
    'linkable-cases',
    'blocks',
    'audit',
    'notes',
  ];

  let staffRefused = 0;

  for (const tab of TABS) {
    const probe = await api(null, 'GET', `/admin/members/${admin.id}/${tab}`, null, headers);

    if (probe.status === 404) staffRefused += 1;
    else console.log(`    ${tab} answered ${probe.status} for a staff id`);
  }

  check(
    `all ${TABS.length} tabs 404 on a staff id (R5)`,
    staffRefused === TABS.length,
    staffRefused,
  );

  const ghost = await makeUser('tabs-ghost');

  await prisma.user.update({
    where: { id: ghost.id },
    data: { isAnonymised: true, anonymisedAt: new Date() },
  });

  let ghostRefused = 0;

  for (const tab of TABS) {
    const probe = await api(null, 'GET', `/admin/members/${ghost.id}/${tab}`, null, headers);

    if (probe.status === 404) ghostRefused += 1;
    else console.log(`    ${tab} answered ${probe.status} for an anonymised account`);
  }

  check(
    `and all ${TABS.length} on an anonymised account`,
    ghostRefused === TABS.length,
    ghostRefused,
  );

  console.log('\n— Paging —');

  res = await api(null, 'GET', `/admin/members/${member.id}/activity?perPage=1`, null, headers);
  check(
    'a tab pages',
    res.status === 200 && (res.body?.data ?? []).length === 1 && res.body?.meta?.totalCount > 1,
    res.body?.meta,
  );

  res = await api(
    null,
    'GET',
    `/admin/members/${member.id}/activity?page=900&perPage=1`,
    null,
    headers,
  );
  check(
    'and a page past the end still reports the real total',
    res.body?.meta?.totalCount > 1 && (res.body?.data ?? []).length === 0,
    res.body?.meta,
  );

  res = await api(
    null,
    'GET',
    `/admin/members/${member.id}/activity?page=200&perPage=100`,
    null,
    headers,
  );
  check('a page deep enough to scan the table is refused', res.status === 400, res.status);

  await prisma.guardThread.deleteMany({ where: { userId: member.id } });
  await sweep('admin-member-tabs');
  await finish();
})().catch(async error => {
  console.error(error);
  process.exit(1);
});
