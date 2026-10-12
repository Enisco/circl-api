/* §6.1 Images: the last row of the scan table.
 *
 * Two halves, and only one of them can be proven end to end here.
 *
 * A photo inside a post is scanned **as part of the post**: the worker now sends the post's images
 * to the classifier alongside its words, and the post's own verdict is what holds them. That half
 * needs a classifier to demonstrate, and this environment has a placeholder API key, so it is
 * asserted in `content-safety-finalise.spec.ts` instead — the images reach the call.
 *
 * An avatar has no post to be part of, so it is scanned on its own target (`MEDIA`) and keeps its
 * verdict in `media.moderationState`. That is what this suite is about: the row is written, the
 * key is set, a replacement is scanned in its turn, and staff removing one leaves the member
 * standing with no photo rather than no account.
 *
 * There is nothing in a JPEG for a lexicon to read, so every verdict here is CLEAN and DEGRADED —
 * which is the honest state of image moderation until the classifier is switched on, and the
 * reason the hold itself is unit-tested (`media-moderation.spec.ts`).
 */
const {
  adminHeaders,
  api,
  check,
  fail,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
  uploadPng,
} = require('./harness.cjs');

const safetyOf = targetId =>
  prisma.contentSafety.findUnique({
    where: { targetType_targetId: { targetType: 'MEDIA', targetId } },
  });

(async () => {
  await sweep('pre-run');

  const member = await makeUser('img-member', { cityId: 'BRISTOL' });

  console.log('\n── An avatar is scanned on its own ─────────────────────────');

  const firstKey = await uploadPng(member.token, 'AVATAR', 400, 400);

  check('a photo is uploaded', !!firstKey, firstKey);

  let res = await api(member.token, 'PATCH', '/users/profile', { avatarKey: firstKey });

  check('and set as the avatar', res.status === 200, res.body?.error);

  const first = await prisma.media.findFirst({ where: { storageKey: firstKey } });

  check(
    'it is attached to the member, as an avatar',
    first?.ownerType === 'USER_AVATAR' && first?.ownerId === member.id,
    { ownerType: first?.ownerType, ownerId: first?.ownerId },
  );

  let safety = await safetyOf(first.id);

  check('a safety row is written for the image itself', !!safety, safety);
  check(
    'under MEDIA, keyed on the media row rather than the profile',
    safety?.targetType === 'MEDIA' && safety?.targetId === first.id,
    { targetType: safety?.targetType, targetId: safety?.targetId },
  );
  check(
    'authored by the member, so a verdict has somebody to tell',
    safety?.authorId === member.id,
    safety?.authorId,
  );
  check(
    'CLEAN and DEGRADED: there is nothing in a photo for a lexicon to read',
    safety?.tier === 'CLEAN' && safety?.scanStatus === 'DEGRADED' && safety?.finalScore === 0,
    { tier: safety?.tier, scanStatus: safety?.scanStatus, finalScore: safety?.finalScore },
  );
  check(
    'and the verdict is mirrored onto the image, not onto the profile',
    first?.moderationState === 'VISIBLE' &&
      (await prisma.userProfile.findUnique({ where: { userId: member.id } }))
        ?.bioVisibilityState === 'VISIBLE',
    first?.moderationState,
  );

  const profile = await prisma.user.findUnique({ where: { id: member.id } });

  check('the member is wearing it', profile?.avatarKey === firstKey, profile?.avatarKey);

  res = await api(member.token, 'GET', '/users/profile');

  check(
    'and sees it on their own profile',
    res.status === 200 && !!res.body?.data?.avatarUrl,
    res.body?.data?.avatarUrl ?? res.body?.error,
  );

  console.log('\n── The written part of the profile is a separate target ────');

  const scans = await prisma.contentSafety.findMany({
    where: { authorId: member.id },
    select: { targetType: true },
  });

  check(
    'two scans, about two different things: the photo and the paragraph',
    scans.filter(row => row.targetType === 'MEDIA').length === 1 &&
      scans.filter(row => row.targetType === 'USER_PROFILE').length === 1,
    scans.map(row => row.targetType),
  );
  console.log(
    '    (a photo nobody should see is no reason to hold a paragraph that is fine, which is why ' +
      'the avatar is not scanned as a field of the profile)',
  );

  console.log('\n── A replacement is scanned in its turn ────────────────────');

  const secondKey = await uploadPng(member.token, 'AVATAR', 420, 420);

  res = await api(member.token, 'PATCH', '/users/profile', { avatarKey: secondKey });

  check('the avatar is replaced', res.status === 200, res.body?.error);

  const second = await prisma.media.findFirst({ where: { storageKey: secondKey } });

  check(
    'the new photo has a scan of its own',
    !!(await safetyOf(second.id)),
    await safetyOf(second.id),
  );
  check(
    'the old photo is gone rather than left attached for ever',
    !(await prisma.media.findUnique({ where: { id: first.id } })),
    await prisma.media.findUnique({ where: { id: first.id }, select: { ownerId: true } }),
  );
  check(
    'and its verdict went with it: nothing cascades to a polymorphic table, so this is deliberate',
    !(await safetyOf(first.id)),
    await safetyOf(first.id),
  );
  console.log(
    '    (a verdict left behind would be a scan of nothing, which `safety.rescan-degraded` ' +
      're-queues and the worker can never finish)',
  );

  console.log('\n── A held photo tells the member why it went ──────────────');

  // The two writes a verdict makes, by hand: the state on the image and the cleared key. They are
  // unreachable from the API with the classifier off — there is nothing in a photo for a lexicon
  // to match — and the statements that make them are covered by `media-moderation.spec.ts`. What
  // this block is about is the half a member can see.
  await prisma.media.update({ where: { id: second.id }, data: { moderationState: 'HELD' } });
  await prisma.user.update({ where: { id: member.id }, data: { avatarKey: null } });

  res = await api(member.token, 'GET', '/users/profile');

  check(
    'their own profile says the photo is being reviewed (§6.5)',
    res.body?.data?.avatarReview?.reviewStatus === 'UNDER_REVIEW',
    res.body?.data?.avatarReview,
  );
  check(
    'in words, not a code',
    (res.body?.data?.avatarReview?.reviewMessage ?? '').length > 20,
    res.body?.data?.avatarReview?.reviewMessage,
  );
  check(
    'and the photo itself is gone from it',
    !res.body?.data?.avatarUrl,
    res.body?.data?.avatarUrl,
  );

  await prisma.media.update({ where: { id: second.id }, data: { moderationState: 'REJECTED' } });

  res = await api(member.token, 'GET', '/users/profile');

  check(
    'a refusal reads differently from a review in progress',
    res.body?.data?.avatarReview?.reviewStatus === 'NOT_APPROVED',
    res.body?.data?.avatarReview,
  );

  const bare = await makeUser('img-bare', { cityId: 'BRISTOL' });

  res = await api(bare.token, 'GET', '/users/profile');

  check(
    'and a member who never uploaded one is told nothing at all',
    res.status === 200 && res.body?.data?.avatarReview === null,
    res.body?.data?.avatarReview,
  );

  console.log('\n── Staff removing an avatar leaves the member standing ─────');

  const boss = await makeAdmin('img-boss');
  const item = await prisma.moderationQueueItem.create({
    data: {
      // §5.9: both required since the queue gained a deadline. Non-nullable on purpose — an
      // item that can never be overdue sorts last in a queue ordered by urgency.
      priority: 'NORMAL',
      dueAt: new Date(Date.now() + 24 * 3_600_000),
      type: 'FLAGGED_CONTENT',
      targetType: 'MEDIA',
      targetId: second.id,
      subjectUserId: member.id,
      riskLevel: 'HIGH',
      riskScore: 70,
      summary: 'Profile photo',
    },
  });

  res = await api(
    null,
    'POST',
    `/admin/moderation/queue/${item.id}/decide`,
    { decision: 'REMOVE_CONTENT', reasonCode: 'SAFETY_CONCERN', note: 'e2e image safety' },
    adminHeaders(boss),
  );

  check('a reviewer removes the photo', res.status < 300, [res.status, res.body?.error?.message]);

  const afterRemoval = await prisma.user.findUnique({ where: { id: member.id } });

  check(
    'the member is no longer wearing it',
    afterRemoval?.avatarKey === null,
    afterRemoval?.avatarKey,
  );
  check(
    'the account is untouched: a photo is not a person',
    afterRemoval?.status === 'ACTIVE' && afterRemoval?.deletedAt === null,
    { status: afterRemoval?.status, deletedAt: afterRemoval?.deletedAt },
  );
  check(
    'and the object is gone',
    !(await prisma.media.findUnique({ where: { id: second.id } })),
    await prisma.media.findUnique({ where: { id: second.id } }),
  );

  res = await api(member.token, 'GET', '/users/profile');

  check(
    'their profile renders with no photo, as it did before they set one',
    res.status === 200 && !res.body?.data?.avatarUrl,
    res.body?.data?.avatarUrl ?? res.body?.error,
  );

  await prisma.moderationQueueItem.deleteMany({ where: { id: item.id } });

  await sweep('image-safety');
  await finish();
})().catch(async error => {
  await fail(error);
});
