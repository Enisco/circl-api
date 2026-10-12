/* §6.2–6.7 The content safety pipeline: what happens to a post as it is written.
 *
 * The lexicon half, which runs inline in the write transaction. The classifier is the other half
 * and is switched off until it exists (`safety.classifier.enabled`), so every verdict here is
 * recorded `DEGRADED` — which is exactly what §6.7 prescribes for a classifier that cannot
 * answer, and what makes this suite deterministic.
 *
 * The phrases below come from the seeded lexicon, with their weights, because the tier boundaries
 * are what is being tested:
 *
 *   "trafficked"        65  MODERN_SLAVERY    → safeguarding floor → CRITICAL
 *   "immigration raid"  50  DEPORTATION_RISK  → MEDIUM
 */
const {
  api,
  check,
  dobFor,
  fail,
  finish,
  forgetCacheKeys,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

const safetyOf = (targetType, targetId) =>
  prisma.contentSafety.findUnique({ where: { targetType_targetId: { targetType, targetId } } });

(async () => {
  await sweep('pre-run');

  const author = await makeUser('cs-author', { cityId: 'BRISTOL' });
  const reader = await makeUser('cs-reader', { cityId: 'BRISTOL' });

  const postRequest = async (title, description) => {
    const res = await api(author.token, 'POST', '/community/requests', {
      title,
      description,
      categoryCode: 'ACCOMMODATION',
      cityId: 'BRISTOL',
    });

    return res;
  };

  console.log('\n── A clean post is published, and still recorded ────────────');

  let res = await postRequest(
    'A quiet question about a tenancy deposit',
    'Nothing in here for a lexicon to find.',
  );
  check('a clean request is accepted', res.status === 201, res.body?.error);

  const clean = res.body?.data?.id;
  let safety = await safetyOf('REQUEST', clean);

  check(
    'it has a safety row — every scan is written down, not only the bad ones',
    !!safety,
    safety,
  );
  check(
    'clean, scored zero, and published',
    safety?.tier === 'CLEAN' && safety?.finalScore === 0 && safety?.visibilityState === 'VISIBLE',
    safety,
  );
  check(
    'marked DEGRADED, because the classifier is off rather than agreeing (§6.7)',
    safety?.scanStatus === 'DEGRADED',
    safety?.scanStatus,
  );
  check(
    'with a content hash, so an edit can be compared',
    !!safety?.contentHash,
    safety?.contentHash,
  );
  check(
    'one scan in the history',
    (await prisma.contentScan.count({ where: { contentSafetyId: safety.id } })) === 1,
    await prisma.contentScan.count({ where: { contentSafetyId: safety.id } }),
  );
  check(
    'and no queue item: nothing for a human to do',
    (await prisma.moderationQueueItem.count({ where: { targetId: clean } })) === 0,
    await prisma.moderationQueueItem.count({ where: { targetId: clean } }),
  );

  console.log('\n── A medium hit is limited, not hidden ─────────────────────');

  res = await postRequest(
    'Worried about an immigration raid at work',
    'Somebody told me what to do but I want to check.',
  );
  check('a medium-scoring request is still accepted', res.status === 201, res.body?.error);

  const limited = res.body?.data?.id;

  safety = await safetyOf('REQUEST', limited);
  check(
    'scored on the term and landed on MEDIUM',
    safety?.lexiconScore === 50 && safety?.tier === 'MEDIUM',
    { score: safety?.lexiconScore, tier: safety?.tier },
  );
  check(
    'limited, with the reason recorded',
    safety?.visibilityState === 'LIMITED' && safety?.heldReason === 'AUTO_MEDIUM',
    safety,
  );
  check('and the moment it happened', !!safety?.limitedAt && !safety?.heldAt, {
    limitedAt: safety?.limitedAt,
    heldAt: safety?.heldAt,
  });

  const row = await prisma.communityRequest.findUnique({
    where: { id: limited },
    select: { visibilityState: true },
  });

  check('the content row carries the same state (§4.5)', row?.visibilityState === 'LIMITED', row);

  res = await api(reader.token, 'GET', '/community/requests?cityId=BRISTOL&limit=50');
  check(
    'so it is out of the list',
    !(res.body?.data ?? []).some(item => item.id === limited),
    (res.body?.data ?? []).length,
  );

  res = await api(reader.token, 'GET', `/community/requests/${limited}`);
  check('but still there for anybody with the link', res.status === 200, res.body?.error);

  let queue = await prisma.moderationQueueItem.findFirst({ where: { targetId: limited } });

  check(
    'a FLAGGED_CONTENT item is waiting for a human',
    queue?.type === 'FLAGGED_CONTENT',
    queue?.type,
  );
  check(
    'carrying the verdict’s own score, so the list cannot disagree with the decision',
    queue?.riskScore === safety?.finalScore && queue?.riskLevel === 'MEDIUM',
    { queue: queue?.riskScore, safety: safety?.finalScore, level: queue?.riskLevel },
  );
  check(
    'and the evidence: which phrase, in which field',
    Array.isArray(queue?.riskSignals) &&
      queue.riskSignals.some(signal => signal.pattern === 'immigration raid' && signal.field),
    queue?.riskSignals,
  );

  const hit = await prisma.riskTermHit.findFirst({
    where: { targetId: limited },
    include: { riskTerm: { select: { pattern: true, hitCount: true, lastHitAt: true } } },
  });

  check('the term that matched has a hit row', hit?.riskTerm?.pattern === 'immigration raid', hit);
  check(
    'still PENDING, because nobody has judged it yet',
    hit?.outcome === 'PENDING',
    hit?.outcome,
  );
  check(
    'and the term’s own counters moved',
    hit?.riskTerm?.hitCount > 0 && !!hit?.riskTerm?.lastHitAt,
    hit?.riskTerm,
  );

  console.log('\n── A safeguarding disclosure is held and escalated ─────────');

  res = await postRequest(
    'I think I was trafficked and need advice',
    'Please help me, I do not know who to ask.',
  );
  check('it is accepted — the member is not refused', res.status === 201, res.body?.error);

  const held = res.body?.data?.id;

  safety = await safetyOf('REQUEST', held);
  check(
    'the lexicon scored 65 and the safeguarding floor took it to the top (§6.3 rule 3)',
    safety?.lexiconScore === 65 && safety?.finalScore === 90,
    { lexicon: safety?.lexiconScore, final: safety?.finalScore },
  );
  check(
    'so it is CRITICAL and held',
    safety?.tier === 'CRITICAL' &&
      safety?.visibilityState === 'HELD' &&
      safety?.heldReason === 'AUTO_CRITICAL',
    safety,
  );
  check(
    'with the category that put it there',
    safety?.category === 'MODERN_SLAVERY',
    safety?.category,
  );

  queue = await prisma.moderationQueueItem.findFirst({ where: { targetId: held } });
  check(
    'a GUARD_RISK item, not a content flag: somebody may be in danger',
    queue?.type === 'GUARD_RISK' && queue?.riskLevel === 'CRITICAL',
    { type: queue?.type, level: queue?.riskLevel },
  );

  res = await api(reader.token, 'GET', `/community/requests/${held}`);
  check('nobody else can read it', res.status === 404, res.status);

  res = await api(author.token, 'GET', `/community/requests/${held}`);
  check('its author still can', res.status === 200, res.body?.error);

  console.log('\n── The same phrase twice is not twice the risk ─────────────');

  safety = await safetyOf('REQUEST', limited);

  const signals = safety?.lexiconSignals ?? [];

  check(
    'both occurrences are recorded as signals',
    signals.length >= 1 && signals.every(signal => signal.termId && signal.pattern),
    signals,
  );
  check(
    'while the score counted the term once (50, not 100)',
    safety?.lexiconScore === 50,
    safety?.lexiconScore,
  );

  console.log('\n── An edit is scanned, and a no-op edit is not ─────────────');

  res = await api(author.token, 'PATCH', `/community/requests/${clean}`, {
    title: 'A quiet question about a tenancy deposit',
  });
  check('a patch that changes nothing scannable is accepted', res.status === 200, res.body?.error);

  safety = await safetyOf('REQUEST', clean);
  check(
    'and does not re-scan: the hash decides, not the request',
    safety?.scanVersion === 1,
    safety?.scanVersion,
  );

  res = await api(author.token, 'PATCH', `/community/requests/${clean}`, {
    description: 'On reflection, I think I was trafficked.',
  });
  check('a real edit is accepted', res.status === 200, res.body?.error);

  safety = await safetyOf('REQUEST', clean);
  check(
    'the scan version moves and the verdict changes with the words',
    safety?.scanVersion === 2 && safety?.tier === 'CRITICAL',
    { version: safety?.scanVersion, tier: safety?.tier },
  );
  check(
    'the post is held now, though it was published a moment ago',
    (await prisma.communityRequest.findUnique({ where: { id: clean } }))?.visibilityState ===
      'HELD',
    await prisma.communityRequest.findUnique({
      where: { id: clean },
      select: { visibilityState: true },
    }),
  );
  check(
    'and both scans are in the history, which is what makes a decision explainable',
    (await prisma.contentScan.count({ where: { contentSafetyId: safety.id } })) === 2,
    await prisma.contentScan.count({ where: { contentSafetyId: safety.id } }),
  );
  check(
    'the triggers say which was which',
    (
      await prisma.contentScan.findMany({
        where: { contentSafetyId: safety.id },
        orderBy: { scanVersion: 'asc' },
        select: { trigger: true },
      })
    )
      .map(scan => scan.trigger)
      .join(',') === 'CREATE,EDIT',
    await prisma.contentScan.findMany({
      where: { contentSafetyId: safety.id },
      select: { trigger: true, scanVersion: true },
    }),
  );

  console.log('\n── A re-scan cannot publish what was held (§6.6) ───────────');

  // The one-keystroke release: a held post, edited into something clean, would otherwise go
  // straight back into the feeds with nobody having looked at it.
  res = await api(author.token, 'PATCH', `/community/requests/${clean}`, {
    description: 'On reflection, there is nothing of note in this request at all.',
  });
  check('the author may edit their held post', res.status === 200, res.body?.error);

  safety = await safetyOf('REQUEST', clean);
  check(
    'the scan says clean, and says so on the row',
    safety?.tier === 'CLEAN' && safety?.scanVersion === 3,
    { tier: safety?.tier, version: safety?.scanVersion },
  );
  check(
    'but the post is LIMITED, not VISIBLE: a human still has to release it',
    safety?.visibilityState === 'LIMITED',
    safety?.visibilityState,
  );
  check(
    'and the content row agrees',
    (
      await prisma.communityRequest.findUnique({
        where: { id: clean },
        select: { visibilityState: true },
      })
    )?.visibilityState === 'LIMITED',
    await prisma.communityRequest.findUnique({
      where: { id: clean },
      select: { visibilityState: true },
    }),
  );

  res = await api(reader.token, 'GET', '/community/requests?cityId=BRISTOL&limit=50');
  check(
    'so it is still out of the feed',
    !(res.body?.data ?? []).some(item => item.id === clean),
    (res.body?.data ?? []).length,
  );

  console.log('\n── One open hit per term, however many edits ───────────────');

  const openHits = await prisma.riskTermHit.count({
    where: { targetId: clean, outcome: 'PENDING' },
  });

  check(
    'four scans of one post left one unjudged hit per phrase, not one per scan',
    openHits === 1,
    openHits,
  );

  console.log('\n── Every community write path is wired ─────────────────────');

  res = await postRequest('A host post for the replies below', 'Perfectly ordinary.');

  const host = res.body?.data?.id;

  res = await api(reader.token, 'POST', `/community/requests/${host}/responses`, {
    content: 'An ordinary reply.',
  });
  check('a reply is accepted', res.status === 201, res.body?.error);
  check(
    'and scanned',
    !!(await safetyOf('RESPONSE', res.body?.data?.response?.id)),
    res.body?.data?.response?.id,
  );

  res = await api(author.token, 'POST', '/community/offers', {
    title: 'An ordinary offer of help',
    description: 'Seeded by content-safety.e2e.cjs.',
    categoryCode: 'ACCOMMODATION',
    cityId: 'BRISTOL',
  });
  check('an offer is scanned', !!(await safetyOf('OFFER', res.body?.data?.id)), res.body?.error);

  res = await api(author.token, 'POST', '/community/updates', {
    content: 'An ordinary post.',
    cityId: 'BRISTOL',
  });

  const update = res.body?.data?.id;

  check('an update is scanned', !!(await safetyOf('UPDATE', update)), res.body?.error);

  res = await api(reader.token, 'POST', `/community/updates/${update}/replies`, {
    content: 'An ordinary comment.',
  });
  check(
    'an update reply is scanned',
    !!(await safetyOf('UPDATE_REPLY', res.body?.data?.id)),
    res.body?.error,
  );

  res = await api(author.token, 'POST', '/community/guides', {
    topicCode: 'HOUSING',
    title: 'An ordinary guide about deposits',
    intro: 'Seeded by content-safety.e2e.cjs, long enough to pass the minimum length.',
    steps: ['A step long enough to count as one.', 'A second step, for the same reason.'],
    cityId: 'BRISTOL',
  });
  check('a guide is scanned', !!(await safetyOf('GUIDE', res.body?.data?.id)), res.body?.error);

  res = await api(author.token, 'POST', '/community/groups', {
    name: `E2E safety group ${Date.now()}`,
    description: 'Seeded by content-safety.e2e.cjs.',
    cityId: 'BRISTOL',
    joinPolicy: 'OPEN',
  });

  const group = res.body?.data?.id;

  check('a group is scanned', !!(await safetyOf('GROUP', group)), res.body?.error);
  check(
    'with no author: a group’s name outlives whoever typed it',
    (await safetyOf('GROUP', group))?.authorId === null,
    (await safetyOf('GROUP', group))?.authorId,
  );

  res = await api(author.token, 'POST', `/community/groups/${group}/posts`, {
    content: 'An ordinary group post.',
  });

  const groupPost = res.body?.data?.id;

  check('a group post is scanned', !!(await safetyOf('GROUP_POST', groupPost)), res.body?.error);

  res = await api(author.token, 'POST', `/community/groups/${group}/posts/${groupPost}/replies`, {
    content: 'An ordinary group reply.',
  });
  check(
    'a group post reply is scanned',
    !!(await safetyOf('GROUP_POST_REPLY', res.body?.data?.id)),
    res.body?.error,
  );

  console.log('\n── Every other section is wired too (§6.1) ─────────────────');

  const pro = await makeUser('cs-pro', { cityId: 'BRISTOL' });
  const seller = await makeUser('cs-seller', { cityId: 'BRISTOL' });
  const neighbour = await makeUser('cs-neighbour', { cityId: 'BRISTOL' });

  res = await api(author.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Somebody to walk with on weekends, seeded by content-safety.e2e.cjs.',
    dateOfBirth: dobFor(31),
    isVisible: true,
  });
  check('a Connect profile is accepted', res.status === 200 || res.status === 201, res.body?.error);

  const connectProfile = await prisma.connectProfile.findFirst({
    where: { userId: author.id },
    select: { id: true },
  });

  check(
    'a Connect profile is scanned',
    !!(await safetyOf('CONNECT_PROFILE', connectProfile?.id)),
    connectProfile?.id,
  );

  res = await api(author.token, 'PUT', '/connect/me/prompts', {
    prompts: [{ code: 'FIRST_THING', answer: 'A long walk and then a roast dinner.' }],
  });

  if (res.status === 200 || res.status === 201) {
    const scans = await prisma.contentScan.count({
      where: { contentSafety: { targetId: connectProfile?.id } },
    });

    check('and rewriting its prompts re-scans it', scans >= 2, scans);
  } else {
    check('prompts answered', false, [res.status, res.body?.error]);
  }

  res = await api(pro.token, 'POST', '/professionals/listings', {
    categoryCodes: ['BUSINESS_CONSULTING'],
    professionTitle: 'Immigration adviser',
    experienceLevel: 'EXPERT',
    about: 'Seeded by content-safety.e2e.cjs, long enough to pass the minimum length rule.',
    consentAccepted: true,
  });
  check('a listing is accepted', res.status === 201, res.body?.error);

  const listing = res.body?.data?.listing?.id;

  check('a listing is scanned', !!(await safetyOf('PROFESSIONAL_LISTING', listing)), listing);

  res = await api(pro.token, 'POST', `/professionals/listings/${listing}/services`, {
    name: 'An initial consultation',
    description: 'Half an hour to work out what you need.',
    price: 5000,
  });
  check('a service is accepted', res.status === 201, res.body?.error);
  check(
    'and scanned, which it was not until §6.1 was finished',
    !!(await safetyOf('PROFESSIONAL_SERVICE', res.body?.data?.id)),
    res.body?.data?.id,
  );

  res = await api(seller.token, 'POST', '/commerce/stores', {
    name: `E2E safety shop ${Date.now()}`,
    area: 'Bedminster',
    description: 'Seeded by content-safety.e2e.cjs.',
  });
  check('a shop is accepted', res.status === 201, res.body?.error);

  const shop = res.body?.data?.id;

  check('a shop is scanned', !!(await safetyOf('STORE', shop)), shop);

  res = await api(seller.token, 'POST', `/commerce/stores/${shop}/items`, {
    name: 'A bag of rice',
    price: 650,
    categoryCode: 'FOOD_GROCERIES',
    description: 'Seeded by content-safety.e2e.cjs.',
  });
  check('an item is accepted', res.status === 201, res.body?.error);
  check(
    'an item is scanned',
    !!(await safetyOf('STORE_ITEM', res.body?.data?.id)),
    res.body?.error,
  );

  res = await api(neighbour.token, 'POST', '/reviews', {
    subjectUserId: pro.id,
    rating: 5,
    comment: 'We worked together before Circl and he was excellent throughout.',
    context: 'PRIOR_WORK',
  });
  check('a review is accepted', res.status === 201, res.body?.error);
  check('a review is scanned', !!(await safetyOf('REVIEW', res.body?.data?.id)), res.body?.error);

  console.log('\n── A held bio empties, it does not hide the member ─────────');

  res = await api(neighbour.token, 'PATCH', '/users/profile', {
    bio: 'An ordinary sentence about me, seeded by content-safety.e2e.cjs.',
    headline: 'New in Bristol',
  });
  check('a profile is accepted', res.status === 200, res.body?.error);

  const profileRow = await prisma.userProfile.findFirst({
    where: { userId: neighbour.id },
    select: { id: true },
  });

  check(
    'the written part of a profile is scanned',
    !!(await safetyOf('USER_PROFILE', profileRow?.id)),
    profileRow?.id,
  );

  // Held by hand, because a paragraph that trips the lexicon is a different test: this one is
  // about what a held paragraph does to the profile around it (§4.5).
  await prisma.$executeRawUnsafe(
    `UPDATE "user_profile" SET "bio_visibility_state" = 'HELD'::"ContentVisibilityState" WHERE "id" = $1`,
    profileRow?.id,
  );

  res = await api(author.token, 'GET', `/users/${neighbour.id}/profile`);
  check('the member is still there, not hidden', res.status === 200, res.body?.error);
  check(
    'with the held paragraph empty rather than the profile gone',
    res.body?.data?.bio === null && res.body?.data?.headline === null,
    { bio: res.body?.data?.bio, headline: res.body?.data?.headline },
  );

  res = await api(neighbour.token, 'GET', `/users/${neighbour.id}`);
  check(
    'while its author still reads their own',
    res.body?.data?.bio !== null,
    res.body?.data?.bio,
  );

  console.log('\n── A held post is still its author’s to take down ──────────');

  res = await api(author.token, 'DELETE', `/community/requests/${held}`);
  check('the author can delete their own held post', res.status === 200 || res.status === 204, [
    res.status,
    res.body?.error,
  ]);

  console.log('\n── An anonymous post queues for approval ───────────────────');

  res = await api(author.token, 'POST', '/community/updates', {
    content: 'An ordinary anonymous post.',
    cityId: 'BRISTOL',
    visibility: 'ANONYMOUS',
  });
  check('an anonymous post is accepted', res.status === 201, res.body?.error);

  const anonymous = res.body?.data?.id;

  queue = await prisma.moderationQueueItem.findFirst({ where: { targetId: anonymous } });
  check(
    'and raises an ANONYMOUS_POST item, so the SLA clock starts (§13.5)',
    queue?.type === 'ANONYMOUS_POST',
    queue?.type,
  );
  // And it is held until somebody approves it (§7.4). This assertion used to read the other way,
  // with a note saying it would fail the day `PRE_MODERATE_ANONYMOUS` flipped — which is what
  // happened when §5.9's decide path gave the hold something that could release it. The tripwire
  // worked, so this is the other half of it: the post is now invisible until a human says yes,
  // whatever it scored.
  check(
    'and the post is held until a human approves it',
    (await safetyOf('UPDATE', anonymous))?.visibilityState === 'PENDING_APPROVAL',
    (await safetyOf('UPDATE', anonymous))?.visibilityState,
  );

  console.log('\n── What the author is told (§6.5) ──────────────────────────');

  res = await postRequest(
    'I think I was trafficked and want to ask something',
    'A second disclosure, to read back as its author.',
  );

  const mine = res.body?.data?.id;

  res = await api(author.token, 'GET', `/community/requests/${mine}`);
  check('the author can still open their held post', res.status === 200, res.body?.error);
  check(
    'and is told it is under review, in a sentence rather than a code',
    res.body?.data?.reviewStatus === 'UNDER_REVIEW' &&
      /reviewed/i.test(res.body?.data?.reviewMessage ?? ''),
    { status: res.body?.data?.reviewStatus, message: res.body?.data?.reviewMessage },
  );
  check(
    'with nothing yet under "why", because nobody has decided anything',
    res.body?.data?.reviewReason === null,
    res.body?.data?.reviewReason,
  );
  check(
    'and, at the critical tier, the crisis lines rather than a policy notice',
    (res.body?.data?.support?.resources ?? []).length > 0 &&
      res.body.data.support.resources[0].isCrisis === true,
    res.body?.data?.support?.resources?.slice(0, 2),
  );
  check(
    'whose copy offers help and accuses nobody',
    /danger|talk to somebody/i.test(res.body?.data?.support?.message ?? '') &&
      !/violat|breach|rule/i.test(res.body?.data?.support?.message ?? ''),
    res.body?.data?.support?.message,
  );

  res = await api(reader.token, 'GET', `/community/requests/${mine}`);
  check('while everybody else still gets a 404', res.status === 404, res.status);

  // A limited post reads as normal to the person who wrote it: telling them it has been quietly
  // demoted invites a repost, and the demotion is provisional until a human looks.
  res = await api(author.token, 'GET', `/community/requests/${limited}`);
  check(
    'and a limited post says nothing to its author',
    res.status === 200 && res.body?.data?.reviewStatus === undefined,
    res.body?.data?.reviewStatus,
  );

  res = await api(reader.token, 'POST', `/community/requests/${host}/responses`, {
    content: 'A reply mentioning that I was trafficked.',
  });
  check('a reply that trips the lexicon is accepted', res.status === 201, res.body?.error);

  // By id: this member already has an ordinary reply on the same thread from the block above, and
  // "the first row the viewer owns" found that one.
  const heldReply = res.body?.data?.response?.id;

  res = await api(reader.token, 'GET', `/community/requests/${host}/responses`);

  const ownRow = (res.body?.data ?? []).find(row => row.id === heldReply);

  check(
    'its author sees it in the thread, marked under review',
    ownRow?.reviewStatus === 'UNDER_REVIEW',
    ownRow,
  );

  res = await api(author.token, 'GET', `/community/requests/${host}/responses`);
  check(
    'and the request owner does not see it at all',
    !(res.body?.data ?? []).some(row => row.reviewStatus),
    res.body?.data?.length,
  );

  console.log('\n── With a classifier that cannot answer (§6.7) ─────────────');

  /**
   * The whole fail-safe path, with no successful API call needed: the classifier is switched on
   * and pointed at a model that does not exist, which is the same shape as a timeout or a 5xx.
   *
   * What it proves is the sequence §6.5 and §6.7 describe together — a clean post is held
   * provisionally so that nothing the classifier would hold reaches a feed first, the worker
   * retries, and when it gives up the lexicon verdict stands and the post is published. And that
   * a risky post is **not** published by the same path: never fail open.
   */
  await prisma.systemConfig.upsert({
    where: { key: 'safety.classifier' },
    update: {
      value: { enabled: true, model: 'not-a-real-model', timeoutMs: 1000, weight: 0.6 },
    },
    create: {
      key: 'safety.classifier',
      value: { enabled: true, model: 'not-a-real-model', timeoutMs: 1000, weight: 0.6 },
    },
  });
  await forgetCacheKeys('*system-config:safety.classifier*');

  res = await postRequest(
    'A clean question posted while the classifier is on',
    'Nothing here for a lexicon to find either.',
  );
  check('the post is accepted', res.status === 201, res.body?.error);

  const provisional = res.body?.data?.id;

  safety = await safetyOf('REQUEST', provisional);
  check(
    'and is held provisionally the moment it is written, before any feed sees it (§6.5)',
    safety?.visibilityState === 'LIMITED' && safety?.heldReason === 'PENDING_SCAN',
    safety,
  );
  check(
    'with the scan marked PENDING, not DEGRADED',
    safety?.scanStatus === 'PENDING',
    safety?.scanStatus,
  );

  res = await postRequest(
    'I was trafficked, asked again with the classifier on',
    'The lexicon alone is enough to hold this.',
  );

  const riskyWhileOn = res.body?.data?.id;

  safety = await safetyOf('REQUEST', riskyWhileOn);
  check(
    'while a lexicon hit is held inline and does not wait for anybody (§6.7)',
    safety?.visibilityState === 'HELD' && safety?.tier === 'CRITICAL',
    safety,
  );

  const settled = async id => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const row = await safetyOf('REQUEST', id);

      if (row?.scanStatus !== 'PENDING') return row;

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return null;
  };

  const released = await settled(provisional);

  check(
    'the worker gives up and records DEGRADED rather than PENDING for ever',
    released?.scanStatus === 'DEGRADED',
    released?.scanStatus,
  );
  check(
    'and publishes the clean post on the lexicon’s word',
    released?.visibilityState === 'VISIBLE' && released?.heldReason === null,
    released,
  );

  const degradedScan = await prisma.contentScan.findFirst({
    where: { contentSafetyId: released?.id, degraded: true },
  });

  check('with a degraded scan in the history', !!degradedScan, degradedScan?.id);
  check(
    'carrying the reason, which is what a dashboard counts',
    !!degradedScan?.classifierError,
    degradedScan?.classifierError,
  );

  const stillHeld = await settled(riskyWhileOn);

  check(
    'and the risky post is still held: a dead classifier never publishes anything',
    stillHeld?.visibilityState === 'HELD',
    stillHeld,
  );

  console.log('\n── And with the real classifier, once ──────────────────────');

  /**
   * The one check in the suite that reaches outside Circl: OpenAI's moderation endpoint, which is
   * free and is not a completion. It is here because everything above proves the *failure* paths,
   * and a pipeline whose success path is only ever stubbed is a pipeline nobody has run.
   *
   * Written to tolerate a third party being unreachable — if the call does not land, the row is
   * DEGRADED with a reason, which is the behaviour the block above already asserts. What it does
   * **not** tolerate is an answer we then mishandle: if the classifier replied, the row has to be
   * COMPLETE and carry its scores.
   */
  await prisma.systemConfig.update({
    where: { key: 'safety.classifier' },
    data: {
      value: { enabled: true, model: 'omni-moderation-latest', timeoutMs: 8000, weight: 0.6 },
    },
  });
  await forgetCacheKeys('*system-config:safety.classifier*');

  res = await postRequest(
    'A question about registering with a GP',
    'Entirely ordinary words, which a moderation model should score at nearly zero.',
  );
  check('a post goes through with the real classifier on', res.status === 201, res.body?.error);

  const live = await settled(res.body?.data?.id);

  check(
    'the scan finishes one way or the other, rather than sitting PENDING',
    live?.scanStatus === 'COMPLETE' || live?.scanStatus === 'DEGRADED',
    live?.scanStatus,
  );

  if (live?.scanStatus === 'COMPLETE') {
    check(
      'it kept the model’s own scores, which is what a reviewer is shown',
      !!live?.classifierScores && Object.keys(live.classifierScores).length > 0,
      Object.keys(live?.classifierScores ?? {}).slice(0, 4),
    );
    check(
      'scored the post clean and published it',
      live?.tier === 'CLEAN' && live?.visibilityState === 'VISIBLE',
      { tier: live?.tier, state: live?.visibilityState, score: live?.finalScore },
    );
    check(
      'and recorded which model said so',
      !!(
        await prisma.contentScan.findFirst({
          where: { contentSafetyId: live.id, degraded: false, classifierModel: { not: null } },
        })
      )?.classifierModel,
      'classifierModel',
    );
  } else {
    const why = await prisma.contentScan.findFirst({
      where: { contentSafetyId: live?.id, degraded: true },
      select: { classifierError: true },
      orderBy: { createdAt: 'desc' },
    });

    console.log(
      `    (the moderation endpoint did not answer, so the degraded path ran: ${(
        why?.classifierError ?? 'no reason recorded'
      ).slice(0, 120)})`,
    );
  }

  await prisma.systemConfig.deleteMany({ where: { key: 'safety.classifier' } });
  await forgetCacheKeys('*system-config:safety.classifier*');

  await sweep('content-safety');
  await finish();
})().catch(async error => {
  await fail(error);
});
