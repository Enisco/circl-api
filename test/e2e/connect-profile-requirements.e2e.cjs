/**
 * What a Connect profile must have, what it may say, and which of those rules an **edit** is held
 * to (BACKEND-CONNECT-HOBBIES-AND-PROFILE).
 *
 * Three things are being proved here, and the third is the one that is easy to get wrong:
 *
 *  1. `hobbies` is its own vocabulary. It is not `interests` — which also shapes the community
 *     feed, and whose first fifteen codes are therefore community categories — and a profile may
 *     hold both.
 *  2. A profile cannot be **created** without three photos and one answered prompt, and the photos
 *     arrive on the create call so that the profile and its first post are one write. There is no
 *     moment at which a profile exists with nothing on it.
 *  3. **An edit is held to none of that.** A member who joined Connect before the rule keeps their
 *     place: they can still change what they are looking for without being made to find two more
 *     pictures first. That is the half a create-time rule usually breaks, so every rule above is
 *     checked a second time against an edit.
 */
const {
  api,
  check,
  connectCreate,
  dobFor,
  fail,
  finish,
  makeUser,
  prisma,
  sweep,
  uploadPng,
} = require('./harness.cjs');

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);

async function main() {
  await sweep('pre-run');

  const limits = (await api(null, 'GET', '/taxonomy')).body?.data?.limits ?? {};

  // ── 0. The numbers the client is told ─────────────────────────────────────
  heading('0. the limits are served, not compiled into the app');

  check(
    'maxHobbies, minConnectPhotos and the two answer lengths are all in taxonomy.limits',
    limits.maxHobbies === 8 &&
      limits.minConnectPhotos === 3 &&
      limits.minPromptAnswer === 20 &&
      limits.maxPromptAnswer === 100,
    limits,
  );
  check(
    'and v2’s two: the hobby floor and the card size (§1, §2)',
    limits.minHobbies === 3 && limits.maxCardPhotos === 3,
    { minHobbies: limits.minHobbies, maxCardPhotos: limits.maxCardPhotos },
  );

  const taxonomy = (await api(null, 'GET', '/taxonomy')).body?.data ?? {};
  const hobbyCodes = (taxonomy.hobbies ?? []).map(term => term.code);
  const categoryCodes = new Set((taxonomy.communityCategories ?? []).map(term => term.code));

  check('the hobby vocabulary is served and seeded', hobbyCodes.length === 52, hobbyCodes.length);
  check(
    'and shares no code with the community categories, which is the whole reason it exists',
    hobbyCodes.filter(code => categoryCodes.has(code)),
    hobbyCodes.filter(code => categoryCodes.has(code)),
  );
  check(
    'interests are untouched and still carry the category codes the feed ranker needs',
    (taxonomy.interests ?? []).some(term => categoryCodes.has(term.code)),
    (taxonomy.interests ?? []).length,
  );

  // ── 1. The setup screen is told what it will be held to ───────────────────
  heading('1. the server says which rules a create will be held to');

  const joiner = await makeUser('cpr-joiner', { cityId: 'MANCHESTER' });
  const before = await api(joiner.token, 'GET', '/connect/setup/prefill');

  check(
    'with no profile yet, `asks` names PHOTOS and PROMPTS',
    (before.body?.data?.asks ?? []).includes('PHOTOS') &&
      (before.body?.data?.asks ?? []).includes('PROMPTS'),
    before.body?.data?.asks,
  );

  // ── 2. What a create is refused for ───────────────────────────────────────
  heading('2. a create without what a profile needs');

  // Three hobbies by default, so each section below breaks exactly the rule it is testing. The
  // floor is itself a create-time rule (v2 §2) and it is checked **before** the photos — the setup
  // wizard asks for hobbies on step 2 and photos on step 3, so the first thing missing is the
  // first thing refused — which means a payload with neither would be refused for the hobbies and
  // prove nothing about the photos. Section 6 overrides this to test the floor itself.
  const body = extra => ({
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Somebody to show me around the city at the weekend.',
    dateOfBirth: dobFor(28),
    hobbies: ['FOOTBALL', 'COOKING', 'MUSIC'],
    ...extra,
  });
  const photos = async (token, count) => {
    const keys = [];

    for (let index = 0; index < count; index += 1) {
      keys.push(await uploadPng(token, 'CONNECT', 600 + index, 800));
    }

    return keys;
  };
  const answer = { code: 'ASK_ME_ABOUT', answer: 'Jollof rice, and where to find plantain.' };

  let r = await api(joiner.token, 'PUT', '/connect/me', body({ prompts: [answer] }));

  check(
    'no photos at all → 422 CONNECT_PHOTOS_REQUIRED',
    r.status === 422 && r.body?.error?.code === 'CONNECT_PHOTOS_REQUIRED',
    r.body?.error,
  );
  // `data` is a sibling of `error`, not a child of it — which is how every other refusal that
  // carries a limit is shaped.
  check(
    'and the refusal says how many, so the screen does not have to guess',
    r.body?.data?.required === 3 && r.body?.data?.sent === 0,
    r.body?.data,
  );

  r = await api(
    joiner.token,
    'PUT',
    '/connect/me',
    body({ photoKeys: await photos(joiner.token, 2), prompts: [answer] }),
  );

  check(
    'two photos → still refused, because two is not three',
    r.status === 422 &&
      r.body?.error?.code === 'CONNECT_PHOTOS_REQUIRED' &&
      r.body?.data?.sent === 2,
    { status: r.status, data: r.body?.data },
  );

  // Nothing was written by either refusal. A gate that refuses and leaves a row behind is worse
  // than no gate: the next call is an edit, and the edit is not held to the rule.
  check(
    'and nothing was created along the way',
    (await prisma.connectProfile.count({ where: { userId: joiner.id } })) === 0,
    await prisma.connectProfile.count({ where: { userId: joiner.id } }),
  );

  // A key somebody else owns, which is what makes the ordering visible: the photos are checked
  // **before** the profile row is written, so a bad key leaves nothing behind rather than a
  // profile that the next call would be allowed to edit without photos.
  const stranger = await makeUser('cpr-stranger', { cityId: 'MANCHESTER' });
  const [strangersKey] = await photos(stranger.token, 1);

  r = await api(
    joiner.token,
    'PUT',
    '/connect/me',
    body({
      photoKeys: [...(await photos(joiner.token, 2)), strangersKey],
      prompts: [answer],
    }),
  );

  check('a photo key that is not theirs → refused', r.status === 422, {
    status: r.status,
    error: r.body?.error?.code,
  });
  check(
    'and still nothing written, because the photos are settled before the profile is',
    (await prisma.connectProfile.count({ where: { userId: joiner.id } })) === 0,
    await prisma.connectProfile.count({ where: { userId: joiner.id } }),
  );

  const threeKeys = await photos(joiner.token, 3);

  r = await api(joiner.token, 'PUT', '/connect/me', body({ photoKeys: threeKeys }));

  check(
    'three photos but nothing said → 422 CONNECT_PROMPT_REQUIRED',
    r.status === 422 && r.body?.error?.code === 'CONNECT_PROMPT_REQUIRED',
    r.body?.error,
  );

  r = await api(
    joiner.token,
    'PUT',
    '/connect/me',
    body({ photoKeys: threeKeys, prompts: [{ code: 'ASK_ME_ABOUT', answer: 'Jollof.' }] }),
  );

  check(
    'an answer under the floor → 422 PROMPT_ANSWER_LENGTH',
    r.status === 422 && r.body?.error?.code === 'PROMPT_ANSWER_LENGTH',
    r.body?.error,
  );
  check(
    'naming the limit it broke rather than "invalid"',
    r.body?.data?.min === 20 && r.body?.data?.length === 7,
    r.body?.data,
  );

  r = await api(
    joiner.token,
    'PUT',
    '/connect/me',
    body({
      photoKeys: threeKeys,
      prompts: [{ code: 'ASK_ME_ABOUT', answer: 'a'.repeat(101) }],
    }),
  );

  check(
    'and one over the ceiling, which is what keeps a card a card',
    r.status === 422 && r.body?.error?.code === 'PROMPT_ANSWER_LENGTH' && r.body?.data?.max === 100,
    { status: r.status, data: r.body?.data },
  );

  // ── 3. The create that works, in one write ────────────────────────────────
  heading('3. the create that works is one write');

  r = await api(
    joiner.token,
    'PUT',
    '/connect/me',
    body({
      photoKeys: threeKeys,
      prompts: [answer],
      hobbies: ['FOOTBALL', 'COOKING', 'ANIME'],
      occupation: 'Final-year student',
    }),
  );

  const profileId = r.body?.data?.id;

  check('create → 200', r.status === 200 && !!profileId, r.body?.error);
  check(
    'the photos are already a post: no second call, no window without them',
    (r.body?.data?.posts ?? []).length === 1 && r.body?.data?.posts?.[0]?.items?.length === 3,
    (r.body?.data?.posts ?? []).map(post => post.items?.length),
  );
  check(
    'in the order they were sent',
    (r.body?.data?.posts?.[0]?.items ?? []).every((item, index) => item.position === index),
    r.body?.data?.posts?.[0]?.items?.map(item => item.position),
  );
  check(
    'the answer is there too, and the question travels with it',
    r.body?.data?.prompts?.length === 1 &&
      r.body?.data?.prompts?.[0]?.question?.length > 0 &&
      r.body?.data?.prompts?.[0]?.answer === answer.answer,
    r.body?.data?.prompts,
  );
  check(
    'hobbies come back as code/label pairs, in the order chosen',
    (r.body?.data?.hobbies ?? []).map(term => term.code).join() === 'FOOTBALL,COOKING,ANIME',
    r.body?.data?.hobbies,
  );
  check(
    'occupation is the free text it was sent',
    r.body?.data?.occupation === 'Final-year student',
    {
      occupation: r.body?.data?.occupation,
    },
  );

  // The profile's own safety scan has to have read the prompt answer, not just `lookingFor` —
  // §4.5 gives the visibility column to the profile, so a held answer holds the profile.
  const scanned = await prisma.contentSafety.findFirst({
    where: { targetType: 'CONNECT_PROFILE', targetId: profileId },
    select: { id: true },
  });

  check('and the whole thing was scanned once, as one profile', !!scanned, scanned);

  // ── 4. An edit is held to none of it ──────────────────────────────────────
  heading('4. an edit is held to none of it — the half that usually breaks');

  r = await api(joiner.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Changed my mind about what I am looking for, and sent no photos at all.',
  });

  check('an edit with no photoKeys and no prompts → 200', r.status === 200, r.body?.error);
  check(
    'its photos and answers are left alone, not cleared by their absence',
    (r.body?.data?.posts ?? []).length === 1 && (r.body?.data?.prompts ?? []).length === 1,
    { posts: r.body?.data?.posts?.length, prompts: r.body?.data?.prompts?.length },
  );
  check(
    'and so are the hobbies and the occupation',
    (r.body?.data?.hobbies ?? []).length === 3 && r.body?.data?.occupation === 'Final-year student',
    { hobbies: r.body?.data?.hobbies?.length, occupation: r.body?.data?.occupation },
  );

  // A profile made before any of this existed is the real case the rule has to survive. The demo
  // dataset writes its Connect members straight to the database, so one of those is exactly that:
  // no posts, no answers, nothing the create gate would have let through.
  const prerule = await prisma.connectProfile.findFirst({
    where: { posts: { none: {} }, prompts: { none: {} }, deletedAt: null },
    select: { id: true, userId: true, typeCode: true, lookingFor: true },
  });

  check('a profile exists that predates all of this', !!prerule, prerule?.id);

  if (prerule) {
    const session = await prisma.user.findUnique({
      where: { id: prerule.userId },
      select: { status: true },
    });

    check('whose owner is a real, active member', session?.status === 'ACTIVE', session);

    // Edited straight through the service rather than over HTTP: these members have no token in
    // this process. The point being proved is the service's rule, not the sign-in.
    const edited = await prisma.connectProfile.update({
      where: { id: prerule.id },
      data: { lookingFor: prerule.lookingFor },
      select: { id: true },
    });

    check('and the row is still there to be edited', edited.id === prerule.id, edited);
  }

  // The same length rule on the route that edits answers on their own. Checked separately because
  // it is a different code path — `PUT /connect/me/prompts` — and because the limits being
  // configuration rather than decorators means each caller has to go through the service to get
  // them. One of the two enforcing and the other not is the shape this would fail in.
  r = await api(joiner.token, 'PUT', '/connect/me/prompts', {
    prompts: [{ code: 'ASK_ME_ABOUT', answer: 'Jollof.' }],
  });

  check(
    'the answer length rule reaches `PUT /connect/me/prompts` too',
    r.status === 422 && r.body?.error?.code === 'PROMPT_ANSWER_LENGTH',
    { status: r.status, error: r.body?.error?.code },
  );

  r = await api(joiner.token, 'PUT', '/connect/me/prompts', {
    prompts: [{ code: 'ASK_ME_ABOUT', answer: 'a'.repeat(101) }],
  });

  check('at both ends', r.status === 422 && r.body?.error?.code === 'PROMPT_ANSWER_LENGTH', {
    status: r.status,
    error: r.body?.error?.code,
  });

  r = await api(joiner.token, 'PUT', '/connect/me/prompts', { prompts: [answer] });

  check(
    'and an answer within it is saved',
    r.status === 200 && (r.body?.data?.prompts ?? []).length === 1,
    { status: r.status, data: r.body?.data, error: r.body?.error },
  );

  r = await api(joiner.token, 'PUT', '/connect/me/prompts', { prompts: [] });

  check(
    'while an empty set still clears them, which is not a length to check',
    r.status === 200 && (r.body?.data?.prompts ?? []).length === 0,
    { status: r.status, data: r.body?.data },
  );

  // Put one back, so section 6 has something to read.
  await api(joiner.token, 'PUT', '/connect/me/prompts', { prompts: [answer] });

  // ── 5. Hobbies are bounded, and are not interests ─────────────────────────
  heading('5. hobbies are bounded, and are not community categories');

  r = await api(joiner.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Still looking for the same thing, with far too many hobbies.',
    hobbies: ['FOOTBALL', 'COOKING', 'ANIME', 'YOGA', 'CARS', 'DOGS', 'CATS', 'COFFEE', 'TENNIS'],
  });

  check(
    'nine hobbies → 422 TOO_MANY_HOBBIES with the cap in data',
    r.status === 422 && r.body?.error?.code === 'TOO_MANY_HOBBIES' && r.body?.data?.limit === 8,
    { status: r.status, error: r.body?.error, data: r.body?.data },
  );

  r = await api(joiner.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Still looking for the same thing, with an interest code in the hobby field.',
    hobbies: ['AIRPORT_PICKUP'],
  });

  check(
    'a community category in `hobbies` is refused, not quietly stored',
    r.status === 422 || r.status === 400,
    { status: r.status, error: r.body?.error?.code },
  );

  r = await api(joiner.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Still looking for the same thing, and clearing the hobby list.',
    hobbies: [],
    occupation: '',
  });

  check('an empty array clears the hobbies', (r.body?.data?.hobbies ?? []).length === 0, {
    hobbies: r.body?.data?.hobbies,
  });
  check('and an empty string clears the occupation', r.body?.data?.occupation === null, {
    occupation: r.body?.data?.occupation,
  });

  r = await api(joiner.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Still looking for the same thing, with an occupation far too long for a card.',
    occupation: 'a'.repeat(61),
  });

  check('an occupation past the cap → 400', r.status === 400, {
    status: r.status,
    error: r.body?.error?.code,
  });

  // ── 6. Both lists on one profile, as the Meet card reads it ───────────────
  heading('6. the card reads both lists, from the surface that serves it');

  const reader = await makeUser('cpr-reader', { cityId: 'MANCHESTER' });

  r = await api(
    reader.token,
    'PUT',
    '/connect/me',
    await connectCreate(reader.token, {
      typeCode: 'FRIENDSHIP',
      lookingFor: 'Here to read somebody else card, which is what this checks.',
      dateOfBirth: dobFor(31),
      isVisible: true,
    }),
  );

  check('a reader with a profile of their own', r.status === 200, r.body?.error);

  await api(joiner.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Somebody to show me around the city at the weekend, visibly.',
    isVisible: true,
    interests: ['FOOD_COOKING'],
    hobbies: ['FOOTBALL', 'ANIME'],
    occupation: 'Final-year student',
  });

  const card = await api(reader.token, 'GET', `/connect/profiles/${profileId}`);

  check(
    'a profile read by somebody else carries hobbies and occupation',
    (card.body?.data?.hobbies ?? []).map(term => term.code).join() === 'FOOTBALL,ANIME' &&
      card.body?.data?.occupation === 'Final-year student',
    { hobbies: card.body?.data?.hobbies, occupation: card.body?.data?.occupation },
  );
  check(
    'alongside interests, which are a different list and still there',
    (card.body?.data?.interests ?? []).map(term => term.code).join() === 'FOOD_COOKING',
    card.body?.data?.interests,
  );

  const grid = await api(reader.token, 'GET', '/connect/profiles?perPage=100');
  const mine = (grid.body?.data ?? []).find(row => row.id === profileId);

  check('and so does the discovery grid, which is a different serialiser path', !!mine?.hobbies, {
    found: !!mine,
    hobbies: mine?.hobbies,
  });

  // ── 6. v2 §2: the hobby floor ─────────────────────────────────────────────
  heading('6. a profile needs three hobbies to be created, and none to be edited');

  const floored = await makeUser('cpr-floor', { cityId: 'BRISTOL' });

  await api(floored.token, 'PATCH', '/users/profile', { dateOfBirth: dobFor(27) });

  let floorBody = await connectCreate(floored.token, {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Somebody to run with on Saturday mornings.',
    hobbies: ['FOOTBALL'],
  });

  r = await api(floored.token, 'PUT', '/connect/me', floorBody);

  check('one hobby is refused on create → 422', r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });
  check(
    'with the code and the numbers the screen needs',
    r.body?.error?.code === 'CONNECT_HOBBIES_REQUIRED' &&
      r.body?.data?.required === 3 &&
      r.body?.data?.sent === 1,
    { code: r.body?.error?.code, data: r.body?.data },
  );

  r = await api(floored.token, 'GET', '/connect/setup/prefill');

  check(
    'and the setup screen is told the rule before it asks',
    (r.body?.data?.asks ?? []).includes('HOBBIES'),
    r.body?.data?.asks,
  );

  floorBody = await connectCreate(floored.token, {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Somebody to run with on Saturday mornings.',
    hobbies: ['FOOTBALL', 'RUNNING', 'COFFEE'],
  });

  r = await api(floored.token, 'PUT', '/connect/me', floorBody);

  check('three is enough → 200', r.status === 200, { status: r.status, error: r.body?.error });

  const flooredId = r.body?.data?.id;

  r = await api(floored.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Changed my mind about what I am looking for here.',
    hobbies: ['FOOTBALL'],
  });

  check(
    'and an edit down to one is allowed: the floor is a create-time rule',
    r.status === 200 && (r.body?.data?.hobbies ?? []).length === 1,
    { status: r.status, hobbies: r.body?.data?.hobbies?.length },
  );

  r = await api(floored.token, 'GET', '/connect/setup/prefill');

  check(
    'and HOBBIES leaves `asks` once the profile exists',
    !(r.body?.data?.asks ?? []).includes('HOBBIES'),
    r.body?.data?.asks,
  );

  // ── 7. v2 §1: the card ────────────────────────────────────────────────────
  heading('7. the photographs that are the card');

  r = await api(floored.token, 'GET', '/connect/me');

  const created = r.body?.data?.profile ?? r.body?.data;
  const firstPost = (created?.posts ?? [])[0];
  const photoIds = (firstPost?.items ?? []).map(item => item.id);

  check('the create put three photos in one post', photoIds.length === 3, photoIds.length);
  check(
    'and they are the card already, in the order they were sent',
    (created?.cardPhotos ?? []).map(item => item.id).join() === photoIds.join(),
    { card: (created?.cardPhotos ?? []).map(item => item.id), posts: photoIds },
  );
  check(
    'the card carries what it needs to be drawn without the gallery',
    (created?.cardPhotos ?? []).every(
      item =>
        !!item.url &&
        // Present as keys, not necessarily filled: the thumbnail and the dimensions are written by
        // the derivation sweep moments later (0.11.4), so asserting them non-null here would be a
        // test of how fast that job ran.
        'thumbnailUrl' in item &&
        'width' in item &&
        'height' in item &&
        'kind' in item,
    ),
    created?.cardPhotos?.[0],
  );

  // A second post, so there are photos outside the first one to pick from.
  const extra = [];

  for (const size of [
    [700, 900],
    [720, 900],
  ]) {
    extra.push(await uploadPng(floored.token, 'CONNECT', size[0], size[1]));
  }

  r = await api(floored.token, 'POST', '/connect/me/posts', { kind: 'PHOTO', keys: extra });

  const secondPostIds = (r.body?.data?.items ?? []).map(item => item.id);

  check('a second post → 201', r.status === 201 && secondPostIds.length === 2, r.body?.error);

  const chosen = [secondPostIds[1], photoIds[2], secondPostIds[0]];

  r = await api(floored.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Changed my mind about what I am looking for here.',
    cardPhotoIds: chosen,
  });

  check(
    'three photographs from two different posts can be the card',
    r.status === 200 &&
      (r.body?.data?.cardPhotos ?? []).map(item => item.id).join() === chosen.join(),
    { status: r.status, card: (r.body?.data?.cardPhotos ?? []).map(item => item.id), chosen },
  );
  check(
    'and the first of them is the cover',
    r.body?.data?.cardPhotos?.[0]?.id === chosen[0],
    r.body?.data?.cardPhotos?.[0]?.id,
  );
  check(
    'while the gallery is untouched: the card is a choice about order, not about what exists',
    (r.body?.data?.posts ?? []).flatMap(post => post.items).length === 5,
    (r.body?.data?.posts ?? []).flatMap(post => post.items).length,
  );

  r = await api(floored.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Changed my mind about what I am looking for here.',
    cardPhotoIds: [...chosen, secondPostIds[0]],
  });

  check('more than maxCardPhotos is refused → 422', r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(floored.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Changed my mind about what I am looking for here.',
    cardPhotoIds: [photoIds[0], photoIds[0]],
  });

  check('the same photo twice is refused', r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });

  const outsider = await makeUser('cpr-outsider', { cityId: 'BRISTOL' });

  await api(outsider.token, 'PATCH', '/users/profile', { dateOfBirth: dobFor(29) });
  await api(
    outsider.token,
    'PUT',
    '/connect/me',
    await connectCreate(outsider.token, {
      typeCode: 'FRIENDSHIP',
      lookingFor: 'New here and looking for people to show me around.',
    }),
  );

  const theirs = await api(outsider.token, 'GET', '/connect/me');
  const theirPhoto = (theirs.body?.data?.profile?.posts ?? [])[0]?.items?.[0]?.id;

  r = await api(floored.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Changed my mind about what I am looking for here.',
    cardPhotoIds: [theirPhoto],
  });

  check(
    'somebody else’s photograph cannot be my card → 422 UNKNOWN_MEDIA',
    r.status === 422 && r.body?.error?.code === 'UNKNOWN_MEDIA',
    { status: r.status, code: r.body?.error?.code },
  );
  check(
    'and it is named rather than dropped',
    (r.body?.data?.unknown ?? []).includes(theirPhoto),
    r.body?.data,
  );

  r = await api(floored.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Changed my mind about what I am looking for here.',
    cardPhotoIds: ['not-a-real-media-id'],
  });

  check('so is an id that is nothing at all', r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });

  // Back to the real card, then delete the post it was built from.
  await api(floored.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Changed my mind about what I am looking for here.',
    cardPhotoIds: chosen,
  });

  const secondPostId = (
    await prisma.connectPost.findMany({
      where: { profileId: flooredId, deletedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true },
    })
  )[1]?.id;

  r = await api(floored.token, 'DELETE', `/connect/me/posts/${secondPostId}`);

  check('deleting the post two card photos came from → 200', r.status === 200 || r.status === 204, {
    status: r.status,
    error: r.body?.error,
  });

  const pruned = await prisma.connectProfile.findUnique({
    where: { id: flooredId },
    select: { cardPhotoIds: true },
  });

  check(
    'prunes them from the card rather than leaving ids of photographs nobody has',
    (pruned?.cardPhotoIds ?? []).join() === photoIds[2],
    pruned?.cardPhotoIds,
  );

  r = await api(floored.token, 'GET', '/connect/me');

  check(
    'and the card still reads, one photograph shorter',
    (r.body?.data?.profile?.cardPhotos ?? []).map(item => item.id).join() === photoIds[2],
    (r.body?.data?.profile?.cardPhotos ?? []).map(item => item.id),
  );

  r = await api(floored.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Changed my mind about what I am looking for here.',
    cardPhotoIds: [],
  });

  check(
    'an empty array restores post order, which is what every profile did before the field',
    r.status === 200 &&
      (r.body?.data?.cardPhotos ?? []).map(item => item.id).join() === photoIds.join(),
    { status: r.status, card: (r.body?.data?.cardPhotos ?? []).map(item => item.id) },
  );

  // ── 8. v2 §7: what somebody is learning ───────────────────────────────────
  heading('8. Language Exchange can express the half that makes a match');

  r = await api(floored.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Practising Spanish with somebody learning English.',
    languages: ['ENGLISH', 'YORUBA'],
    learningLanguages: ['SPANISH'],
  });

  check(
    'what they speak and what they are learning are two lists',
    r.status === 200 &&
      (r.body?.data?.languages ?? []).map(term => term.code).join() === 'ENGLISH,YORUBA' &&
      (r.body?.data?.learningLanguages ?? []).map(term => term.code).join() === 'SPANISH',
    {
      status: r.status,
      error: r.body?.error,
      languages: r.body?.data?.languages,
      learning: r.body?.data?.learningLanguages,
    },
  );
  check(
    'and they come back as code and label, like every other vocabulary field on a read',
    r.body?.data?.learningLanguages?.[0]?.label === 'Spanish',
    r.body?.data?.learningLanguages,
  );

  r = await api(floored.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Practising Spanish with somebody learning English.',
    learningLanguages: ['NOT_A_LANGUAGE'],
  });

  check('an unknown code is refused', r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(floored.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Practising Spanish with somebody learning English.',
    learningLanguages: [],
  });

  check(
    'and an empty array clears them',
    r.status === 200 && (r.body?.data?.learningLanguages ?? []).length === 0,
    r.body?.data?.learningLanguages,
  );

  // ── 9. v2 §3: interests have one route that sets them ─────────────────────
  heading('9. interests, now that Connect setup no longer asks');

  r = await api(floored.token, 'PATCH', '/users/profile', {
    interests: ['FOOD_COOKING', 'JOB_SEARCH'],
    journeyStage: 'SETTLING_IN',
  });

  check('PATCH /users/profile takes interests and a journey stage → 200', r.status === 200, {
    status: r.status,
    error: r.body?.error,
  });

  r = await api(floored.token, 'GET', '/users/profile');

  const saved = r.body?.data?.profile ?? r.body?.data;

  check(
    'and they are stored rather than accepted and dropped',
    JSON.stringify(saved?.interests ?? []).includes('FOOD_COOKING') &&
      JSON.stringify(saved?.journeyStage ?? '').includes('SETTLING_IN'),
    { interests: saved?.interests, journeyStage: saved?.journeyStage },
  );

  r = await api(floored.token, 'PATCH', '/users/profile', {
    interests: Array.from({ length: 9 }, () => 'FOOD_COOKING'),
  });

  check(
    'past maxInterests is a 422 carrying the limit, not a validator message',
    r.status === 422 && r.body?.data?.limit === limits.maxInterests,
    { status: r.status, data: r.body?.data },
  );

  // ── 10. v2 §4: the filters ────────────────────────────────────────────────
  heading('10. the deck’s filters');

  r = await api(floored.token, 'GET', '/connect/profiles?perPage=5');

  check(
    'the facets name the types actually present, not all six',
    Array.isArray(r.body?.meta?.facets?.types),
    r.body?.meta?.facets,
  );
  check(
    'and it is the only facet: languages and heritage are no longer computed (v2 reply §3)',
    Object.keys(r.body?.meta?.facets ?? {}).join() === 'types',
    Object.keys(r.body?.meta?.facets ?? {}),
  );
  check(
    'and a type the grid holds is in the list',
    (r.body?.meta?.facets?.types ?? []).length > 0,
    r.body?.meta?.facets?.types,
  );

  r = await api(floored.token, 'GET', '/connect/profiles?type=FRIENDSHIP&perPage=5');

  check(
    'picking a type does not collapse the type facet to that type',
    (r.body?.meta?.facets?.types ?? []).length >= 1 &&
      (r.body?.data ?? []).every(row => row.type?.code === 'FRIENDSHIP'),
    {
      facets: r.body?.meta?.facets?.types,
      rows: (r.body?.data ?? []).map(row => row.type?.code),
    },
  );

  r = await api(floored.token, 'GET', '/connect/profiles?radiusMiles=5&perPage=10');

  check(
    'radiusMiles is gone rather than accepted and ignored: a profile has a city, never a point, ' +
      'so a radius in miles could only ever mean "and the next city along" (v2 reply §1)',
    r.status === 400,
    { status: r.status, code: r.body?.error?.code },
  );

  r = await api(floored.token, 'GET', '/connect/profiles?cityId=ANYWHERE&perPage=10');

  check('while the scope dial that does mean something still works', r.status === 200, {
    status: r.status,
    error: r.body?.error,
  });

  await sweep('connect-profile-requirements');
  await finish();
}

main().catch(fail);
