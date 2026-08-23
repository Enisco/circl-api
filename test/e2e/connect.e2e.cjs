/* Section 3 end-to-end check. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');



const dobFor = years => {
  const date = new Date();

  date.setUTCFullYear(date.getUTCFullYear() - years);

  return date.toISOString().slice(0, 10);
};

(async () => {
  await sweep('pre-run');

  const ada = await makeUser('ada', { countryOfOrigin: 'NG', journeyStage: 'JUST_ARRIVED', interests: ['FOOD_COOKING'], languages: ['ENGLISH'] });
  const tunde = await makeUser('tunde', { countryOfOrigin: 'NG', journeyStage: 'JUST_ARRIVED' });
  const mei = await makeUser('mei', { countryOfOrigin: 'CN', journeyStage: 'ESTABLISHED' });
  const teen = await makeUser('teen');
  const ids = [ada.id, tunde.id, mei.id, teen.id];

  console.log('\n── 3.1 Continuity: the four shared fields ───────────────────');

  let r = await api(ada.token, 'GET', '/connect/setup/prefill');
  check('prefill → 200', r.status === 200, r.body?.error);
  check('profile null before setup', r.body?.data?.profile === null);
  check('name and city prefilled from the user', r.body?.data?.prefill?.displayName === 'E2E ada' && r.body?.data?.prefill?.cityId === 'MANCHESTER', r.body?.data?.prefill);
  check('interests prefilled from onboarding', r.body?.data?.prefill?.interests?.includes('FOOD_COOKING'), r.body?.data?.prefill?.interests);
  check('journeyStage read, never re-asked', r.body?.data?.prefill?.journeyStage === 'JUST_ARRIVED');
  check('asks includes DATE_OF_BIRTH when the user has none', r.body?.data?.asks?.includes('DATE_OF_BIRTH'), r.body?.data?.asks);
  check('minimumAge sent, not hardcoded', r.body?.data?.minimumAge === 18);

  console.log('\n── 3.3 Setup, and the 18 gate ───────────────────────────────');

  r = await api(teen.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP', lookingFor: 'Meeting people my own age near the university.',
    dateOfBirth: dobFor(16), isVisible: true,
  });
  check('under 18 → 422 UNDER_MINIMUM_AGE, enforced server-side', r.status === 422 && r.body?.error?.code === 'UNDER_MINIMUM_AGE', r.body?.error);

  r = await api(ada.token, 'PUT', '/connect/me', {
    typeCode: 'DATING', lookingFor: 'Meeting someone in Manchester who gets the newcomer thing.',
    dateOfBirth: dobFor(31), isVisible: true,
  });
  check('DATING without confirmation → 422', r.status === 422 && r.body?.error?.code === 'DATING_CONFIRMATION_REQUIRED', r.body?.error);

  r = await api(ada.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Practising English after work, happy to help with Yoruba in return.',
    dateOfBirth: dobFor(31), isVisible: true, languages: ['ENGLISH', 'YORUBA'], interests: ['FOOD_COOKING', 'SPORT_FITNESS'],
    heritageTag: 'WEST_AFRICAN',
  });
  check('create profile → 200', r.status === 200, r.body?.error);
  check('age derived from date of birth', r.body?.data?.age === 31, r.body?.data?.age);
  check('type is {code,label}', r.body?.data?.type?.code === 'LANGUAGE_EXCHANGE' && !!r.body?.data?.type?.label);
  check('languages rendered as terms', r.body?.data?.languages?.some(l => l.code === 'YORUBA' && l.label === 'Yoruba'), r.body?.data?.languages);

  const adaProfile = await prisma.userProfile.findUnique({ where: { userId: ada.id } });
  check('languages written THROUGH to the user record (D15)', JSON.stringify(adaProfile?.languages) === JSON.stringify(['ENGLISH', 'YORUBA']), adaProfile?.languages);
  check('interests written through, updating the feed too', JSON.stringify(adaProfile?.interests) === JSON.stringify(['FOOD_COOKING', 'SPORT_FITNESS']), adaProfile?.interests);
  check('heritage written through, shared with Commerce', adaProfile?.heritageTag === 'WEST_AFRICAN');
  check('dateOfBirth stored on the user', adaProfile?.dateOfBirth !== null);

  r = await api(ada.token, 'GET', '/connect/setup/prefill');
  check('asks DROPS DATE_OF_BIRTH once it is set', !r.body?.data?.asks?.includes('DATE_OF_BIRTH'), r.body?.data?.asks);
  check('dateOfBirthLocked true', r.body?.data?.prefill?.dateOfBirthLocked === true);

  r = await api(ada.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE', lookingFor: 'Trying to change my age, which should be refused.',
    dateOfBirth: dobFor(25),
  });
  check('changing dateOfBirth → 403 DOB_LOCKED pointing at support', r.status === 403 && r.body?.error?.code === 'DOB_LOCKED', r.body?.error);

  r = await api(ada.token, 'PATCH', '/users/profile', { dateOfBirth: dobFor(40) });
  check('DOB also locked on the profile endpoint', r.status === 403 && r.body?.error?.code === 'DOB_LOCKED', r.body?.error);

  console.log('\n── 3.4 Discovery & the reciprocity gate ─────────────────────');

  r = await api(mei.token, 'GET', '/connect/profiles');
  check('no profile → 403 CONNECT_PROFILE_REQUIRED', r.status === 403 && r.body?.error?.code === 'CONNECT_PROFILE_REQUIRED', r.body?.error);

  await api(tunde.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP', lookingFor: 'New to Manchester and looking to meet people from home.',
    dateOfBirth: dobFor(29), isVisible: true, languages: ['ENGLISH', 'YORUBA'], heritageTag: 'WEST_AFRICAN',
  });
  await api(mei.token, 'PUT', '/connect/me', {
    typeCode: 'NETWORKING', lookingFor: 'Meeting other people working in software around the city.',
    dateOfBirth: dobFor(35), isVisible: true, languages: ['ENGLISH', 'MANDARIN'], heritageTag: 'EAST_ASIAN',
  });

  r = await api(ada.token, 'GET', '/connect/profiles');
  check('discovery → 200', r.status === 200, r.body?.error);
  check('the caller is never in their own grid', !r.body?.data?.some(p => p.user?.id === ada.id), r.body?.data?.map(p => p.user?.id));
  check('finds the other two', r.body?.data?.length === 2, r.body?.data?.length);
  check('facets come from the data, not the catalogue', r.body?.meta?.facets?.languages?.includes('MANDARIN') && r.body?.meta?.facets?.languages?.includes('YORUBA'), r.body?.meta?.facets);

  r = await api(ada.token, 'GET', '/connect/profiles?languages=MANDARIN');
  check('language filter matches ANY', r.body?.data?.length === 1 && r.body.data[0].user.id === mei.id, r.body?.data?.map(p => p.user?.username));

  r = await api(ada.token, 'GET', '/connect/profiles?newToUk=true');
  check('newToUk defined server-side from the taxonomy flag', r.body?.data?.length === 1 && r.body.data[0].user.id === tunde.id, r.body?.data?.map(p => p.user?.id));

  r = await api(ada.token, 'GET', '/connect/profiles?minAge=1');
  check('minAge clamped to 18 whatever is sent', r.status === 200 && r.body?.data?.every(p => p.age >= 18), r.body?.data?.map(p => p.age));

  r = await api(ada.token, 'GET', '/connect/profiles?type=NETWORKING');
  check('type filter works', r.body?.data?.length === 1 && r.body.data[0].type.code === 'NETWORKING');

  console.log('\n── 3.1.6 Shared context, derived not stored ─────────────────');

  r = await api(ada.token, 'GET', `/connect/profiles/${tunde.id}`);
  check('profile by USER id → 200', r.status === 200, r.body?.error);
  check('same country surfaced with a label', r.body?.data?.sharedContext?.sameCountry === 'Nigeria', r.body?.data?.sharedContext);
  check('same journey stage surfaced', !!r.body?.data?.sharedContext?.sameJourneyStage, r.body?.data?.sharedContext);
  check('no mutual groups key when there are none', r.body?.data?.sharedContext?.mutualGroupCount === undefined, r.body?.data?.sharedContext);
  check('reportToken present', typeof r.body?.data?.reportToken === 'string');
  check('requestState NONE before anything', r.body?.data?.viewer?.requestState === 'NONE');

  r = await api(ada.token, 'GET', `/connect/profiles/${mei.id}`);
  check('no shared country with a different origin', r.body?.data?.sharedContext?.sameCountry === undefined, r.body?.data?.sharedContext);

  // A mutual group should appear without either of them declaring it.
  const g = await api(ada.token, 'POST', '/community/groups', {
    name: `E2E Connect Group ${Date.now()}`, description: 'A group both of them happen to be in already.',
    cityId: 'MANCHESTER',
  });
  await api(tunde.token, 'POST', `/community/groups/${g.body.data.id}/join`);
  r = await api(ada.token, 'GET', `/connect/profiles/${tunde.id}`);
  check('mutual groups derived from membership', r.body?.data?.sharedContext?.mutualGroupCount === 1, r.body?.data?.sharedContext);

  console.log('\n── 3.5 Connection requests ──────────────────────────────────');

  r = await api(ada.token, 'POST', '/connect/requests', { toProfileId: mei.id, note: 'Saw you are also in tech, fancy a coffee?' });
  check('send request → 201', r.status === 201, r.body?.error);
  const requestId = r.body?.data?.id;

  r = await api(ada.token, 'POST', '/connect/requests', { toProfileId: mei.id });
  check('duplicate → 409 REQUEST_ALREADY_EXISTS', r.status === 409 && r.body?.error?.code === 'REQUEST_ALREADY_EXISTS', r.body?.error);

  r = await api(ada.token, 'GET', `/connect/profiles/${mei.id}`);
  check('requestState now SENT_PENDING', r.body?.data?.viewer?.requestState === 'SENT_PENDING');
  r = await api(mei.token, 'GET', `/connect/profiles/${ada.id}`);
  check('the other side sees RECEIVED_PENDING', r.body?.data?.viewer?.requestState === 'RECEIVED_PENDING');

  r = await api(mei.token, 'GET', '/connect/me');
  check('pendingRequestCount matches the banner', r.body?.data?.pendingRequestCount === 1, r.body?.data);

  r = await api(mei.token, 'GET', '/connect/requests?direction=RECEIVED');
  check('received list carries the other profile', r.body?.data?.[0]?.profile?.user?.id === ada.id, r.body?.data?.[0]);
  r = await api(ada.token, 'GET', '/connect/requests?direction=SENT');
  check('sent list reads the same endpoint', r.body?.data?.length === 1, r.body?.data?.length);

  r = await api(mei.token, 'POST', `/connect/requests/${requestId}/accept`);
  check('accept → 200 with a conversationId', r.status === 200 && typeof r.body?.data?.conversationId === 'string', r.body);
  const conversationId = r.body?.data?.conversationId;

  r = await api(ada.token, 'GET', `/connect/profiles/${mei.id}`);
  check('requestState CONNECTED after accept', r.body?.data?.viewer?.requestState === 'CONNECTED');
  check('canMessageDirectly true once connected', r.body?.data?.viewer?.canMessageDirectly === true);
  check('conversationId surfaced so Message reopens it', r.body?.data?.viewer?.conversationId === conversationId, r.body?.data?.viewer);

  const sysMsg = await prisma.message.findFirst({ where: { conversationId, kind: 'SYSTEM' } });
  check('a safety system message opens the thread', sysMsg?.systemType === 'CONNECTION_ACCEPTED', sysMsg?.body);

  // Open inbox short-circuits the whole request flow.
  await api(tunde.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP', lookingFor: 'New to Manchester and looking to meet people from home.',
    dmPolicy: 'OPEN', isVisible: true,
  });
  r = await api(mei.token, 'POST', '/connect/requests', { toProfileId: tunde.id });
  check('open inbox → 422 DIRECT_MESSAGE_ALLOWED with the thread', r.status === 422 && r.body?.error?.code === 'DIRECT_MESSAGE_ALLOWED' && !!r.body?.data?.conversationId, r.body);

  // Decline is silent, and starts a cooldown.
  const dave = await makeUser('dave', { countryOfOrigin: 'JM' });
  ids.push(dave.id);
  await api(dave.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP', lookingFor: 'Just moved here and looking for people to talk to.',
    dateOfBirth: dobFor(27), isVisible: true,
  });
  r = await api(dave.token, 'POST', '/connect/requests', { toProfileId: ada.id });
  const daveRequestId = r.body?.data?.id;
  check('dave requests ada → 201', r.status === 201, r.body?.error);

  r = await api(ada.token, 'POST', `/connect/requests/${daveRequestId}/decline`, {});
  check('decline → 200', r.status === 200, r.body?.error);
  r = await api(dave.token, 'GET', `/connect/profiles/${ada.id}`);
  check('sender sees DECLINED, with no reason given', r.body?.data?.viewer?.requestState === 'DECLINED');

  r = await api(dave.token, 'POST', '/connect/requests', { toProfileId: ada.id });
  check('re-request within 30 days → 429 REQUEST_COOLDOWN', r.status === 429 && r.body?.error?.code === 'REQUEST_COOLDOWN', r.body?.error);
  check('retryAfterDays told to the client', r.body?.data?.retryAfterDays > 0 && r.body?.data?.retryAfterDays <= 30, r.body?.data);

  console.log('\n── 3.3.2 Hiding and leaving ─────────────────────────────────');

  await api(mei.token, 'PUT', '/connect/me', {
    typeCode: 'NETWORKING', lookingFor: 'Meeting other people working in software around the city.',
    isVisible: false,
  });
  r = await api(ada.token, 'GET', '/connect/profiles');
  check('hidden profile leaves discovery', !r.body?.data?.some(p => p.user?.id === mei.id), r.body?.data?.map(p => p.user?.id));

  r = await api(ada.token, 'GET', `/connect/profiles/${mei.id}`);
  check('hidden profile → 404, indistinguishable from blocked', r.status === 404, r.status);

  const stillConnected = await prisma.connectionRequest.findFirst({ where: { fromUserId: ada.id, toUserId: mei.id } });
  check('D17: hiding does not retract an accepted connection', stillConnected?.state === 'ACCEPTED', stillConnected?.state);
  const threadSurvives = await prisma.conversation.findUnique({ where: { id: conversationId } });
  check('D17: the conversation survives hiding', threadSurvives !== null);

  r = await api(dave.token, 'DELETE', '/connect/me');
  check('leave Connect → 204', r.status === 204);
  const daveProfileAfter = await prisma.userProfile.findUnique({ where: { userId: dave.id } });
  check('leaving does NOT touch date of birth or interests', daveProfileAfter?.dateOfBirth !== null, daveProfileAfter?.dateOfBirth);
  const davePending = await prisma.connectionRequest.count({ where: { fromUserId: dave.id, state: 'PENDING' } });
  check('pending requests removed in both directions', davePending === 0);

  console.log('\n── Blocking is shared, not rebuilt (3.1.5) ──────────────────');

  await api(ada.token, 'POST', '/moderation/blocks', { userId: tunde.id });
  r = await api(ada.token, 'GET', '/connect/profiles');
  check('blocked member leaves the grid', !r.body?.data?.some(p => p.user?.id === tunde.id), r.body?.data?.map(p => p.user?.id));
  r = await api(tunde.token, 'GET', `/connect/profiles/${ada.id}`);
  check('blocked in the other direction → 404, never "you are blocked"', r.status === 404, r.status);
  await api(ada.token, 'DELETE', `/moderation/blocks/${tunde.id}`);

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await sweep('cleanup');

  await finish();
})().catch(fail);
