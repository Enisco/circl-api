/* Circl Guard and the admin endpoints. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');
const jwt = require('jsonwebtoken');

/** Creates a staff account holding exactly one role's permissions. */
async function makeStaff(tag, roleCode) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const user = await prisma.user.create({
    data: {
      firstName: 'E2E', lastName: tag, email: `e2e-${tag}-${stamp}@example.test`,
      username: `e2e_${tag}_${stamp}`, status: 'ACTIVE', isStaff: true,
      userRole: { create: { roleId: role.id } },
      profile: { create: { cityId: 'MANCHESTER' } },
      sessions: {
        create: {
          userAgent: 'e2e', deviceType: 'cli', browserName: 'cli', operatingSystem: 'cli',
          ipAddress: '127.0.0.1', isActive: true, deviceFingerprint: `e2e-${tag}-${stamp}`,
        },
      },
    },
    include: { sessions: true },
  });

  return {
    id: user.id,
    token: jwt.sign({ sub: user.id, sid: user.sessions[0].id }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' }),
  };
}

(async () => {
  await sweep('pre-run');

  const member = await makeUser('member');
  const moderator = await makeStaff('mod', 'moderator');
  const safeguarding = await makeStaff('safe', 'safeguarding');

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
  check('a member cannot read the Guard queue → 403', r.status === 403, r.status);

  r = await api(moderator.token, 'GET', '/admin/guard/cases');
  check('a MODERATOR cannot read it either — different job, different permission', r.status === 403, r.status);

  r = await api(safeguarding.token, 'GET', '/admin/guard/cases');
  check('safeguarding staff can → 200', r.status === 200, r.body?.error);
  check('both of this run\'s cases are listed',
    [guardThreadId, quietThreadId].every(id => r.body?.data?.some(c => c.id === id)),
    r.body?.data?.length);
  check('the urgent one is FIRST, ahead of the older quiet one',
    r.body?.data?.[0]?.id === guardThreadId, r.body?.data?.map(c => `${c.risk?.level}:${c.subject}`));
  check('meta.urgentCount surfaces the number that should never sit', r.body?.meta?.urgentCount >= 1, r.body?.meta);
  check('the reviewer sees the matched phrases', r.body?.data?.[0]?.risk?.signals?.length >= 2, r.body?.data?.[0]?.risk);

  r = await api(safeguarding.token, 'PATCH', `/admin/guard/cases/${guardThreadId}`, {
    state: 'IN_PROGRESS', assignedToId: safeguarding.id,
  });
  check('assign → 200', r.status === 200 && r.body?.data?.state === 'IN_PROGRESS', r.body?.error);

  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId: guardConversationId },
  });
  check('assigning joins the staff member to the thread', participants.some(p => p.userId === safeguarding.id), participants.map(p => p.userId));

  r = await api(safeguarding.token, 'POST', `/messages/${guardConversationId}/messages`, {
    clientId: 'staff-1', body: 'I have read this. Let me find you somewhere safe to stay tonight.',
  });
  check('assigned staff can reply in the thread', r.status === 201, r.body?.error);

  console.log('\n── Admin: anonymous posts are still moderated ───────────────');

  r = await api(member.token, 'POST', '/community/updates', {
    content: 'Posting this anonymously because I do not want my employer to see it.',
    visibility: 'ANONYMOUS',
  });
  const anonUpdateId = r.body?.data?.id;
  check('anonymous post created', r.status === 201, r.body?.error);

  await new Promise(res => setTimeout(res, 600));
  r = await api(moderator.token, 'GET', '/admin/moderation/queue?type=ANONYMOUS_POST');
  check('it lands in the approval queue even though nobody reported it', r.body?.data?.some(i => i.targetId === anonUpdateId), r.body?.data?.length);
  const anonQueueId = r.body?.data?.find(i => i.targetId === anonUpdateId)?.id;
  check('the row carries the content, so no second screen is needed', !!r.body?.data?.find(i => i.id === anonQueueId)?.content?.content, r.body?.data?.[0]?.content);

  r = await api(moderator.token, 'POST', `/admin/moderation/queue/${anonQueueId}/claim`);
  check('claim → 200', r.status === 200, r.body?.error);
  r = await api(safeguarding.token, 'POST', `/admin/moderation/queue/${anonQueueId}/claim`);
  check('a second claimer → 409, so two people do not work one item', r.status === 409, r.body?.error);

  r = await api(moderator.token, 'POST', `/admin/moderation/queue/${anonQueueId}/decide`, {
    decision: 'APPROVE', reason: 'Nothing wrong with it.',
  });
  check('approve → 200 RESOLVED', r.status === 200 && r.body?.data?.state === 'RESOLVED', r.body?.error);

  r = await api(moderator.token, 'POST', `/admin/moderation/queue/${anonQueueId}/decide`, { decision: 'APPROVE' });
  check('deciding twice → 409', r.status === 409, r.body?.error);

  r = await api(moderator.token, 'GET', `/admin/moderation/actions/UPDATE/${anonUpdateId}`);
  check('the decision is on an append-only audit trail', r.body?.data?.length === 1 && r.body.data[0].decision === 'APPROVE', r.body?.data);
  check('and names who made it', r.body?.data?.[0]?.actor?.id === moderator.id, r.body?.data?.[0]?.actor);

  console.log('\n── Admin: removing content ──────────────────────────────────');

  r = await api(member.token, 'POST', '/community/updates', { content: 'Buy cheap watches at my website, guaranteed.' });
  const spamId = r.body?.data?.id;
  await api(quiet.token, 'POST', '/moderation/reports', {
    targetType: 'UPDATE', targetId: spamId, reasonCode: 'SPAM',
  });
  await new Promise(res => setTimeout(res, 400));

  r = await api(moderator.token, 'GET', '/admin/moderation/queue?type=REPORTED_CONTENT');
  const spamQueueId = r.body?.data?.find(i => i.targetId === spamId)?.id;
  check('a report lands in the queue', !!spamQueueId, r.body?.data?.length);

  r = await api(moderator.token, 'POST', `/admin/moderation/queue/${spamQueueId}/decide`, {
    decision: 'REMOVE_CONTENT', reason: 'Advertising.',
  });
  check('remove → 200', r.status === 200, r.body?.error);
  r = await api(quiet.token, 'GET', `/community/updates/${spamId}`);
  check('the post now tombstones for readers', r.status === 404 && r.body?.error?.code === 'RESOURCE_DELETED', r.body?.error);

  const reportRow = await prisma.report.findFirst({ where: { targetId: spamId } });
  check('the report is marked actioned', reportRow?.state === 'ACTIONED', reportRow?.state);

  console.log('\n── Admin: suspending a member ───────────────────────────────');

  r = await api(moderator.token, 'PATCH', `/admin/users/${member.id}/status`, { status: 'SUSPENDED' });
  check('a moderator lacks users:manage → 403', r.status === 403, r.status);

  const superAdmin = await makeStaff('root', 'super_admin');
  r = await api(superAdmin.token, 'PATCH', `/admin/users/${member.id}/status`, {
    status: 'SUSPENDED', reason: 'Repeated advertising.',
  });
  check('manage:all short-circuits every permission → 200', r.status === 200, r.body?.error);

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

  r = await api(safeguarding.token, 'POST', '/admin/guard/risk-terms', {
    category: 'SCAM', pattern: 'e2e-brand-new-scam-phrase', weight: 70,
  });
  check('safeguarding staff can add a phrase → 200', r.status === 200, r.body?.error);
  const newTermId = r.body?.data?.id;

  // The scanner caches for two minutes, so this proves the row is right rather than waiting out the TTL in a test.
  const stored = await prisma.riskTerm.findUnique({ where: { id: newTermId } });
  check('stored lowercase and active', stored?.pattern === 'e2e-brand-new-scam-phrase' && stored?.isActive === true, stored);

  r = await api(moderator.token, 'POST', '/admin/guard/risk-terms', { category: 'SCAM', pattern: 'nope' });
  check('a moderator cannot edit the lexicon → 403', r.status === 403, r.status);

  r = await api(safeguarding.token, 'POST', '/admin/guard/risk-terms', { category: 'NOT_A_CATEGORY', pattern: 'x' });
  check('an unknown risk category → 422', r.status === 422, r.body?.error);

  r = await api(safeguarding.token, 'DELETE', `/admin/guard/risk-terms/${newTermId}`);
  check('turning one off → 200, deactivated not deleted', r.status === 200 && r.body?.data?.isActive === false, r.body?.error);

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await prisma.riskTerm.deleteMany({ where: { pattern: { startsWith: 'e2e-' } } });
  await sweep('cleanup');

  await finish();
})().catch(fail);
