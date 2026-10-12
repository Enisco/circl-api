'use strict';

/**
 * §2.9 — approval for listings in gated professions, and §13.2 — telling a suspended member so.
 *
 * Two features in one script because they are one deploy and they share a cast: a member, a
 * listing, and a staff member who decides about both.
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
  uploadDocument,
} = require('./harness.cjs');

const GATED = 'IMMIGRATION';
const OPEN = 'TECH_SOFTWARE';

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const listingBody = (overrides = {}) => ({
  professionTitle: 'Immigration paperwork help',
  experienceLevel: 'MID_LEVEL',
  about: 'I help people with visa applications and settled status paperwork in Manchester.',
  categoryCodes: [GATED],
  cityId: 'MANCHESTER',
  consentAccepted: true,
  ...overrides,
});

/**
 * A gated profession needs 1–5 supporting documents (§2.9), so every create here carries one.
 *
 * `listing-documents.e2e.cjs` owns the document rules themselves — the types, the counts, the
 * content check. This suite is about the **gate**, so it needs only enough to get through it.
 */
const withDocument = async (token, overrides = {}) => {
  const doc = await uploadDocument(token, { fileName: 'qualification.pdf' });

  return listingBody({ documentIds: [doc.id], ...overrides });
};

async function main() {
  console.log('═══ test listing-review ═══');

  const adviser = await makeUser('gated-adviser');
  const coder = await makeUser('ungated-coder');
  const browser = await makeUser('listing-browser');
  const staff = await makeAdmin('listing-reviewer');
  const headers = adminHeaders(staff);

  // ── 1. The taxonomy tells the client which professions are gated ──────────
  heading('1. the flag is data the client can read');

  const taxonomy = await api(null, 'GET', '/taxonomy');
  const professions = taxonomy.body?.data?.professions ?? [];
  const gatedTerm = professions.find(term => term.code === GATED);
  const openTerm = professions.find(term => term.code === OPEN);

  check('GET /taxonomy answers', taxonomy.status === 200, taxonomy.status);
  check('a gated profession says so', gatedTerm?.requiresReview === true, gatedTerm);
  check('an ungated one says so too', openTerm?.requiresReview === false, openTerm);
  // The two flags are different questions, and with the seven defaults they happen to hold the
  // same value on every profession — so there is nothing to assert here beyond the fields being
  // separate. What makes them independent is that one is a fact about the world and the other is a
  // decision somebody takes in the portal, and section 14 proves it by gating a profession whose
  // `isRegulated` is false and watching the two diverge. Asserting a divergence *here* would be
  // asserting today's default data: a check that passes until somebody changes a setting.
  check(
    'both flags are present, and separate fields',
    professions.every(
      term => typeof term.requiresReview === 'boolean' && typeof term.isRegulated === 'boolean',
    ),
    professions.find(term => typeof term.requiresReview !== 'boolean'),
  );

  // ── 2. A gated listing is held on create ──────────────────────────────────
  heading('2. a gated listing is held, and the member is told why');

  const created = await api(
    adviser.token,
    'POST',
    '/professionals/listings',
    await withDocument(adviser.token),
  );

  check('listing created', created.status === 201, created.status || created.body);

  const listingId = created.body?.data?.listing?.id;
  const review = created.body?.data?.listing?.review;

  check('it comes back with a review block', !!review, created.body?.data?.listing);
  check('state is PENDING', review?.state === 'PENDING', review?.state);
  check('it is not public yet', review?.isPublic === false, review?.isPublic);
  check('submittedAt is set', !!review?.submittedAt, review?.submittedAt);
  check(
    'the member is told what is happening, in a sentence',
    typeof review?.message === 'string' && review.message.length > 20,
    review?.message,
  );
  check(
    'the registration stepper gained a REVIEW step',
    (created.body?.data?.steps ?? []).some(step => step.key === 'REVIEW'),
    created.body?.data?.steps,
  );

  const row = await prisma.professionalListing.findUnique({
    where: { id: listingId },
    select: { reviewState: true, visibilityState: true },
  });

  check('the row records PENDING', row?.reviewState === 'PENDING', row?.reviewState);
  check(
    'and the visibility column every read path filters on says PENDING_APPROVAL',
    row?.visibilityState === 'PENDING_APPROVAL',
    row?.visibilityState,
  );

  const safety = await prisma.contentSafety.findUnique({
    where: { targetType_targetId: { targetType: 'PROFESSIONAL_LISTING', targetId: listingId } },
    select: { heldReason: true },
  });

  check(
    'the hold says it is waiting for approval, not that something is wrong with it',
    safety?.heldReason === 'AWAITING_APPROVAL',
    safety?.heldReason,
  );

  // ── 3. Nobody can find it ─────────────────────────────────────────────────
  heading('3. a held listing is not reachable by anybody but its owner');

  const browseList = await api(
    browser.token,
    'GET',
    `/professionals?categoryCode=${GATED}&limit=50`,
  );
  const direct = await api(browser.token, 'GET', `/professionals/${listingId}`);
  const owner = await api(adviser.token, 'GET', '/professionals/me');
  const ownerListing = owner.body?.data?.listing ?? owner.body?.data;

  check(
    'it is not in the browse list',
    !JSON.stringify(browseList.body?.data ?? []).includes(listingId),
    browseList.status,
  );
  check('a direct link is a 404', direct.status === 404, direct.status);
  check('but its owner still sees it', ownerListing?.id === listingId, owner.status);
  check(
    "and the owner's copy carries the review block",
    ownerListing?.review?.state === 'PENDING',
    ownerListing?.review,
  );

  // ── 4. The review queue ───────────────────────────────────────────────────
  heading('4. the review queue');

  const queue = await api(
    null,
    'GET',
    '/admin/professional-reviews?perPage=100',
    undefined,
    headers,
  );

  check('the queue answers', queue.status === 200, queue.status || queue.body);

  const queued = (queue.body?.data ?? []).find(entry => entry.id === listingId);

  check('the new listing is in it', !!queued, (queue.body?.data ?? []).length);
  check('with the member on the row', queued?.member?.id === adviser.id, queued?.member);
  check('and the gated category named', queued?.category?.code === GATED, queued?.category);
  // `isLiveWhileWaiting` and `meta.liveWhileWaitingCount` are gone: a PENDING listing is hidden,
  // always, so there is nothing for them to distinguish.
  check(
    'the row no longer carries a live-while-waiting flag',
    !('isLiveWhileWaiting' in (queued ?? {})),
    Object.keys(queued ?? {}),
  );

  const detail = await api(
    null,
    'GET',
    `/admin/professional-reviews/${listingId}`,
    undefined,
    headers,
  );

  check('the detail answers', detail.status === 200, detail.status);
  check('it carries the about paragraph', !!detail.body?.data?.about, detail.body?.data?.about);
  check(
    'and names which of its professions need approving',
    (detail.body?.data?.gatedCategories ?? []).some(
      entry => entry.code === GATED && typeof entry.label === 'string',
    ),
    detail.body?.data?.gatedCategories,
  );
  // The regulator checklist is gone (§2.9): a reviewer reads the documents rather than checking a
  // registration number against a register by hand.
  check(
    'without the regulator checklist, which the documents replaced',
    (detail.body?.data?.gatedCategories ?? []).every(entry => !('credentialBodies' in entry)),
    detail.body?.data?.gatedCategories,
  );
  check(
    'and says plainly that nothing has been verified',
    detail.body?.data?.consent?.accepted === true,
    detail.body?.data?.consent,
  );
  check(
    "and the author's strike count",
    detail.body?.data?.author?.activeStrikes === 0,
    detail.body?.data?.author,
  );

  // ── 5. A decline needs something the member can act on ───────────────────
  heading('5. a decline has to tell the member what to change');

  await api(null, 'POST', `/admin/professional-reviews/${listingId}/claim`, {}, headers);

  const bare = await api(
    null,
    'POST',
    `/admin/professional-reviews/${listingId}/decide`,
    { outcome: 'REJECTED', reasonCode: 'SAFETY_CONCERN', note: 'No registration number.' },
    { ...headers, 'Idempotency-Key': `e2e-bare-${Date.now()}` },
  );

  check('a decline with no message is refused', bare.status === 400, bare.status);
  check(
    'and the refusal names the field',
    (bare.body?.error?.details ?? []).some(entry => entry.field === 'memberMessage'),
    bare.body?.error,
  );

  const declined = await api(
    null,
    'POST',
    `/admin/professional-reviews/${listingId}/decide`,
    {
      outcome: 'REJECTED',
      reasonCode: 'SAFETY_CONCERN',
      note: 'No IAA registration number given for immigration advice.',
      memberMessage: 'Please add your IAA registration number to your about section.',
    },
    { ...headers, 'Idempotency-Key': `e2e-decline-${Date.now()}` },
  );

  check('the decline lands', declined.status === 200, declined.status || declined.body);
  check(
    'the row is REJECTED',
    declined.body?.data?.reviewState === 'REJECTED',
    declined.body?.data,
  );

  const afterDecline = await api(adviser.token, 'GET', '/professionals/me');
  const declinedReview = (afterDecline.body?.data?.listing ?? afterDecline.body?.data)?.review;

  check('the member sees REJECTED', declinedReview?.state === 'REJECTED', declinedReview?.state);
  check(
    'and reads the reviewer’s words verbatim',
    declinedReview?.note === 'Please add your IAA registration number to your about section.',
    declinedReview?.note,
  );
  check('and it is still not public', declinedReview?.isPublic === false, declinedReview?.isPublic);

  // The client routes a notification on `target.type`, and there is no target type for a listing,
  // so the row has to carry a `route` or it opens nothing. A rejection opens the *form*: the body
  // tells the member to change something, and a read-only screen is where that instruction dies.
  const declineRow = await prisma.notification.findFirst({
    where: { userId: adviser.id, title: { contains: 'not approved' } },
    orderBy: { createdAt: 'desc' },
    select: { route: true },
  });

  check(
    'the decline notification opens the edit form, not a read-only screen',
    declineRow?.route === '/professionals/me/edit',
    declineRow,
  );

  // ── 6. Editing a declined listing resubmits it ────────────────────────────
  heading('6. fixing it and saving sends it back');

  // A declined listing is **not** locked: choosing a different profession is one of the two things
  // a resubmission is for, and the member cannot see the listing meanwhile.
  //
  // Deliberately gated → **gated**. Moving a declined listing into an *ungated* profession
  // publishes it immediately, and a published listing is locked — so that edit is a one-way door
  // the member cannot come back through. It is what the rule says, and it is flagged to both
  // clients rather than exercised here, because doing it mid-suite would strand this fixture live
  // in the wrong profession for every check after it.
  const reProfession = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    categoryCodes: ['LEGAL'],
    professionTitle: 'Legal Adviser',
    documentIds: [(await uploadDocument(adviser.token)).id],
  });

  check(
    'a declined listing may change its profession',
    reProfession.status === 200,
    reProfession.status || reProfession.body?.error,
  );
  check(
    'and the new gated profession is judged like a new account: waiting, and hidden',
    reProfession.body?.data?.review?.state === 'PENDING' &&
      reProfession.body?.data?.review?.isPublic === false,
    reProfession.body?.data?.review,
  );

  // Back to the profession the rest of this section is about. Still allowed: it is PENDING now,
  // and a listing nobody can see yet is not locked.
  const backToGated = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    categoryCodes: [GATED],
    professionTitle: 'Immigration Adviser',
    documentIds: [(await uploadDocument(adviser.token)).id],
  });

  check(
    'and a waiting listing may change it again',
    backToGated.status === 200 && backToGated.body?.data?.review?.state === 'PENDING',
    backToGated.body?.data?.review ?? backToGated.body?.error,
  );

  const resubmitted = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    about: 'I help with visa applications. IAA registration F2026-1234, Manchester based.',
  });

  check('the edit is accepted', resubmitted.status === 200, resubmitted.status || resubmitted.body);
  check(
    'and it is PENDING again',
    resubmitted.body?.data?.review?.state === 'PENDING',
    resubmitted.body?.data?.review,
  );

  const reopened = await prisma.moderationQueueItem.findFirst({
    where: { type: 'PROFESSIONAL_REVIEW', targetId: listingId },
    select: { state: true, decision: true, assignedToId: true },
  });

  // The trap this whole feature kept walking into: the generic enqueue refreshes an item without
  // reopening it, which is right for a flag and wrong here. A member who fixed their listing must
  // not wait on a review that reads as already done.
  check('its queue item is PENDING again', reopened?.state === 'PENDING', reopened?.state);
  check('with the old decision cleared', reopened?.decision === null, reopened?.decision);
  check('and nobody holding it', reopened?.assignedToId === null, reopened?.assignedToId);

  const stillHidden = await api(browser.token, 'GET', `/professionals/${listingId}`);

  check('and it is still not reachable', stillHidden.status === 404, stillHidden.status);

  // ── 7. Approval publishes it ──────────────────────────────────────────────
  heading('7. approval publishes it');

  await api(null, 'POST', `/admin/professional-reviews/${listingId}/claim`, {}, headers);

  const approved = await api(
    null,
    'POST',
    `/admin/professional-reviews/${listingId}/decide`,
    {
      outcome: 'APPROVED',
      reasonCode: 'CORRECTION',
      note: 'IAA number checked against the register.',
    },
    { ...headers, 'Idempotency-Key': `e2e-approve-${Date.now()}` },
  );

  check('the approval lands', approved.status === 200, approved.status || approved.body);

  const live = await api(browser.token, 'GET', `/professionals/${listingId}`);
  const ownerAfter = await api(adviser.token, 'GET', '/professionals/me');
  const ownerAfterListing = ownerAfter.body?.data?.listing ?? ownerAfter.body?.data;

  check('anybody can reach it now', live.status === 200, live.status);
  check(
    'the member sees APPROVED',
    ownerAfterListing?.review?.state === 'APPROVED',
    ownerAfterListing?.review,
  );
  check(
    'and that it is public',
    ownerAfterListing?.review?.isPublic === true,
    ownerAfterListing?.review,
  );
  const approvalRow = await prisma.notification.findFirst({
    where: { userId: adviser.id, title: { contains: 'is approved' } },
    orderBy: { createdAt: 'desc' },
    select: { route: true },
  });

  check('the member was told', approvalRow !== null);
  check('and the row opens their listing', approvalRow?.route === '/professionals/me', approvalRow);

  // ── 7b. A live listing's profession is fixed ─────────────────────────────
  heading('7b. the profession is locked once the listing is live');

  // The app sends `categoryCodes` on **every** edit, including a price change. Refusing an
  // identical set would refuse every edit a live professional ever makes, so the lock compares the
  // set and not the request. (This listing carries one profession, so order is not exercised here;
  // the comparison itself is order-independent — see `categoriesChanged`.)
  const sameSet = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    categoryCodes: [GATED],
    priceFrom: 5500,
  });

  check(
    'resending the same professions with another change is accepted',
    sameSet.status === 200,
    sameSet.status || sameSet.body?.error,
  );
  check(
    'and it does not re-open a review, because nothing a reviewer reads changed',
    sameSet.body?.data?.review?.state === 'APPROVED',
    sameSet.body?.data?.review,
  );

  const switched = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    categoryCodes: [OPEN],
  });

  check(
    'but changing them on a live listing is refused',
    switched.status === 409 && switched.body?.error?.code === 'PROFESSION_LOCKED',
    { status: switched.status, error: switched.body?.error?.code },
  );
  // Asserted at its real location — **top-level** `data`, the same envelope as the suspension
  // payload — rather than `?? switched.body?.error?.data`. Accepting either is how the client doc
  // came to say `error.data`: a check that passes wherever the field happens to be cannot tell a
  // client where to look for it.
  check(
    'with the current set named at the top level, so the app can render what it is locked to',
    Array.isArray(switched.body?.data?.current) &&
      switched.body.data.current[0] === GATED &&
      switched.body?.data?.reviewState === 'APPROVED',
    switched.body?.data,
  );

  const unchangedAfter = await prisma.professionalListingCategory.findMany({
    where: { listingId },
    select: { code: true },
  });

  check(
    'and nothing changed — a refusal that half-applied would be worse than none',
    unchangedAfter.length === 1 && unchangedAfter[0].code === GATED,
    unchangedAfter.map(row => row.code),
  );

  // ── 8. The decision outlives the next edit ────────────────────────────────
  heading('8. an approved listing that rewrites itself comes back');

  const priceOnly = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    priceFrom: 5000,
  });

  check(
    'a price change does not re-open a review',
    priceOnly.body?.data?.review?.state === 'APPROVED',
    priceOnly.body?.data?.review,
  );

  const rewritten = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    about: 'Actually I can also sort your Home Office appeal and your tax return, cash only.',
  });

  check('rewriting the about paragraph does', rewritten.body?.data?.review?.state === 'PENDING', {
    status: rewritten.status,
    error: rewritten.body?.error,
    review: rewritten.body?.data?.review,
  });
  check(
    'and it goes back out of sight while it waits',
    rewritten.body?.data?.review?.isPublic === false,
    rewritten.body?.data?.review,
  );

  const trail = await prisma.moderationAction.findMany({
    where: { targetType: 'PROFESSIONAL_LISTING', targetId: listingId },
    select: { decision: true },
  });

  check(
    'both decisions survive the edit that cleared the safety reviewer',
    trail.length === 2 &&
      trail.some(e => e.decision === 'APPROVE') &&
      trail.some(e => e.decision === 'REJECT'),
    trail,
  );

  // ── 9. Never a hold without a release ────────────────────────────────────
  heading('9. leaving the gated profession lets the listing out');

  const moved = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    categoryCodes: [OPEN],
    professionTitle: 'Backend engineer',
    about: 'I build APIs. Ten years of Node and Postgres, Manchester based.',
  });

  check('the category change is accepted', moved.status === 200, moved.status || moved.body);
  check(
    'and there is nothing left to review',
    moved.body?.data?.review === null,
    moved.body?.data?.review,
  );

  const released = await prisma.professionalListing.findUnique({
    where: { id: listingId },
    select: { reviewState: true, visibilityState: true },
  });

  check(
    'the row says NOT_REQUIRED',
    released?.reviewState === 'NOT_REQUIRED',
    released?.reviewState,
  );
  check(
    'and it is visible again',
    released?.visibilityState === 'VISIBLE',
    released?.visibilityState,
  );

  const closed = await prisma.moderationQueueItem.findFirst({
    where: { type: 'PROFESSIONAL_REVIEW', targetId: listingId },
    select: { state: true },
  });

  check(
    'and its queue item is closed, not left open for ever',
    closed?.state === 'RESOLVED',
    closed?.state,
  );

  const releasedSafety = await prisma.contentSafety.findUnique({
    where: { targetType_targetId: { targetType: 'PROFESSIONAL_LISTING', targetId: listingId } },
    select: { reviewedById: true, heldReason: true },
  });

  // If the decline's reviewer were left behind, the next scan of this listing would read it as
  // "held by a human" and quietly pull it back to LIMITED (§6.6's `heldByHuman`).
  check(
    'and no stale reviewer is left to make the next scan re-hide it',
    releasedSafety?.reviewedById === null && releasedSafety?.heldReason === null,
    releasedSafety,
  );

  // ── 10. An ungated listing is untouched ──────────────────────────────────
  heading('10. an ungated profession is not slowed down by any of this');

  const open = await api(
    coder.token,
    'POST',
    '/professionals/listings',
    listingBody({
      categoryCodes: [OPEN],
      professionTitle: 'React developer',
      about: 'I build web apps for small businesses in Manchester.',
    }),
  );

  check('it is created', open.status === 201, open.status || open.body);
  check(
    'with no review block at all',
    open.body?.data?.listing?.review === null,
    open.body?.data?.listing?.review,
  );

  const openId = open.body?.data?.listing?.id;
  const openDirect = await api(browser.token, 'GET', `/professionals/${openId}`);

  check('and it is live immediately', openDirect.status === 200, openDirect.status);

  // ── 11. A suspended member is told they are suspended (§13.2) ────────────
  heading('11. a suspended member learns they are suspended');

  const suspendMe = await makeUser('suspension-subject');

  // A verified address, so sign-in gets as far as the account checks rather than stopping at the
  // verification nudge. `makeUser` mints a token directly and never goes through sign-in.
  await prisma.userAuth.create({
    data: { userId: suspendMe.id, emailVerifiedAt: new Date() },
  });

  const before = await api(suspendMe.token, 'GET', '/users/profile');

  check('they can use the app first', before.status === 200, before.status);

  const until = new Date(Date.now() + 7 * 86400000).toISOString();

  const suspended = await api(
    null,
    'POST',
    `/admin/members/${suspendMe.id}/suspend`,
    {
      duration: 'custom',
      until,
      reasonCode: 'SAFETY_CONCERN',
      note: 'Repeatedly messaging people who asked them to stop.',
    },
    { ...headers, 'Idempotency-Key': `e2e-suspend-${Date.now()}` },
  );

  check('the suspension lands', suspended.status === 200, suspended.status || suspended.body);

  // Their sessions were revoked, so their old token is a 401 rather than a 403 — which is exactly
  // why the refusal has to also live on the paths they reach *after* that.
  const refreshed = await api(null, 'GET', '/auth/refresh', undefined, {
    'x-refresh-token': 'not-a-real-token',
  });

  check('a junk refresh token is still a 401', refreshed.status === 401, refreshed.status);

  // The code has to be sent before it can be verified: there is no bypass any more, so the suite
  // drives the flow a member does. The suspension refusal happens after the code checks out,
  // which is the point — it is the account that is refused, not the credential.
  await api(null, 'POST', '/auth/verify/send', { email: suspendMe.email });

  const signIn = await api(null, 'POST', '/auth/verify/email', {
    email: suspendMe.email,
    code: '1234',
  });

  check('sign-in is refused with 403', signIn.status === 403, signIn.status);
  check(
    'and the code says ACCOUNT_SUSPENDED rather than a generic refusal',
    signIn.body?.error?.code === 'ACCOUNT_SUSPENDED',
    signIn.body?.error,
  );

  const notice = signIn.body?.data;

  check(
    'the payload says what state the account is in',
    notice?.state === 'SUSPENDED',
    notice?.state,
  );
  check('and that the app may not be used', notice?.canUseApp === false, notice?.canUseApp);
  check(
    'it carries the end date',
    notice?.suspension?.endsAt?.slice(0, 10) === until.slice(0, 10),
    notice?.suspension,
  );
  check(
    'and says it is not permanent',
    notice?.suspension?.isPermanent === false,
    notice?.suspension,
  );
  check(
    'it carries the reason the member was given',
    !!notice?.suspension?.reason,
    notice?.suspension,
  );
  check('a headline to show', typeof notice?.headline === 'string', notice?.headline);
  check('a sentence to show', typeof notice?.message === 'string', notice?.message);
  check(
    'and where to appeal',
    notice?.suspension?.appeal?.via === 'SUPPORT',
    notice?.suspension?.appeal,
  );
  check(
    'with an address that is not blank',
    !!notice?.suspension?.appeal?.supportEmail,
    notice?.suspension?.appeal,
  );

  // ── 12. Social sign-in is not a way round it ─────────────────────────────
  heading('12. the other front door is shut too');

  // Only half-testable from out here, and saying so rather than pretending otherwise. An invalid
  // Google token is rejected before the account is looked up, so an assertion that social sign-in
  // refuses a suspended member passes whether the check exists or not — which it did when this
  // script was written, and the fault injection proved it. The check itself is covered by
  // `src/modules/core/auth/services/__tests__/social-suspension.spec.ts`, which stubs the provider
  // verification and asserts no session is minted. What is worth asserting here is the one thing
  // that is real either way: no session appeared.
  const socialAttempt = await api(null, 'POST', '/auth/verify/social', {
    provider: 'GOOGLE',
    idToken: 'not-a-real-google-token',
    email: suspendMe.email,
  });

  check(
    'a social sign-in attempt issues no session',
    socialAttempt.status !== 200 && socialAttempt.status !== 201,
    socialAttempt.status,
  );
  check(
    'and they still have no active session',
    (await prisma.userSession.count({ where: { userId: suspendMe.id, isActive: true } })) === 0,
  );

  // ── 13. Reactivation puts it all back ────────────────────────────────────
  heading('13. reactivation puts it back');

  const reactivated = await api(
    null,
    'POST',
    `/admin/members/${suspendMe.id}/reactivate`,
    { reasonCode: 'OTHER', note: 'Appeal upheld.' },
    { ...headers, 'Idempotency-Key': `e2e-react-${Date.now()}` },
  );

  check('reactivation lands', reactivated.status === 200, reactivated.status || reactivated.body);

  await api(null, 'POST', '/auth/verify/send', { email: suspendMe.email });

  const backIn = await api(null, 'POST', '/auth/verify/email', {
    email: suspendMe.email,
    code: '1234',
  });

  check(
    'and they can sign in again',
    backIn.status === 200 || backIn.status === 201,
    backIn.status,
  );

  // ── 14. The gated set is configuration, not code ─────────────────────────
  heading('14. staff can change which professions are gated');

  const tsStaff = await makeAdmin('gate-ts', 'trust_safety');
  const supportStaff = await makeAdmin('gate-support', 'support');

  const cats = await api(null, 'GET', '/admin/professional-reviews/categories', undefined, headers);

  // Pins the route order. `categories` is declared above `@Get(':id')`, which carries a
  // ParseUUIDPipe — below it this is a 400 complaining that "categories" is not a uuid, on a URL
  // that looks perfectly correct.
  check('GET categories is not parsed as a listing id', cats.status === 200, cats.status);

  const byCode = Object.fromEntries((cats.body?.data ?? []).map(row => [row.code, row]));
  const gatedNow = (cats.body?.data ?? []).filter(row => row.requiresReview).map(row => row.code);

  check(
    'the seven defaults are gated and nothing else is',
    gatedNow.slice().sort().join(',') ===
      [
        'CHILDCARE_SERVICES',
        'FINANCE_ACCOUNTING',
        'HEALTHCARE',
        'IMMIGRATION',
        'LEGAL',
        'PROPERTY_LETTINGS',
        'THERAPY_COACHING',
      ].join(','),
    gatedNow,
  );
  check(
    'each row carries the counts that make the consequence visible',
    typeof byCode[GATED]?.listings === 'number' &&
      typeof byCode[GATED]?.pendingReviews === 'number',
    byCode[GATED],
  );
  check(
    'and isRegulated is reported separately, read-only',
    byCode.TRANSLATION?.requiresReview === false && byCode.TRANSLATION?.isRegulated === false,
    byCode.TRANSLATION,
  );
  // Dropped from the admin responses at the portal's request (§2.9): a reviewer no longer checks a
  // registration number against a register by hand — the documents are the evidence. It stays on
  // the taxonomy, which is where the app reads it.
  check(
    'credentialBodies is no longer in the admin response',
    (cats.body?.data ?? []).every(row => !('credentialBodies' in row)),
    byCode[GATED],
  );

  // Trust & Safety, managers and super admins may change it. Support may not.
  const refused = await api(
    null,
    'PUT',
    '/admin/professional-reviews/categories',
    { codes: gatedNow, reasonCode: 'CORRECTION', note: 'Support should not be able to do this.' },
    { ...adminHeaders(supportStaff), 'Idempotency-Key': `e2e-gate-support-${Date.now()}` },
  );

  check('support cannot change the gated set', refused.status === 403, refused.status);

  // A listing in an ungated profession, live, which is about to be gated under it.
  const fitter = await makeUser('gate-fitter');
  const fitted = await api(
    fitter.token,
    'POST',
    '/professionals/listings',
    listingBody({
      categoryCodes: ['TRADES_REPAIRS'],
      professionTitle: 'Kitchen fitter',
      about: 'I fit kitchens and have done for eleven years, mostly around south Manchester.',
    }),
  );

  check('it is created live', fitted.status === 201, fitted.status || fitted.body);
  check(
    'with nothing to review',
    fitted.body?.data?.listing?.review === null,
    fitted.body?.data?.listing?.review,
  );

  const fittedId = fitted.body?.data?.listing?.id;
  const fittedVisible = await api(browser.token, 'GET', `/professionals/${fittedId}`);

  check('and reachable', fittedVisible.status === 200, fittedVisible.status);

  const gatedOn = await api(
    null,
    'PUT',
    '/admin/professional-reviews/categories',
    {
      codes: [...gatedNow, 'TRADES_REPAIRS'],
      reasonCode: 'SAFETY_CONCERN',
      note: 'Gas work without Gas Safe registration.',
    },
    { ...adminHeaders(tsStaff), 'Idempotency-Key': `e2e-gate-on-${Date.now()}` },
  );

  check(
    'trust & safety can gate a profession',
    gatedOn.status === 200,
    gatedOn.status || gatedOn.body,
  );

  // The proof that the two flags are independent: `TRADES_REPAIRS` has no regulator — there is no
  // register for "trades" as a category — and it is gated anyway. If `requiresReview` were a view
  // over `isRegulated`, this would be impossible.
  const diverged = (gatedOn.body?.data?.categories ?? []).find(
    row => row.code === 'TRADES_REPAIRS',
  );

  check(
    'a profession with no regulator can still be gated',
    diverged?.requiresReview === true && diverged?.isRegulated === false,
    diverged,
  );
  check(
    'the response reports the gating and no longer claims to have queued anything',
    gatedOn.body?.data?.applied?.gated?.includes('TRADES_REPAIRS') &&
      !('listingsQueued' in (gatedOn.body?.data?.applied ?? {})),
    gatedOn.body?.data?.applied,
  );

  const afterGating = await api(fitter.token, 'GET', '/professionals/me');
  const fittedReview = (afterGating.body?.data?.listing ?? afterGating.body?.data)?.review;
  const stillThere = await api(browser.token, 'GET', `/professionals/${fittedId}`);

  // Approval applies to accounts created afterwards only. This listing already existed, so the
  // settings change leaves it exactly where it was: no review, no documents, still trading.
  //
  // `review` is **null**, not `NOT_REQUIRED`: `ownerView` returns nothing for a listing with
  // nothing to wait for, which is what makes the app render no banner at all.
  check('an existing listing is NOT pulled into review', fittedReview === null, fittedReview);
  check('so people can still reach it', stillThere.status === 200, stillThere.status);

  const queueAfterGating = await api(
    null,
    'GET',
    '/admin/professional-reviews?perPage=100',
    undefined,
    headers,
  );

  check(
    'and it is not in the review queue at all',
    !(queueAfterGating.body?.data ?? []).some(row => row.id === fittedId),
    (queueAfterGating.body?.data ?? []).map(row => row.id).slice(0, 5),
  );

  // An ordinary edit must not drag it in either — the settings change was careful not to, and the
  // next edit used to do it anyway.
  const priceEdit = await api(fitter.token, 'PATCH', `/professionals/listings/${fittedId}`, {
    priceFrom: 4200,
  });

  // `NOT_REQUIRED` is as live as `APPROVED` — publicly visible, nothing to wait for — so the lock
  // applies to it too. This is the half that actually closes the bypass: register in an
  // unrestricted profession, go live, then add a restricted one.
  const fitterSwitch = await api(fitter.token, 'PATCH', `/professionals/listings/${fittedId}`, {
    categoryCodes: [GATED],
  });

  check(
    'a live NOT_REQUIRED listing cannot add a gated profession either',
    fitterSwitch.status === 409 && fitterSwitch.body?.error?.code === 'PROFESSION_LOCKED',
    { status: fitterSwitch.status, error: fitterSwitch.body?.error?.code },
  );

  check(
    'nor does editing it afterwards',
    priceEdit.status === 200 && (priceEdit.body?.data?.review ?? null) === null,
    {
      status: priceEdit.status,
      error: priceEdit.body?.error,
      review: priceEdit.body?.data?.review,
    },
  );

  // A NEW account in the newly gated profession IS held — that is who approval is for. This is
  // also what gives the release below something to release: the existing listing above was never
  // queued, so ungating would otherwise have nothing to do and the check would pass on a no-op.
  const newFitter = await makeUser('gate-new-fitter');
  const newFitted = await api(
    newFitter.token,
    'POST',
    '/professionals/listings',
    await withDocument(newFitter.token, { categoryCodes: ['TRADES_REPAIRS'] }),
  );
  const newFittedId = newFitted.body?.data?.listing?.id;

  check(
    'a new account in a gated profession is held',
    newFitted.status === 201 &&
      newFitted.body?.data?.listing?.review?.state === 'PENDING' &&
      newFitted.body?.data?.listing?.review?.isPublic === false,
    newFitted.body?.data?.listing?.review ?? newFitted.body?.error,
  );

  // Ungating it again must release it — a hold with no release is the bug this pair exists to stop.
  const gatedOff = await api(
    null,
    'PUT',
    '/admin/professional-reviews/categories',
    { codes: gatedNow, reasonCode: 'CORRECTION', note: 'Reverting: too wide a net.' },
    { ...adminHeaders(tsStaff), 'Idempotency-Key': `e2e-gate-off-${Date.now()}` },
  );

  check('ungating works', gatedOff.status === 200, gatedOff.status || gatedOff.body);
  check(
    'and counts only the listings that actually became public',
    gatedOff.body?.data?.applied?.ungated?.includes('TRADES_REPAIRS') &&
      gatedOff.body?.data?.applied?.listingsReleased >= 1,
    gatedOff.body?.data?.applied,
  );

  const releasedRow = await prisma.professionalListing.findUnique({
    where: { id: newFittedId },
    select: { reviewState: true, visibilityState: true },
  });
  const releasedItem = await prisma.moderationQueueItem.findFirst({
    where: { type: 'PROFESSIONAL_REVIEW', targetId: newFittedId },
    select: { state: true },
  });

  check(
    'the held listing has nothing left to wait for',
    releasedRow?.reviewState === 'NOT_REQUIRED',
    releasedRow,
  );
  // Our hold is lifted — not "nothing holds it". A scanner or a staff member may be holding the
  // same listing for their own reasons, and ungating a profession must not launder that.
  check(
    'and our hold on it is lifted',
    releasedRow?.visibilityState !== 'PENDING_APPROVAL',
    releasedRow,
  );
  check('and its queue item is closed', releasedItem?.state === 'RESOLVED', releasedItem?.state);

  // The condition that is easy to get wrong: a listing under two gated professions that loses one.
  const both = await makeUser('gate-both');
  const bothListing = await api(
    both.token,
    'POST',
    '/professionals/listings',
    await withDocument(both.token, { categoryCodes: [GATED, 'TRADES_REPAIRS'] }),
  );
  const bothId = bothListing.body?.data?.listing?.id;

  check(
    'a listing under two gated professions is held',
    bothListing.status === 201,
    bothListing.status,
  );

  await api(
    null,
    'PUT',
    '/admin/professional-reviews/categories',
    {
      codes: [...gatedNow, 'TRADES_REPAIRS'],
      reasonCode: 'SAFETY_CONCERN',
      note: 'Gating trades again for this check.',
    },
    { ...adminHeaders(tsStaff), 'Idempotency-Key': `e2e-gate-on2-${Date.now()}` },
  );
  await api(
    null,
    'PUT',
    '/admin/professional-reviews/categories',
    { codes: gatedNow, reasonCode: 'CORRECTION', note: 'And off again.' },
    { ...adminHeaders(tsStaff), 'Idempotency-Key': `e2e-gate-off2-${Date.now()}` },
  );

  const stillHeldRow = await prisma.professionalListing.findUnique({
    where: { id: bothId },
    select: { reviewState: true, visibilityState: true },
  });

  // Releasing this one would have published an unapproved immigration adviser.
  check(
    'ungating one of its professions does not release a listing still gated under the other',
    stillHeldRow?.reviewState === 'PENDING' && stillHeldRow?.visibilityState === 'PENDING_APPROVAL',
    stillHeldRow,
  );

  const noop = await api(
    null,
    'PUT',
    '/admin/professional-reviews/categories',
    { codes: gatedNow, reasonCode: 'CORRECTION', note: 'Exactly what it already is.' },
    { ...adminHeaders(tsStaff), 'Idempotency-Key': `e2e-gate-noop-${Date.now()}` },
  );

  check('a change that changes nothing is accepted', noop.status === 200, noop.status);
  check(
    'and reports no listings touched',
    noop.body?.data?.applied?.gated?.length === 0 &&
      noop.body?.data?.applied?.ungated?.length === 0 &&
      noop.body?.data?.applied?.listingsReleased === 0,
    noop.body?.data?.applied,
  );

  const unknownCode = await api(
    null,
    'PUT',
    '/admin/professional-reviews/categories',
    { codes: ['NOT_A_PROFESSION'], reasonCode: 'CORRECTION', note: 'A code that does not exist.' },
    { ...adminHeaders(tsStaff), 'Idempotency-Key': `e2e-gate-bad-${Date.now()}` },
  );

  check('an unknown code is refused', unknownCode.status === 422, unknownCode.status);
  check(
    'and the gated set is unchanged by the refusal',
    (
      await api(null, 'GET', '/admin/professional-reviews/categories', undefined, headers)
    ).body?.data?.filter(row => row.requiresReview).length === gatedNow.length,
  );

  await sweep('listing-review');
  await finish();
}

main().catch(fail);
