/* Section 3 end-to-end check. */
const {
  api,
  check,
  fail,
  finish,
  makeUser,
  prisma,
  sweep,
  uploadPng,
  uploadStubVideo,
} = require('./harness.cjs');

const dobFor = years => {
  const date = new Date();

  date.setUTCFullYear(date.getUTCFullYear() - years);

  return date.toISOString().slice(0, 10);
};

(async () => {
  await sweep('pre-run');

  const ada = await makeUser('ada', {
    countryOfOrigin: 'NG',
    journeyStage: 'JUST_ARRIVED',
    interests: ['FOOD_COOKING'],
    languages: ['ENGLISH'],
  });
  const tunde = await makeUser('tunde', { countryOfOrigin: 'NG', journeyStage: 'JUST_ARRIVED' });
  const mei = await makeUser('mei', { countryOfOrigin: 'CN', journeyStage: 'ESTABLISHED' });
  const teen = await makeUser('teen');
  const ids = [ada.id, tunde.id, mei.id, teen.id];

  console.log('\n── 3.1 Continuity: the four shared fields ───────────────────');

  let r = await api(ada.token, 'GET', '/connect/setup/prefill');
  check('prefill → 200', r.status === 200, r.body?.error);
  check('profile null before setup', r.body?.data?.profile === null);
  check(
    'and the visibility toggle starts on, where the server will actually leave them',
    r.body?.data?.prefill?.isVisible === true,
    r.body?.data?.prefill?.isVisible,
  );

  // Same name, different question. The prefill says what the toggle should show; this says whether
  // they are discoverable right now, and somebody with no profile is not.
  const before = await api(ada.token, 'GET', '/connect/me');
  check(
    'while GET /connect/me reports the fact, not the default',
    before.body?.data?.hasProfile === false && before.body?.data?.isVisible === false,
    { hasProfile: before.body?.data?.hasProfile, isVisible: before.body?.data?.isVisible },
  );
  check(
    'name and city prefilled from the user',
    r.body?.data?.prefill?.displayName === 'E2E ada' &&
      r.body?.data?.prefill?.cityId === 'MANCHESTER',
    r.body?.data?.prefill,
  );
  check(
    'interests prefilled from onboarding',
    r.body?.data?.prefill?.interests?.includes('FOOD_COOKING'),
    r.body?.data?.prefill?.interests,
  );
  check(
    'journeyStage read, never re-asked',
    r.body?.data?.prefill?.journeyStage === 'JUST_ARRIVED',
  );
  check(
    'asks includes DATE_OF_BIRTH when the user has none',
    r.body?.data?.asks?.includes('DATE_OF_BIRTH'),
    r.body?.data?.asks,
  );
  check('minimumAge sent, not hardcoded', r.body?.data?.minimumAge === 18);

  console.log('\n── 3.3 Setup, and the 18 gate ───────────────────────────────');

  r = await api(teen.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Meeting people my own age near the university.',
    dateOfBirth: dobFor(16),
    isVisible: true,
  });
  check(
    'under 18 → 422 UNDER_MINIMUM_AGE, enforced server-side',
    r.status === 422 && r.body?.error?.code === 'UNDER_MINIMUM_AGE',
    r.body?.error,
  );

  r = await api(ada.token, 'PUT', '/connect/me', {
    typeCode: 'DATING',
    lookingFor: 'Meeting someone in Manchester who gets the newcomer thing.',
    dateOfBirth: dobFor(31),
    isVisible: true,
  });
  check(
    'DATING without confirmation → 422',
    r.status === 422 && r.body?.error?.code === 'DATING_CONFIRMATION_REQUIRED',
    r.body?.error,
  );

  r = await api(ada.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Practising English after work, happy to help with Yoruba in return.',
    dateOfBirth: dobFor(31),
    isVisible: true,
    languages: ['ENGLISH', 'YORUBA'],
    interests: ['FOOD_COOKING', 'SPORT_FITNESS'],
    heritageTag: 'WEST_AFRICAN',
  });
  check('create profile → 200', r.status === 200, r.body?.error);

  const prefilled = await api(ada.token, 'GET', '/connect/setup/prefill');
  check(
    'the setup screen reads the visibility toggle without a second call',
    prefilled.body?.data?.prefill?.isVisible === true,
    prefilled.body?.data?.prefill?.isVisible,
  );
  check('age derived from date of birth', r.body?.data?.age === 31, r.body?.data?.age);
  check(
    'type is {code,label}',
    r.body?.data?.type?.code === 'LANGUAGE_EXCHANGE' && !!r.body?.data?.type?.label,
  );
  check(
    'languages rendered as terms',
    r.body?.data?.languages?.some(l => l.code === 'YORUBA' && l.label === 'Yoruba'),
    r.body?.data?.languages,
  );

  const adaProfile = await prisma.userProfile.findUnique({ where: { userId: ada.id } });
  check(
    'languages written THROUGH to the user record (D15)',
    JSON.stringify(adaProfile?.languages) === JSON.stringify(['ENGLISH', 'YORUBA']),
    adaProfile?.languages,
  );
  check(
    'interests written through, updating the feed too',
    JSON.stringify(adaProfile?.interests) === JSON.stringify(['FOOD_COOKING', 'SPORT_FITNESS']),
    adaProfile?.interests,
  );
  check(
    'heritage written through, shared with Commerce',
    adaProfile?.heritageTag === 'WEST_AFRICAN',
  );
  check('dateOfBirth stored on the user', adaProfile?.dateOfBirth !== null);

  r = await api(ada.token, 'GET', '/connect/setup/prefill');
  check(
    'asks DROPS DATE_OF_BIRTH once it is set',
    !r.body?.data?.asks?.includes('DATE_OF_BIRTH'),
    r.body?.data?.asks,
  );
  check('dateOfBirthLocked true', r.body?.data?.prefill?.dateOfBirthLocked === true);

  r = await api(ada.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Trying to change my age, which should be refused.',
    dateOfBirth: dobFor(25),
  });
  check(
    'changing dateOfBirth → 403 DOB_LOCKED pointing at support',
    r.status === 403 && r.body?.error?.code === 'DOB_LOCKED',
    r.body?.error,
  );

  r = await api(ada.token, 'PATCH', '/users/profile', { dateOfBirth: dobFor(40) });
  check(
    'DOB also locked on the profile endpoint',
    r.status === 403 && r.body?.error?.code === 'DOB_LOCKED',
    r.body?.error,
  );

  console.log('\n── 3.4 Discovery & the reciprocity gate ─────────────────────');

  r = await api(mei.token, 'GET', '/connect/profiles');
  check(
    'no profile → 403 CONNECT_PROFILE_REQUIRED',
    r.status === 403 && r.body?.error?.code === 'CONNECT_PROFILE_REQUIRED',
    r.body?.error,
  );

  await api(tunde.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'New to Manchester and looking to meet people from home.',
    dateOfBirth: dobFor(29),
    isVisible: true,
    languages: ['ENGLISH', 'YORUBA'],
    heritageTag: 'WEST_AFRICAN',
  });
  await api(mei.token, 'PUT', '/connect/me', {
    typeCode: 'NETWORKING',
    lookingFor: 'Meeting other people working in software around the city.',
    dateOfBirth: dobFor(35),
    isVisible: true,
    languages: ['ENGLISH', 'MANDARIN'],
    heritageTag: 'EAST_ASIAN',
  });

  r = await api(ada.token, 'GET', '/connect/profiles');
  check('discovery → 200', r.status === 200, r.body?.error);
  check(
    'the caller is never in their own grid',
    !r.body?.data?.some(p => p.user?.id === ada.id),
    r.body?.data?.map(p => p.user?.id),
  );
  check(
    'finds the other two',
    [tunde.id, mei.id].every(id => r.body?.data?.some(p => p.user?.id === id)),
    r.body?.data?.map(p => p.user?.id),
  );
  check(
    'facets come from the data, not the catalogue',
    r.body?.meta?.facets?.languages?.includes('MANDARIN') &&
      r.body?.meta?.facets?.languages?.includes('YORUBA'),
    r.body?.meta?.facets,
  );

  r = await api(ada.token, 'GET', '/connect/profiles?languages=MANDARIN');
  check(
    'language filter matches ANY',
    r.body?.data?.some(p => p.user?.id === mei.id) &&
      !r.body?.data?.some(p => p.user?.id === tunde.id),
    r.body?.data?.map(p => p.user?.username),
  );

  r = await api(ada.token, 'GET', '/connect/profiles?newToUk=true');
  check(
    'newToUk defined server-side from the taxonomy flag',
    r.body?.data?.some(p => p.user?.id === tunde.id) &&
      !r.body?.data?.some(p => p.user?.id === mei.id),
    r.body?.data?.map(p => p.user?.id),
  );

  r = await api(ada.token, 'GET', '/connect/profiles?minAge=1');
  check(
    'minAge clamped to 18 whatever is sent',
    r.status === 200 && r.body?.data?.every(p => p.age >= 18),
    r.body?.data?.map(p => p.age),
  );

  r = await api(ada.token, 'GET', '/connect/profiles?type=NETWORKING');
  check(
    'type filter works',
    r.body?.data?.length > 0 && r.body.data.every(p => p.type.code === 'NETWORKING'),
    r.body?.data?.map(p => p.type?.code),
  );

  console.log('\n── 3.4 The three rules the filter row rests on ──────────────');

  // 2.2: the count on the button and the grid under it describe one set. Age used to be applied
  // after the query, so the count ignored it and a page of twenty could return seven.
  const counted = async qs => {
    const res = await api(ada.token, 'GET', `/connect/profiles?limit=50&cityId=ANYWHERE${qs}`);

    return {
      rows: (res.body?.data ?? []).length,
      total: res.body?.meta?.totalCount,
      languages: res.body?.meta?.facets?.languages ?? [],
      ages: (res.body?.data ?? []).map(p => p.age),
    };
  };

  const everyone = await counted('');
  const banded = await counted('&minAge=25&maxAge=34');

  // The promise is that the count and the grid describe ONE set, not that the set fits on a page:
  // a full page beside a larger count is an honest "more below". Asserting equality only held
  // while the dataset was smaller than a page, which stopped being true.
  const consistent = page => page.rows === Math.min(page.total, 50);

  check(
    'totalCount describes the same set the page came from, unfiltered',
    consistent(everyone),
    everyone,
  );
  check('and still does once an age band is applied', consistent(banded), banded);
  check('which is a narrower set, not the same one', banded.total < everyone.total, {
    everyone: everyone.total,
    banded: banded.total,
  });
  check(
    'both ends of the band are inclusive',
    banded.ages.every(age => age >= 25 && age <= 34),
    banded.ages,
  );

  // 2.3: a facet is narrowed by every filter except its own, or picking one language hides the rest.
  const byLanguage = await counted('&languages=YORUBA');

  check(
    'picking a language does not collapse the language facet',
    byLanguage.languages.length > 1 && byLanguage.languages.includes('YORUBA'),
    byLanguage.languages,
  );
  check(
    'and the alternatives are still offered',
    byLanguage.languages.some(code => code !== 'YORUBA'),
    byLanguage.languages,
  );
  check(
    'while another dimension does narrow it',
    banded.languages.length <= everyone.languages.length,
    { everyone: everyone.languages.length, banded: banded.languages.length },
  );

  // 2.1: two languages means either, not both.
  const yoruba = await counted('&languages=YORUBA');
  const mandarin = await counted('&languages=MANDARIN');
  const either = await counted('&languages=YORUBA,MANDARIN');

  check(
    'two languages is a union, not an intersection',
    either.total >= Math.max(yoruba.total, mandarin.total),
    { yoruba: yoruba.total, mandarin: mandarin.total, either: either.total },
  );

  // 3: the facets go straight back out as the filter, so they have to be codes.
  check(
    'facets are codes, not labels',
    everyone.languages.every(code => /^[A-Z][A-Z0-9_]*$/.test(code)),
    everyone.languages,
  );

  // 5: an unsupported parameter is refused rather than ignored, which is louder than the warning
  // the client asked for.
  r = await api(ada.token, 'GET', '/connect/profiles?notARealFilter=true');
  check(
    'an unknown parameter is named, not silently dropped',
    r.status === 400 && r.body?.error?.details?.[0]?.field === 'notARealFilter',
    r.body?.error,
  );

  console.log('\n── 3.1.6 Shared context, derived not stored ─────────────────');

  r = await api(ada.token, 'GET', `/connect/profiles/${tunde.id}`);
  check('profile by USER id → 200', r.status === 200, r.body?.error);
  check(
    'same country surfaced with a label',
    r.body?.data?.sharedContext?.sameCountry === 'Nigeria',
    r.body?.data?.sharedContext,
  );
  check(
    'same journey stage surfaced',
    !!r.body?.data?.sharedContext?.sameJourneyStage,
    r.body?.data?.sharedContext,
  );
  check(
    'no mutual groups key when there are none',
    r.body?.data?.sharedContext?.mutualGroupCount === undefined,
    r.body?.data?.sharedContext,
  );
  check('reportToken present', typeof r.body?.data?.reportToken === 'string');
  check('requestState NONE before anything', r.body?.data?.viewer?.requestState === 'NONE');

  r = await api(ada.token, 'GET', `/connect/profiles/${mei.id}`);
  check(
    'no shared country with a different origin',
    r.body?.data?.sharedContext?.sameCountry === undefined,
    r.body?.data?.sharedContext,
  );

  // A mutual group should appear without either of them declaring it.
  const g = await api(ada.token, 'POST', '/community/groups', {
    name: `E2E Connect Group ${Date.now()}`,
    description: 'A group both of them happen to be in already.',
    cityId: 'MANCHESTER',
  });
  await api(tunde.token, 'POST', `/community/groups/${g.body.data.id}/join`);
  r = await api(ada.token, 'GET', `/connect/profiles/${tunde.id}`);
  check(
    'mutual groups derived from membership',
    r.body?.data?.sharedContext?.mutualGroupCount === 1,
    r.body?.data?.sharedContext,
  );

  console.log('\n── 3.5 Connection requests ──────────────────────────────────');

  r = await api(ada.token, 'POST', '/connect/requests', {
    toProfileId: mei.id,
    note: 'Saw you are also in tech, fancy a coffee?',
  });
  check('send request → 201', r.status === 201, r.body?.error);
  const requestId = r.body?.data?.id;

  r = await api(ada.token, 'POST', '/connect/requests', { toProfileId: mei.id });
  check(
    'duplicate → 409 REQUEST_ALREADY_EXISTS',
    r.status === 409 && r.body?.error?.code === 'REQUEST_ALREADY_EXISTS',
    r.body?.error,
  );

  r = await api(ada.token, 'GET', `/connect/profiles/${mei.id}`);
  check('requestState now SENT_PENDING', r.body?.data?.viewer?.requestState === 'SENT_PENDING');
  r = await api(mei.token, 'GET', `/connect/profiles/${ada.id}`);
  check(
    'the other side sees RECEIVED_PENDING',
    r.body?.data?.viewer?.requestState === 'RECEIVED_PENDING',
  );

  r = await api(mei.token, 'GET', '/connect/me');
  check(
    'pendingRequestCount matches the banner',
    r.body?.data?.pendingRequestCount === 1,
    r.body?.data,
  );

  // The row has to answer "who, and should I?" without being opened. "Someone wants to connect"
  // with an empty body made the member open the app to learn what the card already knew.
  await new Promise(resolve => setTimeout(resolve, 800));

  r = await api(mei.token, 'GET', '/notifications?limit=10');
  const connectRow = (r.body?.data ?? []).find(row => row.kind === 'CONNECTION');

  check(
    'the request names who sent it',
    connectRow?.title === 'E2E ada wants to connect',
    connectRow?.title,
  );
  check(
    'and the body is where they are and where they are from',
    connectRow?.body === 'Manchester · From Nigeria',
    connectRow?.body,
  );
  check(
    'routed to the requests screen, not a profile',
    connectRow?.route === '/connect/requests' && connectRow?.target?.type === 'CONNECT_REQUEST',
    { route: connectRow?.route, target: connectRow?.target },
  );

  r = await api(mei.token, 'GET', '/connect/requests?direction=RECEIVED');
  check(
    'received list carries the other profile',
    r.body?.data?.[0]?.profile?.user?.id === ada.id,
    r.body?.data?.[0],
  );
  r = await api(ada.token, 'GET', '/connect/requests?direction=SENT');
  check('sent list reads the same endpoint', r.body?.data?.length === 1, r.body?.data?.length);

  r = await api(mei.token, 'POST', `/connect/requests/${requestId}/accept`);
  check(
    'accept → 200 with a conversationId',
    r.status === 200 && typeof r.body?.data?.conversationId === 'string',
    r.body,
  );
  const conversationId = r.body?.data?.conversationId;

  await new Promise(resolve => setTimeout(resolve, 800));

  r = await api(ada.token, 'GET', '/notifications?limit=10');
  const acceptedRow = (r.body?.data ?? []).find(row => row.kind === 'CONNECTION');

  check(
    'the acceptance names them too',
    acceptedRow?.title === 'E2E mei accepted your connection request',
    acceptedRow?.title,
  );
  check(
    'with the same two facts underneath, because it is the same kind',
    typeof acceptedRow?.body === 'string' && acceptedRow.body.includes('·'),
    acceptedRow?.body,
  );

  r = await api(ada.token, 'GET', `/connect/profiles/${mei.id}`);
  check('requestState CONNECTED after accept', r.body?.data?.viewer?.requestState === 'CONNECTED');
  check(
    'canMessageDirectly true once connected',
    r.body?.data?.viewer?.canMessageDirectly === true,
  );
  check(
    'conversationId surfaced so Message reopens it',
    r.body?.data?.viewer?.conversationId === conversationId,
    r.body?.data?.viewer,
  );

  const sysMsg = await prisma.message.findFirst({ where: { conversationId, kind: 'SYSTEM' } });
  check(
    'a safety system message opens the thread',
    sysMsg?.systemType === 'CONNECTION_ACCEPTED',
    sysMsg?.body,
  );

  // Open inbox short-circuits the whole request flow.
  await api(tunde.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'New to Manchester and looking to meet people from home.',
    dmPolicy: 'OPEN',
    isVisible: true,
  });
  r = await api(mei.token, 'POST', '/connect/requests', { toProfileId: tunde.id });
  check(
    'open inbox → 422 DIRECT_MESSAGE_ALLOWED with the thread',
    r.status === 422 &&
      r.body?.error?.code === 'DIRECT_MESSAGE_ALLOWED' &&
      !!r.body?.data?.conversationId,
    r.body,
  );

  // Decline is silent, and starts a cooldown.
  const dave = await makeUser('dave', { countryOfOrigin: 'JM' });
  ids.push(dave.id);
  await api(dave.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Just moved here and looking for people to talk to.',
    dateOfBirth: dobFor(27),
    isVisible: true,
  });
  r = await api(dave.token, 'POST', '/connect/requests', { toProfileId: ada.id });
  const daveRequestId = r.body?.data?.id;
  check('dave requests ada → 201', r.status === 201, r.body?.error);

  r = await api(ada.token, 'POST', `/connect/requests/${daveRequestId}/decline`, {});
  check('decline → 200', r.status === 200, r.body?.error);
  r = await api(dave.token, 'GET', `/connect/profiles/${ada.id}`);
  check(
    'sender sees DECLINED, with no reason given',
    r.body?.data?.viewer?.requestState === 'DECLINED',
  );

  r = await api(dave.token, 'POST', '/connect/requests', { toProfileId: ada.id });
  check(
    're-request within 30 days → 429 REQUEST_COOLDOWN',
    r.status === 429 && r.body?.error?.code === 'REQUEST_COOLDOWN',
    r.body?.error,
  );
  check(
    'retryAfterDays told to the client',
    r.body?.data?.retryAfterDays > 0 && r.body?.data?.retryAfterDays <= 30,
    r.body?.data,
  );

  console.log('\n── 3.3 A profile is discoverable unless they say otherwise ──');

  const quiet = await makeUser('quiet');

  r = await api(quiet.token, 'PUT', '/connect/me', {
    typeCode: 'NETWORKING',
    lookingFor: 'Other people working in software, without saying anything about being seen.',
    dateOfBirth: dobFor(33),
  });
  check('a profile created without mentioning visibility → 200', r.status === 200, r.body?.error);
  check(
    'is visible: choosing a type and saying what you want IS the deliberate act',
    r.body?.data?.isVisible === true,
    r.body?.data?.isVisible,
  );

  r = await api(ada.token, 'GET', '/connect/profiles');
  check(
    'and it is actually discoverable, not just flagged as such',
    (r.body?.data ?? []).some(p => p.user?.id === quiet.id),
    (r.body?.data ?? []).map(p => p.user?.id),
  );

  r = await api(quiet.token, 'PUT', '/connect/me', {
    typeCode: 'NETWORKING',
    lookingFor: 'Other people working in software, without saying anything about being seen.',
    isVisible: false,
  });
  check(
    'and they can still take themselves out of it',
    r.body?.data?.isVisible === false,
    r.body?.data?.isVisible,
  );

  r = await api(quiet.token, 'PUT', '/connect/me', {
    typeCode: 'NETWORKING',
    lookingFor: 'Other people working in software, and now editing something unrelated.',
  });
  check(
    'an edit that omits the toggle does not quietly put them back',
    r.body?.data?.isVisible === false,
    r.body?.data?.isVisible,
  );

  console.log('\n── 3.3.2 Hiding and leaving ─────────────────────────────────');

  await api(mei.token, 'PUT', '/connect/me', {
    typeCode: 'NETWORKING',
    lookingFor: 'Meeting other people working in software around the city.',
    isVisible: false,
  });
  r = await api(ada.token, 'GET', '/connect/profiles');
  check(
    'hidden profile leaves discovery',
    !r.body?.data?.some(p => p.user?.id === mei.id),
    r.body?.data?.map(p => p.user?.id),
  );

  r = await api(ada.token, 'GET', `/connect/profiles/${mei.id}`);
  check('hidden profile → 404, indistinguishable from blocked', r.status === 404, r.status);

  const stillConnected = await prisma.connectionRequest.findFirst({
    where: { fromUserId: ada.id, toUserId: mei.id },
  });
  check(
    'D17: hiding does not retract an accepted connection',
    stillConnected?.state === 'ACCEPTED',
    stillConnected?.state,
  );
  const threadSurvives = await prisma.conversation.findUnique({ where: { id: conversationId } });
  check('D17: the conversation survives hiding', threadSurvives !== null);

  r = await api(dave.token, 'DELETE', '/connect/me');
  check('leave Connect → 204', r.status === 204);
  const daveProfileAfter = await prisma.userProfile.findUnique({ where: { userId: dave.id } });
  check(
    'leaving does NOT touch date of birth or interests',
    daveProfileAfter?.dateOfBirth !== null,
    daveProfileAfter?.dateOfBirth,
  );
  const davePending = await prisma.connectionRequest.count({
    where: { fromUserId: dave.id, state: 'PENDING' },
  });
  check('pending requests removed in both directions', davePending === 0);

  console.log('\n── Blocking is shared, not rebuilt (3.1.5) ──────────────────');

  await api(ada.token, 'POST', '/moderation/blocks', { userId: tunde.id });
  r = await api(ada.token, 'GET', '/connect/profiles');
  check(
    'blocked member leaves the grid',
    !r.body?.data?.some(p => p.user?.id === tunde.id),
    r.body?.data?.map(p => p.user?.id),
  );
  r = await api(tunde.token, 'GET', `/connect/profiles/${ada.id}`);
  check(
    'blocked in the other direction → 404, never "you are blocked"',
    r.status === 404,
    r.status,
  );
  await api(ada.token, 'DELETE', `/moderation/blocks/${tunde.id}`);

  console.log('\n── 3.2 Posts: the unit is the post, not the photo ──────────');

  // Everything picked in one go goes up as one post with one caption, and the grid draws one tile
  // per post. A grid of nine single squares says somebody uploaded nine times.
  const k1 = await uploadPng(ada.token, 'CONNECT', 900, 1200);
  const k2 = await uploadPng(ada.token, 'CONNECT', 900, 1200);
  const k3 = await uploadPng(ada.token, 'CONNECT', 900, 1200);

  r = await api(ada.token, 'POST', '/connect/me/posts', {
    keys: [k1, k2],
    kind: 'PHOTO',
    caption: 'Sunday league, Hackney Marshes',
  });
  check(
    'two keys in one call are one post of two',
    r.status === 201 && r.body?.data?.items?.length === 2,
    { status: r.status, items: r.body?.data?.items?.length, error: r.body?.error },
  );
  const albumId = r.body?.data?.id;
  check(
    'with the caption on the post, not on a frame of it',
    r.body?.data?.caption === 'Sunday league, Hackney Marshes',
    r.body?.data?.caption,
  );
  check(
    'appended at position 0, being the first',
    r.body?.data?.position === 0,
    r.body?.data?.position,
  );
  check(
    'every item keeps its own id, which is what `about` names',
    r.body?.data?.items?.every(i => !!i.id),
    r.body?.data?.items,
  );
  check(
    'and its ratio, so a full-bleed card does not jump as it decodes',
    r.body?.data?.items?.every(i => i.width === 900 && i.height === 1200),
    r.body?.data?.items?.map(i => [i.width, i.height]),
  );
  check(
    'a photo carries no duration',
    r.body?.data?.items?.every(i => i.durationMs === null),
    r.body?.data?.items?.map(i => i.durationMs),
  );
  const firstPhotoId = r.body?.data?.items?.[0]?.id;

  r = await api(ada.token, 'POST', '/connect/me/posts', { keys: [k3], kind: 'PHOTO' });
  check('a second post appends after it', r.body?.data?.position === 1, r.body?.data?.position);
  const singleId = r.body?.data?.id;

  const spare1 = await uploadPng(ada.token, 'CONNECT', 900, 1200);
  const spare2 = await uploadPng(ada.token, 'CONNECT', 900, 1200);
  r = await api(ada.token, 'POST', '/connect/me/posts', { keys: [spare1, spare2], kind: 'VIDEO' });
  check(
    'a video post is exactly one key',
    r.status === 422 && r.body?.error?.code === 'CONNECT_POST_LIMIT',
    r.body?.error,
  );

  // A post is one thing or the other: two photos declared as a video is the same refusal as a
  // photo post with a clip in it, which is the rule the client is asked not to have to enforce.
  r = await api(ada.token, 'POST', '/connect/me/posts', { keys: [spare1], kind: 'VIDEO' });
  check('and a photo declared as a video is refused too', r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(ada.token, 'GET', '/connect/me');
  check(
    'the profile carries its gallery, in the order chosen',
    (r.body?.data?.profile?.posts ?? []).map(p => p.id).join() === [albumId, singleId].join(),
    r.body?.data?.profile?.posts?.map(p => p.id),
  );

  r = await api(ada.token, 'PATCH', `/connect/me/posts/${singleId}`, {
    caption: 'The room, before the plants',
  });
  check(
    'a caption can be changed afterwards',
    r.body?.data?.caption === 'The room, before the plants',
    r.body?.data?.caption,
  );

  r = await api(ada.token, 'PUT', '/connect/me/posts/order', { ids: [singleId, albumId] });
  check(
    'reordering answers the whole list',
    (r.body?.data?.posts ?? []).length === 2,
    r.body?.data?.posts?.length,
  );
  check(
    'renumbered from zero, because a stale position draws the wrong face first',
    r.body?.data?.posts?.[0]?.id === singleId && r.body?.data?.posts?.[0]?.position === 0,
    r.body?.data?.posts?.map(p => [p.id === singleId, p.position]),
  );

  r = await api(ada.token, 'PUT', '/connect/me/posts/order', { ids: [singleId] });
  check('a short list is refused, so a stale client cannot drop a post', r.status === 422, {
    status: r.status,
  });

  r = await api(ada.token, 'DELETE', `/connect/me/posts/${albumId}/media/${firstPhotoId}`);
  check(
    'one photo comes out of a post, leaving the rest',
    r.body?.data?.items?.length === 1,
    r.body?.data?.items?.length,
  );

  r = await api(
    ada.token,
    'DELETE',
    `/connect/me/posts/${albumId}/media/${r.body?.data?.items?.[0]?.id}`,
  );
  check(
    'and taking the last one takes the post, because an empty post is not a post',
    r.body?.data === null,
    r.body?.data,
  );

  r = await api(ada.token, 'GET', '/connect/me');
  check(
    'which leaves one post behind',
    (r.body?.data?.profile?.posts ?? []).length === 1,
    r.body?.data?.profile?.posts?.length,
  );

  // A video post is the only place a poster matters, and the only path with a duration cap, so
  // neither is exercised by a photo.
  const videoKey = await uploadStubVideo(ada.token, 'CONNECT');
  r = await api(ada.token, 'POST', '/connect/me/posts', { keys: [videoKey], kind: 'VIDEO' });
  check(
    'a video with no poster is refused, rather than shipping a grey tile',
    r.status === 422 && r.body?.error?.code === 'CONNECT_POSTER_REQUIRED',
    r.body?.error,
  );

  const posterKey = await uploadPng(ada.token, 'CONNECT', 900, 1200);
  r = await api(ada.token, 'POST', '/connect/me/posts', {
    keys: [videoKey],
    kind: 'VIDEO',
    posterKey,
  });
  check(
    'and a clip whose length cannot be read is refused too, not let through',
    r.status === 422 && r.body?.error?.code === 'CONNECT_VIDEO_TOO_LONG',
    r.body?.error,
  );

  // The caps the client says on the screen, so none of the three is only discovered in a refusal.
  const sixKeys = [];

  for (let i = 0; i < 6; i += 1) sixKeys.push(await uploadPng(ada.token, 'CONNECT', 900, 1200));

  r = await api(ada.token, 'POST', '/connect/me/posts', { keys: sixKeys, kind: 'PHOTO' });
  check(
    'six photos in one post → 409 with the limit, not a 400 about an array',
    r.status === 409 && r.body?.error?.code === 'CONNECT_POST_LIMIT',
    { status: r.status, code: r.body?.error?.code },
  );
  check(
    'and the limit travels with it, so the client can say it',
    r.body?.error?.data?.limit === 5 || r.body?.data?.limit === 5,
    r.body?.error?.data ?? r.body?.data,
  );

  console.log('\n── 3.3 Prompts: the question travels with the answer ───────');

  r = await api(ada.token, 'GET', '/connect/prompts');
  check(
    'the questions are served, not shipped',
    r.status === 200 && (r.body?.data ?? []).length >= 12,
    (r.body?.data ?? []).length,
  );
  check(
    'each is a code and the question itself',
    !!r.body?.data?.[0]?.code && !!r.body?.data?.[0]?.question,
    r.body?.data?.[0],
  );

  r = await api(ada.token, 'PUT', '/connect/me/prompts', {
    prompts: [
      { code: 'FIRST_THING', answer: 'The market on Ridley Road, on a Saturday.' },
      { code: 'MISS_MOST', answer: 'My mother shouting at the television during a match.' },
    ],
  });
  check(
    'answers are saved as a set, in the order given',
    (r.body?.data?.prompts ?? []).length === 2,
    r.body?.data?.prompts,
  );
  check(
    'and the question comes back beside the answer, never resolved at render time',
    r.body?.data?.prompts?.[0]?.question?.length > 10,
    r.body?.data?.prompts?.[0],
  );

  r = await api(ada.token, 'PUT', '/connect/me/prompts', {
    prompts: [{ code: 'NOT_A_PROMPT', answer: 'x' }],
  });
  check('an unknown code is refused rather than stored', r.status === 422, { status: r.status });

  r = await api(ada.token, 'PUT', '/connect/me/prompts', {
    prompts: [
      { code: 'FIRST_THING', answer: 'a' },
      { code: 'FIRST_THING', answer: 'b' },
    ],
  });
  check('and the same question twice is refused', r.status === 422, { status: r.status });

  r = await api(ada.token, 'PUT', '/connect/me/prompts', { prompts: [] });
  check(
    'an empty set clears them',
    (r.body?.data?.prompts ?? []).length === 0,
    r.body?.data?.prompts,
  );
  await api(ada.token, 'PUT', '/connect/me/prompts', {
    prompts: [{ code: 'ASK_ME_ABOUT', answer: 'Where to get jollof that tastes like home.' }],
  });

  console.log('\n── 3.4 Stories: a day, then gone ──────────────────────────');

  const storyKey = await uploadPng(ada.token, 'CONNECT', 1080, 1920);
  // `kind` is accepted and ignored: sending it used to be a 400, after the photo was already in
  // the bucket, which is the worst order for a refusal to happen in.
  r = await api(ada.token, 'POST', '/connect/stories', {
    key: storyKey,
    kind: 'PHOTO',
    caption: 'Egusi at the place on the corner',
  });
  check('a story is posted', r.status === 201 && !!r.body?.data?.id, {
    status: r.status,
    error: r.body?.error,
  });
  const storyId = r.body?.data?.id;
  check(
    'with the line somebody wrote on it',
    r.body?.data?.caption === 'Egusi at the place on the corner',
    r.body?.data?.caption,
  );
  check(
    'with an expiry the server stamped, never the client',
    !!r.body?.data?.expiresAt,
    r.body?.data?.expiresAt,
  );
  const ttl = new Date(r.body?.data?.expiresAt) - new Date(r.body?.data?.postedAt);
  check(
    'a day from posting, which is what the viewer counts down against',
    Math.abs(ttl - 86400000) < 2000,
    ttl,
  );

  r = await api(ada.token, 'GET', '/connect/stories');
  const mine = (r.body?.data ?? []).find(row => row.items.some(i => i.id === storyId));
  check(
    'the caller\'s own row is in the list, for the "Your story" tile',
    !!mine,
    (r.body?.data ?? []).length,
  );
  // Without the round trip a member cannot see their own words on their own story.
  check(
    'and the caption comes back on the item',
    mine?.items?.find(i => i.id === storyId)?.caption === 'Egusi at the place on the corner',
    mine?.items?.map(i => i.caption),
  );

  const bareKey = await uploadPng(ada.token, 'CONNECT', 1080, 1920);
  r = await api(ada.token, 'POST', '/connect/stories', { key: bareKey });
  check(
    'a story with no words is null rather than empty',
    r.body?.data?.caption === null,
    r.body?.data?.caption,
  );
  await api(ada.token, 'DELETE', `/connect/stories/${r.body?.data?.id}`);

  const longKey = await uploadPng(ada.token, 'CONNECT', 1080, 1920);
  r = await api(ada.token, 'POST', '/connect/stories', { key: longKey, caption: 'x'.repeat(141) });
  check(
    'past 140 characters is refused, being a client bug rather than a mistake',
    r.status === 400 || r.status === 422,
    { status: r.status },
  );
  check(
    'exactly one row per person, including them',
    (r.body?.data ?? []).length === new Set((r.body?.data ?? []).map(x => x.profileId)).size,
    (r.body?.data ?? []).map(x => x.profileId),
  );

  r = await api(tunde.token, 'GET', '/connect/stories');
  const theirs = (r.body?.data ?? []).find(row => row.items.some(i => i.id === storyId));
  check(
    'another member who may see the profile sees the story',
    !!theirs,
    (r.body?.data ?? []).length,
  );
  check(
    'unseen, which is what drives the ring',
    theirs?.hasUnseen === true && theirs?.items?.[0]?.seen === false,
    { unseen: theirs?.hasUnseen, seen: theirs?.items?.[0]?.seen },
  );

  r = await api(tunde.token, 'POST', `/connect/stories/${storyId}/seen`);
  check('marking it seen → 200', r.status === 200, r.status);
  r = await api(tunde.token, 'POST', `/connect/stories/${storyId}/seen`);
  check('and twice is idempotent', r.status === 200, r.status);

  r = await api(tunde.token, 'GET', '/connect/stories');
  const after = (r.body?.data ?? []).find(row => row.items.some(i => i.id === storyId));
  check(
    'the ring goes out once it is seen',
    after?.hasUnseen === false && after?.items?.[0]?.seen === true,
    { unseen: after?.hasUnseen, seen: after?.items?.[0]?.seen },
  );

  r = await api(tunde.token, 'DELETE', `/connect/stories/${storyId}`);
  check('only the owner takes one down', r.status === 403 || r.status === 404, {
    status: r.status,
  });

  r = await api(ada.token, 'DELETE', `/connect/stories/${storyId}`);
  check('the owner can, early', r.status === 204, r.status);

  r = await api(tunde.token, 'GET', '/connect/stories');
  check(
    'and it is gone from every other reader on the next load',
    !(r.body?.data ?? []).some(row => row.items.some(i => i.id === storyId)),
    (r.body?.data ?? []).length,
  );

  // Ten live per person: a story layer with no ceiling becomes a feed nobody asked for.
  const storyIds = [];

  for (let i = 0; i < 10; i += 1) {
    const key = await uploadPng(ada.token, 'CONNECT', 1080, 1920);
    const res = await api(ada.token, 'POST', '/connect/stories', { key });

    if (res.status === 201) storyIds.push(res.body.data.id);
  }

  check('ten stories go up', storyIds.length === 10, storyIds.length);
  const eleventh = await uploadPng(ada.token, 'CONNECT', 1080, 1920);

  r = await api(ada.token, 'POST', '/connect/stories', { key: eleventh });
  check(
    'and an eleventh is refused with a code the client can show',
    r.status === 409 && r.body?.error?.code === 'CONNECT_STORY_LIMIT',
    { status: r.status, code: r.body?.error?.code },
  );

  r = await api(ada.token, 'GET', '/connect/stories');
  const ownRow = (r.body?.data ?? []).find(row => row.items.length === 10);
  check(
    'all ten sit in one row, oldest first, because a tap-through reads forwards',
    !!ownRow,
    (r.body?.data ?? []).map(x => x.items.length),
  );
  check(
    'each with its own expiry for the viewer to count down against',
    (ownRow?.items ?? []).every(i => !!i.expiresAt),
    ownRow?.items?.length,
  );

  for (const id of storyIds) await api(ada.token, 'DELETE', `/connect/stories/${id}`);

  console.log('\n── 3.9 Reporting a photo, not only a person ───────────────');

  // Media on a dating-adjacent surface is the one place this will attract what it does not want.
  r = await api(ada.token, 'GET', '/connect/me');
  const reportablePost = r.body?.data?.profile?.posts?.[0];

  r = await api(tunde.token, 'POST', '/moderation/reports', {
    targetType: 'CONNECT_MEDIA',
    targetId: reportablePost?.items?.[0]?.id,
    reasonCode: 'INAPPROPRIATE',
  });
  check('a photo can be reported, not only the person holding it', r.status === 202, {
    status: r.status,
    error: r.body?.error,
  });

  const mediaReport = await prisma.report.findFirst({
    where: { targetType: 'CONNECT_MEDIA', targetId: reportablePost?.items?.[0]?.id },
    select: { targetUserId: true },
  });
  check(
    'and it names the member who put it there, not an owning row',
    mediaReport?.targetUserId === ada.id,
    mediaReport,
  );

  const storyKeyForReport = await uploadPng(ada.token, 'CONNECT', 1080, 1920);

  r = await api(ada.token, 'POST', '/connect/stories', { key: storyKeyForReport });
  const reportableStory = r.body?.data?.id;
  r = await api(tunde.token, 'POST', '/moderation/reports', {
    targetType: 'CONNECT_STORY',
    targetId: reportableStory,
    reasonCode: 'INAPPROPRIATE',
  });
  check('a story can be reported the same way', r.status === 202, {
    status: r.status,
    error: r.body?.error,
  });

  const storyReport = await prisma.report.findFirst({
    where: { targetType: 'CONNECT_STORY', targetId: reportableStory },
    select: { targetUserId: true },
  });
  check(
    'naming the member, which a profile id in that field would not',
    storyReport?.targetUserId === ada.id,
    storyReport,
  );
  await api(ada.token, 'DELETE', `/connect/stories/${reportableStory}`);

  console.log('\n── 3.5 A conversation about one thing ─────────────────────');

  // The mechanic the whole rebuild hangs on: without it the first message is "hey".
  //
  // A fresh member with a REQUEST_FIRST inbox, because an open one needs no request at all — that
  // half of §5 is checked separately below.
  const rhoda = await makeUser('rhoda', { countryOfOrigin: 'NG', journeyStage: 'SETTLING_IN' });

  ids.push(rhoda.id);
  await api(rhoda.token, 'PUT', '/connect/me', {
    typeCode: 'FLATMATE',
    lookingFor: 'Looking for a flatmate near the Northern Quarter from September.',
    dateOfBirth: dobFor(27),
    dmPolicy: 'REQUEST_FIRST',
    isVisible: true,
  });

  const photoKey = await uploadPng(rhoda.token, 'CONNECT', 900, 1200);
  r = await api(rhoda.token, 'POST', '/connect/me/posts', { keys: [photoKey], kind: 'PHOTO' });
  const tundePhoto = r.body?.data?.items?.[0]?.id;

  // The other half of §5: an open inbox needs no request, and the thing the member tapped still
  // has to travel — the thread is created on that refusal, so it is the only place to attach it.
  // A fresh pair, because `about` is attached when the thread is created and a pair who have
  // already talked have a thread whose subject is already settled.
  const sola = await makeUser('sola', { countryOfOrigin: 'GH', journeyStage: 'SETTLING_IN' });

  ids.push(sola.id);
  await api(sola.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'New here and would like people to walk with at weekends.',
    dateOfBirth: dobFor(34),
    dmPolicy: 'OPEN',
    isVisible: true,
  });

  const openPhotoKey = await uploadPng(sola.token, 'CONNECT', 900, 1200);
  r = await api(sola.token, 'POST', '/connect/me/posts', { keys: [openPhotoKey], kind: 'PHOTO' });
  const openPhoto = r.body?.data?.items?.[0]?.id;

  r = await api(rhoda.token, 'POST', '/connect/requests', {
    toProfileId: sola.id,
    about: { kind: 'MEDIA', id: openPhoto },
  });
  check(
    'an open inbox answers with the thread rather than taking a request',
    r.status === 422 && r.body?.error?.code === 'DIRECT_MESSAGE_ALLOWED',
    r.body?.error?.code,
  );
  const openThread = r.body?.data?.conversationId;

  r = await api(rhoda.token, 'GET', `/messages/${openThread}`);
  check(
    'and that thread is about the photo they tapped',
    r.body?.data?.context?.about?.id === openPhoto,
    r.body?.data?.context?.about,
  );

  r = await api(mei.token, 'POST', '/connect/requests', {
    toProfileId: rhoda.id,
    about: { kind: 'MEDIA', id: tundePhoto },
  });
  check('a request with `about` and no note is accepted — that is the heart', r.status === 201, {
    status: r.status,
    error: r.body?.error,
  });
  check(
    'and it echoes what it was about',
    r.body?.data?.about?.kind === 'MEDIA' && r.body?.data?.about?.id === tundePhoto,
    r.body?.data?.about,
  );
  const heartId = r.body?.data?.id;

  r = await api(rhoda.token, 'GET', '/connect/requests?direction=RECEIVED&state=PENDING');
  const heartRow = (r.body?.data ?? []).find(row => row.id === heartId);
  check(
    'the tray row carries it, because for a wordless request that picture IS the message',
    heartRow?.about?.kind === 'MEDIA',
    heartRow?.about,
  );
  check(
    'with something to draw, never a null thumbnail',
    !!heartRow?.about?.thumbnailUrl,
    heartRow?.about,
  );

  r = await api(mei.token, 'GET', `/connect/profiles/${rhoda.id}`);
  check(
    'the sender is handed the id of the request to withdraw',
    r.body?.data?.viewer?.requestId === heartId,
    r.body?.data?.viewer,
  );
  check(
    'beside the state the heart is drawn from',
    r.body?.data?.viewer?.requestState === 'SENT_PENDING',
    r.body?.data?.viewer?.requestState,
  );

  r = await api(sola.token, 'POST', '/connect/requests', {
    toProfileId: rhoda.id,
    note: 'Walk at the weekend?',
  });
  check('a request with words is still a request', r.status === 201, {
    status: r.status,
    error: r.body?.error?.code,
  });
  const wordedId = r.body?.data?.id;

  r = await api(rhoda.token, 'GET', `/connect/profiles/${sola.id}`);
  check(
    'the receiver is told a request is waiting',
    r.body?.data?.viewer?.requestState === 'RECEIVED_PENDING',
    r.body?.data?.viewer?.requestState,
  );
  check(
    'and given no id, having nothing to withdraw',
    r.body?.data?.viewer?.requestId === null,
    r.body?.data?.viewer,
  );
  await api(sola.token, 'DELETE', `/connect/requests/${wordedId}`);

  // The toggle: taking a heart back and putting it straight back is an undo, not a second request.
  r = await api(mei.token, 'DELETE', `/connect/requests/${heartId}`);
  check('withdrawing is silent and immediate', r.status === 200, r.status);
  r = await api(mei.token, 'POST', '/connect/requests', {
    toProfileId: rhoda.id,
    about: { kind: 'MEDIA', id: tundePhoto },
  });
  check('and sending it straight back is not refused by a cooldown', r.status === 201, {
    status: r.status,
    error: r.body?.error?.code,
  });
  const secondHeart = r.body?.data?.id;

  r = await api(mei.token, 'POST', '/connect/requests', {
    toProfileId: rhoda.id,
    about: { kind: 'MEDIA', id: firstPhotoId },
  });
  check(
    "`about` has to belong to that profile, or it quotes somebody else's photo",
    r.status === 422 || r.status === 409,
    { status: r.status, code: r.body?.error?.code },
  );

  r = await api(rhoda.token, 'POST', `/connect/requests/${secondHeart}/accept`);
  check(
    'accepting opens the thread',
    r.status === 200 && !!r.body?.data?.conversationId,
    r.body?.error,
  );
  const connectThread = r.body?.data?.conversationId;

  r = await api(mei.token, 'GET', `/messages/${connectThread}`);
  check(
    'and the thread is about that photo, so the first message is not "hey"',
    r.body?.data?.context?.about?.kind === 'MEDIA' &&
      r.body?.data?.context?.about?.id === tundePhoto,
    r.body?.data?.context?.about,
  );
  check(
    'with something to draw beside it',
    !!r.body?.data?.context?.about?.thumbnailUrl,
    r.body?.data?.context?.about,
  );

  console.log('\n── 3.6 / 3.7 The colour, and how alive it feels ───────────');

  r = await api(ada.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Practising English after work, happy to help with Yoruba in return.',
    accentColour: 'FOREST',
    isVisible: true,
  });
  check(
    'a member picks their own colour',
    r.body?.data?.accentColour === 'FOREST',
    r.body?.data?.accentColour,
  );

  r = await api(ada.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Practising English after work, happy to help with Yoruba in return.',
    accentColour: 'NEON_PINK',
    isVisible: true,
  });
  check(
    'anything outside the set is refused rather than stored',
    r.status === 400 || r.status === 422,
    { status: r.status },
  );

  r = await api(ada.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Practising English after work, happy to help with Yoruba in return.',
    accentColour: null,
    isVisible: true,
  });
  check(
    "and null clears it back to the connection type's colour",
    r.body?.data?.accentColour === null,
    r.body?.data?.accentColour,
  );

  r = await api(tunde.token, 'GET', `/connect/profiles/${ada.id}`);
  check(
    'liveness is bucketed, never an exact timestamp',
    ['TODAY', 'THIS_WEEK', 'THIS_MONTH', 'EARLIER'].includes(r.body?.data?.lastActiveBucket),
    r.body?.data?.lastActiveBucket,
  );
  check(
    'and lastActiveAt is not sent at all',
    r.body?.data?.lastActiveAt === undefined,
    r.body?.data?.lastActiveAt,
  );
  check(
    'hasStory rides on the payload, so a card draws the ring without the gallery',
    typeof r.body?.data?.hasStory === 'boolean',
    r.body?.data?.hasStory,
  );
  check(
    'mediaCount is withdrawn and not sent',
    r.body?.data?.mediaCount === undefined,
    r.body?.data?.mediaCount,
  );

  r = await api(ada.token, 'GET', '/connect/profiles?limit=50');
  check(
    'discovery never offers the caller themselves',
    !(r.body?.data ?? []).some(x => x.user?.id === ada.id),
    (r.body?.data ?? []).length,
  );
  check(
    'and every row carries its gallery, so the grid needs no second call',
    (r.body?.data ?? []).every(x => Array.isArray(x.posts) && Array.isArray(x.prompts)),
    (r.body?.data ?? []).slice(0, 1),
  );

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await sweep('cleanup');

  await finish();
})().catch(fail);
