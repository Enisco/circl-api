/* Circl Guard and the admin endpoints. */
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
const jwt = require('jsonwebtoken');

/** Creates a staff account holding exactly one role's permissions. */

(async () => {
  await sweep('pre-run');

  const member = await makeUser('member');
  const moderator = await makeAdmin('mod', 'trust_safety');
  const safeguarding = await makeAdmin('safe', 'trust_safety');

  console.log('\n── 1.9 Private to Circl ─────────────────────────────────────');

  let r = await api(member.token, 'POST', '/community/requests', {
    categoryCode: 'ACCOMMODATION', title: 'Something I do not want to post publicly',
    cityId: 'MANCHESTER', visibility: 'PRIVATE_TO_CIRCL',
  });
  check('the composer is routed away from the feed → USE_PRIVATE_ENDPOINT', r.status === 422 && r.body?.error?.code === 'USE_PRIVATE_ENDPOINT', r.body?.error);

  r = await api(member.token, 'POST', '/guard/threads', {
    subject: 'I need help and I do not want to post it',
    message: 'My partner beats me and he took my passport last week. I have nowhere to go.',
    categoryCode: 'ACCOMMODATION',
  });
  check('private thread → 201 with a conversationId', r.status === 201 && !!r.body?.data?.conversationId, r.body?.error);
  const guardThreadId = r.body?.data?.id;
  const guardConversationId = r.body?.data?.conversationId;

  const publicRequests = await prisma.communityRequest.count({ where: { authorId: member.id } });
  check('no public post of any kind was created', publicRequests === 0, publicRequests);

  const opening = await prisma.message.findFirst({
    where: { conversationId: guardConversationId, kind: 'SYSTEM' },
  });
  check('the opening message says who can see it', /Nobody in the community can see it/.test(opening?.body ?? ''), opening?.body);
  check('and promises NO timeframe', !/(within|hours|days|business)/i.test(opening?.body ?? ''), opening?.body);

  const threadRow = await prisma.guardThread.findUnique({ where: { id: guardThreadId } });
  check('no expectedByAt field exists on the record', !('expectedByAt' in threadRow), Object.keys(threadRow).filter(k => /expect/i.test(k)));

  r = await api(member.token, 'GET', `/messages/${guardConversationId}/messages`);
  check("the member's own words are in the thread", r.body?.data?.some(m => /beats me/.test(m.body ?? '')), r.body?.data?.length);

  r = await api(member.token, 'GET', '/guard/threads');
  check('the member can list their own threads', r.body?.data?.length === 1, r.body?.data?.length);
  check('but is never shown the risk score', r.body?.data?.[0]?.risk === undefined && r.body?.data?.[0]?.riskLevel === undefined, Object.keys(r.body?.data?.[0] ?? {}));

  console.log('\n── Guard: risk-aware ranking ────────────────────────────────');

  check('the thread was scored', threadRow?.riskScore > 0, threadRow?.riskScore);
  check('CRITICAL or HIGH from an unambiguous disclosure', ['HIGH', 'CRITICAL'].includes(threadRow?.riskLevel), threadRow?.riskLevel);
  check('categorised DOMESTIC_ABUSE', threadRow?.riskCategory === 'DOMESTIC_ABUSE', threadRow?.riskCategory);
  check('the matched phrases are recorded, so the escalation is explainable',
    Array.isArray(threadRow?.riskSignals) && threadRow.riskSignals.length >= 2, threadRow?.riskSignals);
  console.log(`    (score ${threadRow?.riskScore}: ${(threadRow?.riskSignals ?? []).map(s => s.pattern).join(' | ')})`);

  // A low-risk private thread should exist too, so ordering can be checked.
  const quiet = await makeUser('quiet');
  r = await api(quiet.token, 'POST', '/guard/threads', {
    subject: 'A question about my council tax',
    message: 'I am not sure which band my flat is in and I did not want to ask publicly.',
  });
  const quietThreadId = r.body?.data?.id;
  check('a low-risk private thread is accepted too', r.status === 201, r.body?.error);

  console.log('\n── Admin: the Guard queue ───────────────────────────────────');

  r = await api(member.token, 'GET', '/admin/guard/cases');
  // 401, not 403: a member token is not an admin token at all, so it never reaches authorisation.
  check('a member cannot read the Guard queue', r.status === 401, r.status);

  // The separation moved rather than disappeared. `moderator` and `safeguarding` are now one role
  // — trust & safety, who do both jobs — so the line that matters is the one between them and
  // everybody else with admin access: support holds no `guard:read` and never sees a disclosure.
  const supportStaff = await makeAdmin('guardsupport', 'support');

  r = await api(null, 'GET', '/admin/guard/cases', null, adminHeaders(supportStaff));
  check('support staff cannot read the Guard queue — a disclosure is not their job',
    r.status === 403 && r.body?.data?.requires?.includes('guard:read'), r.body);

  r = await api(null, 'GET', '/admin/guard/cases', null, adminHeaders(safeguarding));
  check('trust & safety can → 200', r.status === 200, r.body?.error);
  check('both of this run\'s cases are listed',
    [guardThreadId, quietThreadId].every(id => r.body?.data?.some(c => c.id === id)),
    r.body?.data?.length);
  check('the urgent one is FIRST, ahead of the older quiet one',
    r.body?.data?.[0]?.id === guardThreadId, r.body?.data?.map(c => `${c.risk?.level}:${c.subject}`));
  check('meta.urgentCount surfaces the number that should never sit', r.body?.meta?.urgentCount >= 1, r.body?.meta);
  check('the reviewer sees the matched phrases', r.body?.data?.[0]?.risk?.signals?.length >= 2, r.body?.data?.[0]?.risk);

  r = await api(null, 'PATCH', `/admin/guard/cases/${guardThreadId}`, {
    state: 'IN_PROGRESS', assignedToId: safeguarding.id,
  }, adminHeaders(safeguarding));
  check('assign → 200', r.status === 200 && r.body?.data?.state === 'IN_PROGRESS', r.body?.error);

  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId: guardConversationId },
  });
  check('assigning joins the staff member to the thread', participants.some(p => p.userId === safeguarding.id), participants.map(p => p.userId));

  // Through the admin endpoint, not the member one. Staff cannot sign in to the app any more —
  // that was the hole — so the reply has its own route, which records who read and who answered.
  r = await api(safeguarding.token, 'POST', `/messages/${guardConversationId}/messages`, {
    clientId: 'staff-1', body: 'Replying with a member token should not work.',
  });
  check('staff cannot reply through the member app', r.status === 401, r.status);

  r = await api(null, 'POST', `/admin/guard/cases/${guardThreadId}/messages`, {
    clientId: 'staff-1', body: 'I have read this. Let me find you somewhere safe to stay tonight.',
  }, adminHeaders(safeguarding));
  check('assigned staff can reply through the admin endpoint', r.status === 201, r.body?.error);

  r = await api(member.token, 'GET', `/messages/${guardConversationId}/messages`);
  check('and the member sees it in the thread they already had open',
    (r.body?.data ?? []).some(m => /somewhere safe/.test(m.body ?? '')), r.body?.data?.length);

  r = await api(null, 'GET', `/admin/guard/cases/${guardThreadId}/messages`, null, adminHeaders(supportStaff));
  check('support cannot read the case thread either', r.status === 403, r.status);

  r = await api(null, 'GET', `/admin/guard/cases/${guardThreadId}/messages`, null, adminHeaders(safeguarding));
  check('trust & safety can read it', r.status === 200, r.body?.error);

  // The colleague who is NOT the assignee. Reading has to work for them: a case whose assignee is
  // away would otherwise be unreadable by the people whose job it is, and R7 grants reading to
  // anybody holding guard:read rather than to whoever happens to be on the thread.
  const colleague = await makeAdmin('guardcolleague', 'trust_safety');

  r = await api(null, 'GET', `/admin/guard/cases/${guardThreadId}/messages`, null, adminHeaders(colleague));
  check('and so can a colleague who was never assigned to it', r.status === 200, r.body?.error);

  const beforeRead = await prisma.conversationParticipant.count({
    where: { conversationId: guardConversationId },
  });

  await api(null, 'GET', `/admin/guard/cases/${guardThreadId}/messages`, null, adminHeaders(colleague));
  const afterRead = await prisma.conversationParticipant.count({
    where: { conversationId: guardConversationId },
  });
  check('reading leaves nothing behind in the member\'s thread', beforeRead === afterRead,
    { beforeRead, afterRead });

  r = await api(null, 'POST', `/admin/guard/cases/${guardThreadId}/messages`, {
    clientId: 'staff-colleague-1', body: 'Covering while my colleague is away.',
  }, adminHeaders(colleague));
  check('and replying works, because answering a case is taking it', r.status === 201, r.body?.error);

  const joined = await prisma.conversationParticipant.findFirst({
    where: { conversationId: guardConversationId, userId: colleague.id },
  });
  check('which is what the participant row says', joined?.role === 'STAFF', joined?.role);

  console.log('\n── Admin: anonymous posts are still moderated ───────────────');

  r = await api(member.token, 'POST', '/community/updates', {
    content: 'Posting this anonymously because I do not want my employer to see it.',
    visibility: 'ANONYMOUS',
  });
  const anonUpdateId = r.body?.data?.id;
  check('anonymous post created', r.status === 201, r.body?.error);

  await new Promise(res => setTimeout(res, 600));
  r = await api(null, 'GET', '/admin/moderation/queue?type=ANONYMOUS_POST', null, adminHeaders(moderator));
  check('it lands in the approval queue even though nobody reported it', r.body?.data?.some(i => i.targetId === anonUpdateId), r.body?.data?.length);
  const anonQueueId = r.body?.data?.find(i => i.targetId === anonUpdateId)?.id;
  check('the row carries the content, so no second screen is needed', !!r.body?.data?.find(i => i.id === anonQueueId)?.content?.content, r.body?.data?.[0]?.content);

  r = await api(null, 'POST', `/admin/moderation/queue/${anonQueueId}/claim`, null, adminHeaders(moderator));
  check('claim → 200', r.status === 200, r.body?.error);
  r = await api(null, 'POST', `/admin/moderation/queue/${anonQueueId}/claim`, null, adminHeaders(safeguarding));
  check('a second claimer → 409, so two people do not work one item', r.status === 409, r.body?.error);

  r = await api(null, 'POST', `/admin/moderation/queue/${anonQueueId}/decide`, {
    decision: 'APPROVE', reason: 'Nothing wrong with it.',
  }, adminHeaders(moderator));
  check('approve → 200 RESOLVED', r.status === 200 && r.body?.data?.state === 'RESOLVED', r.body?.error);

  r = await api(null, 'POST', `/admin/moderation/queue/${anonQueueId}/decide`, { decision: 'APPROVE' }, adminHeaders(moderator));
  check('deciding twice → 409', r.status === 409, r.body?.error);

  r = await api(null, 'GET', `/admin/moderation/actions/UPDATE/${anonUpdateId}`, null, adminHeaders(moderator));
  check('the decision is on an append-only audit trail', r.body?.data?.length === 1 && r.body.data[0].decision === 'APPROVE', r.body?.data);
  check('and names who made it', r.body?.data?.[0]?.actor?.id === moderator.id, r.body?.data?.[0]?.actor);

  console.log('\n── Admin: removing content ──────────────────────────────────');

  r = await api(member.token, 'POST', '/community/updates', { content: 'Buy cheap watches at my website, guaranteed.' });
  const spamId = r.body?.data?.id;
  await api(quiet.token, 'POST', '/moderation/reports', {
    targetType: 'UPDATE', targetId: spamId, reasonCode: 'SPAM',
  });
  await new Promise(res => setTimeout(res, 400));

  // Past the default page of 20, because the queue is ordered oldest-first and a long-lived
  // database accumulates: on a developer machine this suite was failing not because the report
  // never landed but because it landed on page three.
  r = await api(null, 'GET', '/admin/moderation/queue?type=REPORTED_CONTENT&limit=50', null, adminHeaders(moderator));
  const spamQueueId = r.body?.data?.find(i => i.targetId === spamId)?.id;
  check('a report lands in the queue', !!spamQueueId,
    { returned: r.body?.data?.length, total: r.body?.meta?.totalCount });

  r = await api(null, 'POST', `/admin/moderation/queue/${spamQueueId}/decide`, {
    decision: 'REMOVE_CONTENT', reason: 'Advertising.',
  }, adminHeaders(moderator));
  check('remove → 200', r.status === 200, r.body?.error);
  r = await api(quiet.token, 'GET', `/community/updates/${spamId}`);
  check('the post now tombstones for readers', r.status === 404 && r.body?.error?.code === 'RESOURCE_DELETED', r.body?.error);

  const reportRow = await prisma.report.findFirst({ where: { targetId: spamId } });
  check('the report is marked actioned', reportRow?.state === 'ACTIONED', reportRow?.state);

  console.log('\n── Admin: a report has to name a member, not an owning row ──');

  // The queue resolves who to act against from one column on the reported row. An item belongs to
  // a shop and a shop belongs to a member, so without reading through, a reported item named a
  // shop id: nobody to show, and nothing for a suspend to act on.
  const seller = await makeUser('gaseller');
  const dob = new Date();

  dob.setUTCFullYear(dob.getUTCFullYear() - 33);

  r = await api(seller.token, 'POST', '/commerce/stores', {
    name: `Guard Admin Shop ${Date.now()}`,
    description: 'A shop that exists so one of its items can be reported.',
    area: 'Moss Side', cityId: 'MANCHESTER',
  });
  const guardStore = r.body?.data?.id;

  r = await api(seller.token, 'POST', `/commerce/stores/${guardStore}/items`, {
    name: 'Something reportable', price: 500, categoryCode: 'FOOD_GROCERIES',
  });
  const guardItem = r.body?.data?.id;

  await api(quiet.token, 'POST', '/moderation/reports', {
    targetType: 'STORE_ITEM', targetId: guardItem, reasonCode: 'SPAM',
  });
  await new Promise(res => setTimeout(res, 400));

  const itemReport = await prisma.report.findFirst({
    where: { targetType: 'STORE_ITEM', targetId: guardItem },
    select: { targetUserId: true },
  });
  check('a reported item names the member who sells it, read through the shop', itemReport?.targetUserId === seller.id, itemReport);

  r = await api(null, 'GET', '/admin/moderation/queue?type=REPORTED_CONTENT&limit=50', null, adminHeaders(moderator));
  const itemQueue = r.body?.data?.find(i => i.targetId === guardItem);
  // Which is what SUSPEND_AUTHOR acts on: a shop id here would have been nobody to suspend.
  check('and the queue row carries the same member, so there is somebody to act against', itemQueue?.subject?.id === seller.id, { subject: itemQueue?.subject });

  r = await api(null, 'POST', `/admin/moderation/queue/${itemQueue?.id}/decide`, {
    decision: 'REMOVE_CONTENT', reason: 'Advertising.',
  }, adminHeaders(moderator));
  check('removing it → 200', r.status === 200, r.body?.error);

  r = await api(quiet.token, 'GET', `/commerce/stores/${guardStore}/items`);
  check('and the item leaves the catalogue', !(r.body?.data ?? []).some(i => i.id === guardItem), (r.body?.data ?? []).map(i => i.id));

  console.log('\n── Admin: taking down one Connect photo ─────────────────────');

  // A report names one item, because a photo is what somebody objects to. Accepting the subject
  // and then doing nothing on a takedown is worse than refusing the report.
  await api(seller.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP', lookingFor: 'Here so that one of my photos can be taken down.',
    dateOfBirth: dob.toISOString().slice(0, 10), isVisible: true,
  });

  const shot1 = await uploadPng(seller.token, 'CONNECT', 900, 1200);
  const shot2 = await uploadPng(seller.token, 'CONNECT', 900, 1200);

  r = await api(seller.token, 'POST', '/connect/me/posts', { keys: [shot1, shot2], kind: 'PHOTO' });
  const guardPost = r.body?.data?.id;
  const guardPhotos = (r.body?.data?.items ?? []).map(i => i.id);

  await api(quiet.token, 'POST', '/moderation/reports', {
    targetType: 'CONNECT_MEDIA', targetId: guardPhotos[0], reasonCode: 'INAPPROPRIATE',
  });
  await new Promise(res => setTimeout(res, 400));

  r = await api(null, 'GET', '/admin/moderation/queue?type=REPORTED_CONTENT&limit=50', null, adminHeaders(moderator));
  const photoQueue = r.body?.data?.find(i => i.targetId === guardPhotos[0]);
  check('a reported photo reaches the queue against its uploader', !!photoQueue, { found: !!photoQueue });

  r = await api(null, 'POST', `/admin/moderation/queue/${photoQueue?.id}/decide`, {
    decision: 'REMOVE_CONTENT', reason: 'Not appropriate here.',
  }, adminHeaders(moderator));
  check('taking it down → 200', r.status === 200, r.body?.error);

  r = await api(seller.token, 'GET', '/connect/me');
  const guardGallery = r.body?.data?.profile?.posts ?? [];
  const survivor = guardGallery.find(post => post.id === guardPost);
  check('the photo is gone from the gallery', !!survivor && !survivor.items.some(i => i.id === guardPhotos[0]), survivor?.items?.map(i => i.id));
  check('and the rest of its post is still standing', survivor?.items?.length === 1, survivor?.items?.length);

  await api(quiet.token, 'POST', '/moderation/reports', {
    targetType: 'CONNECT_MEDIA', targetId: guardPhotos[1], reasonCode: 'INAPPROPRIATE',
  });
  await new Promise(res => setTimeout(res, 400));

  r = await api(null, 'GET', '/admin/moderation/queue?type=REPORTED_CONTENT&limit=50', null, adminHeaders(moderator));
  const lastQueue = r.body?.data?.find(i => i.targetId === guardPhotos[1]);

  await api(null, 'POST', `/admin/moderation/queue/${lastQueue?.id}/decide`, {
    decision: 'REMOVE_CONTENT', reason: 'Not appropriate here.',
  }, adminHeaders(moderator));

  r = await api(seller.token, 'GET', '/connect/me');
  check('taking the last one takes the post, because an empty post is not a post', !(r.body?.data?.profile?.posts ?? []).some(post => post.id === guardPost), (r.body?.data?.profile?.posts ?? []).map(p => p.id));

  console.log('\n── Admin: suspending a member ───────────────────────────────');

  r = await api(null, 'PATCH', `/admin/users/${member.id}/status`, { status: 'SUSPENDED' }, adminHeaders(supportStaff));
  check('support cannot suspend — they escalate instead, which leaves a different trail',
    r.status === 403 && r.body?.data?.requires?.includes('members:suspend'), r.body);

  const superAdmin = await makeAdmin('root', 'super_admin');
  r = await api(null, 'PATCH', `/admin/users/${member.id}/status`, {
    status: 'SUSPENDED', reason: 'Repeated advertising.',
  }, adminHeaders(superAdmin));
  // Granted explicitly rather than by a wildcard: `manage:all` used to short-circuit every check
  // and has been deleted, so a super admin holds each permission by name.
  check('a super admin holds members:suspend by name → 200', r.status === 200, r.body?.error);

  const sessions = await prisma.userSession.findMany({ where: { userId: member.id } });
  check('every session revoked immediately', sessions.every(s => !s.isActive && s.revokedAt !== null), sessions.map(s => s.isActive));

  r = await api(member.token, 'GET', '/community/feed');
  check('a suspended member cannot use the API', r.status === 403, r.status);

  await api(superAdmin.token, 'PATCH', `/admin/users/${member.id}/status`, { status: 'ACTIVE' });

  console.log('\n── Admin: taxonomy without an app release ───────────────────');

  r = await api(superAdmin.token, 'GET', '/admin/taxonomy/COMMUNITY_CATEGORY');
  check('admin sees deactivated terms too', r.body?.data?.some(t => t.isActive === false), r.body?.data?.length);

  let pub = await api(member.token, 'GET', '/taxonomy');
  const versionBefore = pub.body?.data?.version;
  check('SETTLING_IN ships seeded but inactive', pub.body?.data?.communityCategories?.find(c => c.code === 'SETTLING_IN')?.isActive === false);

  r = await api(superAdmin.token, 'POST', '/admin/taxonomy', {
    kind: 'COMMUNITY_CATEGORY', code: 'SETTLING_IN', label: 'Settling In', isActive: true,
  });
  check('activating a seeded term → 200', r.status === 200, r.body?.error);

  await new Promise(res => setTimeout(res, 200));
  pub = await api(member.token, 'GET', '/taxonomy');
  check('it is live for the client with no deploy', pub.body?.data?.communityCategories?.find(c => c.code === 'SETTLING_IN')?.isActive === true);
  check('the version stamp moved, invalidating caches and ETags', pub.body?.data?.version !== versionBefore, { before: versionBefore, after: pub.body?.data?.version });

  r = await api(member.token, 'POST', '/community/requests', {
    categoryCode: 'SETTLING_IN', title: 'Using a category that was activated a minute ago',
    cityId: 'MANCHESTER',
  });
  check('and writes against it are accepted immediately', r.status === 201, r.body?.error);

  r = await api(superAdmin.token, 'POST', '/admin/taxonomy', {
    kind: 'COMMUNITY_CATEGORY', code: 'lowercase_code', label: 'Bad',
  });
  check('a non-UPPER_SNAKE code is refused', r.status === 422, r.body?.error);

  r = await api(superAdmin.token, 'DELETE', '/admin/taxonomy/COMMUNITY_CATEGORY/SETTLING_IN');
  check('deactivate, never delete', r.status === 200 && r.body?.data?.isActive === false, r.body?.error);
  const stillThere = await prisma.taxonomyTerm.findFirst({ where: { code: 'SETTLING_IN' } });
  check('the row survives, so existing content keeps its label', stillThere !== null);

  console.log('\n── Admin: the Guard lexicon is editable ─────────────────────');

  r = await api(null, 'POST', '/admin/guard/risk-terms', {
    category: 'SCAM', pattern: 'e2e-brand-new-scam-phrase', weight: 70,
  }, adminHeaders(safeguarding));
  check('safeguarding staff can add a phrase → 200', r.status === 200, r.body?.error);
  const newTermId = r.body?.data?.id;

  // The scanner caches for two minutes, so this proves the row is right rather than waiting out the TTL in a test.
  const stored = await prisma.riskTerm.findUnique({ where: { id: newTermId } });
  check('stored lowercase and active', stored?.pattern === 'e2e-brand-new-scam-phrase' && stored?.isActive === true, stored);

  // Trust & safety own the lexicon now — tuning it is the same job as working the queue it feeds.
  // Support do not: a false positive is a safety decision, not a support one.
  r = await api(null, 'POST', '/admin/guard/risk-terms', { category: 'SCAM', pattern: 'e2e-nope' }, adminHeaders(supportStaff));
  check('support cannot edit the lexicon',
    r.status === 403 && r.body?.data?.requires?.includes('risk_terms:manage'), r.body);

  r = await api(null, 'POST', '/admin/guard/risk-terms', { category: 'NOT_A_CATEGORY', pattern: 'e2e-x' }, adminHeaders(safeguarding));
  check('an unknown risk category → 422', r.status === 422, r.body?.error);

  console.log('\n── Admin: a pattern is stored the way the scanner reads text ──');

  // The scanner normalises the text it scans. A pattern that is only lowercased can hold a
  // zero-width character, a leetspeak digit or a double space and never match anything — and it
  // fails silently, sitting in the list looking active with a hit count of zero.
  const zeroWidth = String.fromCharCode(0x200b);

  r = await api(null, 'POST', '/admin/risk-terms', {
    category: 'SCAM', pattern: `  E2E  C4$H${zeroWidth} UPFRONT  `, weight: 40,
  }, adminHeaders(safeguarding));
  check('a phrase is stored normalised, not as typed',
    r.status === 200 && r.body?.data?.pattern === 'e2e cash upfront', r.body?.data?.pattern);
  const normalisedId = r.body?.data?.id;

  r = await api(null, 'POST', '/admin/risk-terms', {
    category: 'SCAM', pattern: 'e2e cash upfront', weight: 55,
  }, adminHeaders(safeguarding));
  check('and a differently-typed spelling of it is the same term, not a second one',
    r.status === 200 && r.body?.data?.id === normalisedId && r.body?.data?.weight === 55,
    { id: r.body?.data?.id, weight: r.body?.data?.weight });

  r = await api(null, 'POST', '/admin/risk-terms', {
    category: 'SCAM', pattern: zeroWidth.repeat(30), weight: 40,
  }, adminHeaders(safeguarding));
  check('a phrase that collapses to nothing is refused, and says what it collapsed to',
    r.status === 400 && /normalises to/.test(JSON.stringify(r.body?.error?.details ?? [])),
    r.body?.error);

  r = await api(null, 'POST', '/admin/risk-terms', {
    category: 'SCAM', pattern: 'e2e ' + 'x'.repeat(130), weight: 40,
  }, adminHeaders(safeguarding));
  check('and so is one over 120 characters', r.status === 400, r.status);

  console.log('\n── Admin: the phrase itself cannot be edited ────────────────');

  r = await api(null, 'PATCH', `/admin/risk-terms/${normalisedId}`, {
    weight: 80, notes: 'Seen in three reports this week.',
  }, adminHeaders(safeguarding));
  check('weight and notes can be retuned',
    r.status === 200 && r.body?.data?.weight === 80 && /three reports/.test(r.body?.data?.notes ?? ''),
    r.body?.data);

  r = await api(null, 'PATCH', `/admin/risk-terms/${normalisedId}`, {
    pattern: 'something else entirely',
  }, adminHeaders(safeguarding));
  check('but the phrase cannot: its hit count is evidence about those exact words',
    r.status === 400 && /pattern/.test(JSON.stringify(r.body)), r.body?.error);

  r = await api(null, 'PATCH', `/admin/risk-terms/${normalisedId}`, {
    notes: 'x'.repeat(520),
  }, adminHeaders(safeguarding));
  check('notes are capped at 500 characters', r.status === 400, r.status);

  console.log('\n── Admin: moving a phrase into an occupied slot ─────────────');

  r = await api(null, 'POST', '/admin/risk-terms', {
    category: 'EXPLOITATION', pattern: 'e2e cash upfront', weight: 20,
  }, adminHeaders(safeguarding));
  const otherCategoryId = r.body?.data?.id;
  check('the same phrase can exist under another category', r.status === 200, r.body?.error);

  r = await api(null, 'PATCH', `/admin/risk-terms/${otherCategoryId}`, {
    category: 'SCAM',
  }, adminHeaders(safeguarding));
  check('moving it onto one that is taken is a conflict, not a 500',
    r.status === 409 && r.body?.error?.code === 'CONFLICT', r.body?.error);

  await prisma.riskTerm.deleteMany({ where: { pattern: { startsWith: 'e2e ' } } });

  r = await api(null, 'DELETE', `/admin/guard/risk-terms/${newTermId}`, null, adminHeaders(safeguarding));
  check('turning one off → 200, deactivated not deleted', r.status === 200 && r.body?.data?.isActive === false, r.body?.error);

  r = await api(null, 'GET', '/admin/risk-terms', null, adminHeaders(safeguarding));
  check('and the lexicon is readable at the new path as well as the old',
    r.status === 200 && Array.isArray(r.body?.data), r.status);
  check('a listed term carries no internal history in the response',
    (r.body?.data ?? []).every(term => !('before' in term)), Object.keys(r.body?.data?.[0] ?? {}));

  console.log('\n── Admin: a number in a phrase survives ─────────────────────');

  // Folding every digit turned "working 16 hours" into "working i6 hours" and "£500 deposit" into
  // "£soo deposit". Matching still worked, because both sides normalise — what broke was what a
  // person reads back. One of the seeded risk terms was affected.
  r = await api(null, 'POST', '/admin/risk-terms', {
    category: 'EXPLOITATION', pattern: 'e2e working 16 hours for £500', weight: 30,
  }, adminHeaders(safeguarding));
  check('a phrase with numbers in it is stored as written',
    r.status === 200 && r.body?.data?.pattern === 'e2e working 16 hours for £500',
    r.body?.data?.pattern);

  r = await api(null, 'POST', '/admin/risk-terms', {
    category: 'SCAM', pattern: 'e2e c4$h 1n h4nd', weight: 30,
  }, adminHeaders(safeguarding));
  check('while a substitution inside a word is still folded',
    r.status === 200 && r.body?.data?.pattern === 'e2e cash in hand', r.body?.data?.pattern);

  console.log('\n── Admin: lexicon changes are audited ──────────────────────');

  const auditFrom = new Date();

  r = await api(null, 'POST', '/admin/risk-terms', {
    category: 'SCAM', pattern: 'e2e audited phrase', weight: 25,
  }, adminHeaders(safeguarding));
  const auditedId = r.body?.data?.id;

  await api(null, 'PATCH', `/admin/risk-terms/${auditedId}`, { weight: 65 }, adminHeaders(safeguarding));
  await api(null, 'DELETE', `/admin/risk-terms/${auditedId}`, null, adminHeaders(safeguarding));

  const lexiconEntries = await prisma.auditLog.findMany({
    where: { occurredAt: { gte: auditFrom }, action: { startsWith: 'risk_term.' } },
    orderBy: { occurredAt: 'asc' },
  });
  check('adding, retuning and turning off a phrase are each recorded',
    lexiconEntries.length >= 3, lexiconEntries.map(e => e.action));
  check('under the safety area, so trust & safety can read each other\'s work',
    lexiconEntries.every(e => e.area === 'SAFETY'), lexiconEntries.map(e => e.area));
  check('naming the staff member who did it',
    lexiconEntries.every(e => e.actorId === safeguarding.id), lexiconEntries.map(e => e.actorId));

  const retune = lexiconEntries.find(e => e.before?.weight === 25);
  check('with what it was before and what it became',
    retune?.before?.weight === 25 && retune?.after?.weight === 65,
    { before: retune?.before, after: retune?.after });

  const off = lexiconEntries.find(e => e.action === 'risk_term.deactivated');
  check('and a deactivation shows the phrase going inactive',
    off?.before?.isActive === true && off?.after?.isActive === false,
    { before: off?.before?.isActive, after: off?.after?.isActive });

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await prisma.riskTerm.deleteMany({ where: { pattern: { startsWith: 'e2e-' } } });
  await sweep('cleanup');

  await finish();
})().catch(fail);
