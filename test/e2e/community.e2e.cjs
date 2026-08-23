/* Section 1 end-to-end check against the running server. Creates two throwaway
   users, exercises the flows, then removes everything it made. */
require('dotenv').config({ path: './.env' });
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

const BASE = 'http://localhost:4000/api/v1';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`); }
};

async function api(token, method, path, body, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function makeUser(tag) {
  const role = await prisma.role.findUnique({ where: { code: 'user' } });
  const user = await prisma.user.create({
    data: {
      firstName: 'E2E', lastName: tag, email: `e2e-${tag}-${Date.now()}@example.test`,
      username: `e2e_${tag}_${Date.now()}`, status: 'ACTIVE',
      userRole: { create: { roleId: role.id } },
      profile: { create: { cityId: 'MANCHESTER', journeyStage: 'JUST_ARRIVED', interests: ['JOB_SEARCH'] } },
      trustChecks: { create: { check: 'EMAIL', status: 'VERIFIED', verifiedAt: new Date() } },
      sessions: {
        create: {
          userAgent: 'e2e', deviceType: 'cli', browserName: 'cli', operatingSystem: 'cli',
          ipAddress: '127.0.0.1', isActive: true, deviceFingerprint: `e2e-${tag}-${Date.now()}`,
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
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const created = { requests: [], offers: [], updates: [], guides: [], groups: [] };

  console.log('\n── 1.2 Requests ─────────────────────────────────────────────');

  let r = await api(alice.token, 'POST', '/community/requests', {
    categoryCode: 'VISA_DOCS', title: 'Need help understanding my CoS letter',
    description: 'I got my Certificate of Sponsorship last week and I cannot make sense of the sponsor details section.',
    cityId: 'MANCHESTER', thankYouAmount: 2000,
  }, { 'Idempotency-Key': 'e2e-req-1' });
  check('create request → 201', r.status === 201, r.body);
  const reqId = r.body?.data?.id;
  check('envelope has success+status+data', r.body?.success === true && r.body?.status === 'success' && !!r.body?.data);
  check('category is {code,label}', r.body?.data?.category?.code === 'VISA_DOCS' && !!r.body?.data?.category?.label, r.body?.data?.category);
  check('thankYou is money object', r.body?.data?.thankYou?.amount === 2000 && r.body?.data?.thankYou?.currency === 'GBP');
  check('reportToken present', typeof r.body?.data?.reportToken === 'string');
  check('viewer.canResolve true for owner', r.body?.data?.viewer?.canResolve === true);
  check('counts.privateReplies present for owner', r.body?.data?.counts?.privateReplies === 0);
  created.requests.push(reqId);

  r = await api(alice.token, 'POST', '/community/requests', {
    categoryCode: 'VISA_DOCS', title: 'Need help understanding my CoS letter',
    description: 'I got my Certificate of Sponsorship last week and I cannot make sense of the sponsor details section.',
    cityId: 'MANCHESTER', thankYouAmount: 2000,
  }, { 'Idempotency-Key': 'e2e-req-1' });
  check('idempotent replay returns same id', r.body?.data?.id === reqId, { got: r.body?.data?.id });

  r = await api(alice.token, 'POST', '/community/requests', {
    categoryCode: 'VISA_DOCS', title: 'Short', cityId: 'MANCHESTER',
  });
  check('title < 6 → 400 with details[].field', r.status === 400 && r.body?.error?.details?.[0]?.field === 'title', r.body?.error);

  r = await api(alice.token, 'POST', '/community/requests', {
    categoryCode: 'NOT_A_REAL_CODE', title: 'A valid enough title here', cityId: 'MANCHESTER',
  });
  check('bad category → 422 UNKNOWN_TAXONOMY_CODE', r.status === 422 && r.body?.error?.code === 'UNKNOWN_TAXONOMY_CODE', r.body?.error);

  r = await api(alice.token, 'POST', '/community/requests', {
    categoryCode: 'VISA_DOCS', title: 'A private matter I need help with', cityId: 'MANCHESTER',
    visibility: 'PRIVATE_TO_CIRCL',
  });
  check('PRIVATE_TO_CIRCL → 422 USE_PRIVATE_ENDPOINT', r.status === 422 && r.body?.error?.code === 'USE_PRIVATE_ENDPOINT', r.body?.error);

  r = await api(bob.token, 'GET', `/community/requests/${reqId}`);
  check('non-owner detail omits privateReplies', r.body?.data?.counts?.privateReplies === undefined, r.body?.data?.counts);
  check('non-owner canEdit false', r.body?.data?.viewer?.canEdit === false);

  console.log('\n── 1.3 Responses ────────────────────────────────────────────');

  r = await api(bob.token, 'POST', `/community/requests/${reqId}/responses`, {
    content: 'I went through this last year, happy to walk you through it.', isHelpOffer: true,
  });
  check('offer to help → 201', r.status === 201, r.body);
  check('returns updated parent counts', r.body?.data?.requestCounts?.helpers === 1, r.body?.data?.requestCounts);

  r = await api(bob.token, 'POST', `/community/requests/${reqId}/responses`, {
    content: 'Also, check the sponsor licence number on page two.', isHelpOffer: true,
  });
  check('second help offer → 409 ALREADY_OFFERED', r.status === 409 && r.body?.error?.code === 'ALREADY_OFFERED', r.body?.error);

  r = await api(bob.token, 'POST', `/community/requests/${reqId}/responses`, {
    content: 'One more thought — the sponsor licence number is on page two.',
  });
  check('second plain reply allowed → 201', r.status === 201, r.body?.error);
  check('replies now 2, helpers still 1', r.body?.data?.requestCounts?.replies === 2 && r.body?.data?.requestCounts?.helpers === 1, r.body?.data?.requestCounts);

  r = await api(alice.token, 'POST', `/community/requests/${reqId}/responses`, {
    content: 'Thanks so much for this.', isHelpOffer: true,
  });
  check('owner cannot offer on own request → 422', r.status === 422 && r.body?.error?.code === 'CANNOT_OFFER_ON_OWN_REQUEST', r.body?.error);

  r = await api(bob.token, 'POST', `/community/requests/${reqId}/responses`, {
    content: 'Message me privately and I will send you a template.', isPrivate: true,
  });
  check('private reply → 201', r.status === 201);

  r = await api(alice.token, 'GET', `/community/requests/${reqId}/responses`);
  check('owner sees private reply', r.body?.data?.some(x => x.isPrivate === true), r.body?.data?.map(x => x.isPrivate));
  check('owner sees private first', r.body?.data?.[0]?.isPrivate === true);
  const ownerTotal = r.body?.meta?.totalCount;

  const carol = await makeUser('carol');
  r = await api(carol.token, 'GET', `/community/requests/${reqId}/responses`);
  check('third party cannot see private reply', !r.body?.data?.some(x => x.isPrivate === true));
  check('totalCount excludes private for third party', r.body?.meta?.totalCount === ownerTotal - 1, { third: r.body?.meta?.totalCount, owner: ownerTotal });

  r = await api(bob.token, 'GET', `/community/requests/${reqId}`);
  check('viewer.hasOffered true for bob', r.body?.data?.viewer?.hasOffered === true);

  console.log('\n── 1.2.5 Resolve ────────────────────────────────────────────');

  r = await api(alice.token, 'POST', `/community/requests/${reqId}/resolve`, { helperUserIds: [carol.id] });
  check('crediting a non-responder → 422 NOT_A_RESPONDER', r.status === 422 && r.body?.error?.code === 'NOT_A_RESPONDER', r.body?.error);

  r = await api(alice.token, 'POST', `/community/requests/${reqId}/resolve`, { helperUserIds: [bob.id], outcome: 'HELPED' });
  check('resolve → 200 RESOLVED', r.status === 200 && r.body?.data?.status === 'RESOLVED', r.body?.error);
  check('resolution.helpers populated', r.body?.data?.resolution?.helpers?.length === 1, r.body?.data?.resolution);
  check('canEdit false once resolved', r.body?.data?.viewer?.canEdit === false);

  r = await api(alice.token, 'POST', `/community/requests/${reqId}/resolve`, {});
  check('re-resolve → 409 REQUEST_ALREADY_RESOLVED', r.status === 409 && r.body?.error?.code === 'REQUEST_ALREADY_RESOLVED', r.body?.error);

  r = await api(carol.token, 'POST', `/community/requests/${reqId}/responses`, { content: 'Can I still help?' });
  check('reply to closed request → 403 REQUEST_CLOSED', r.status === 403 && r.body?.error?.code === 'REQUEST_CLOSED', r.body?.error);

  console.log('\n── 1.4 Offers ───────────────────────────────────────────────');

  r = await api(bob.token, 'POST', '/community/offers', {
    title: 'Airport pickups from Manchester Airport',
    description: 'I drive a 7-seater and do airport runs most evenings, including early mornings.',
    categoryCode: 'AIRPORT_PICKUP', cityId: 'MANCHESTER', priceFrom: 3000, priceBasis: 'PER_JOB',
  });
  check('create offer → 201', r.status === 201, r.body?.error);
  check('isFree false with a price', r.body?.data?.isFree === false);
  created.offers.push(r.body?.data?.id);

  r = await api(bob.token, 'POST', '/community/offers', {
    title: 'Free CV review for newcomers',
    description: 'I have hired in the UK for eight years and will read your CV and give you notes.',
    categoryCode: 'JOBS', cityId: 'MANCHESTER',
  });
  check('free offer → isFree true, priceFrom null', r.body?.data?.isFree === true && r.body?.data?.priceFrom === null);
  created.offers.push(r.body?.data?.id);

  r = await api(alice.token, 'GET', '/community/offers?freeOnly=true');
  check('freeOnly filter works', r.body?.data?.every(o => o.isFree === true) && r.body?.data?.length >= 1, r.body?.data?.map(o => o.isFree));

  console.log('\n── 1.5 Updates ──────────────────────────────────────────────');

  r = await api(alice.token, 'POST', '/community/updates', {
    content: 'Finally got my BRP today after six weeks of waiting.', commentsEnabled: true,
  });
  check('create update → 201', r.status === 201, r.body?.error);
  const updId = r.body?.data?.id;
  created.updates.push(updId);

  r = await api(bob.token, 'POST', `/community/updates/${updId}/reactions`);
  check('like → count 1', r.body?.data?.hasLiked === true && r.body?.data?.reactionCount === 1, r.body?.data);
  r = await api(bob.token, 'POST', `/community/updates/${updId}/reactions`);
  check('like twice is idempotent, not 409', r.status === 200 && r.body?.data?.reactionCount === 1, r.body?.data);
  r = await api(bob.token, 'DELETE', `/community/updates/${updId}/reactions`);
  check('unlike → count 0', r.body?.data?.reactionCount === 0, r.body?.data);

  r = await api(bob.token, 'POST', `/community/updates/${updId}/replies`, { content: 'Congratulations!' });
  check('reply to update → 201', r.status === 201, r.body?.error);

  r = await api(alice.token, 'POST', '/community/updates', {
    content: 'Quiet post, no comments please.', commentsEnabled: false,
  });
  const noCommentId = r.body?.data?.id;
  created.updates.push(noCommentId);
  r = await api(bob.token, 'POST', `/community/updates/${noCommentId}/replies`, { content: 'Hello' });
  check('comments off → 403 COMMENTS_DISABLED', r.status === 403 && r.body?.error?.code === 'COMMENTS_DISABLED', r.body?.error);

  r = await api(alice.token, 'POST', '/community/updates', {
    content: 'Hidden count post.', reactionCountHidden: true,
  });
  const hiddenId = r.body?.data?.id;
  created.updates.push(hiddenId);
  await api(bob.token, 'POST', `/community/updates/${hiddenId}/reactions`);
  r = await api(bob.token, 'GET', `/community/updates/${hiddenId}`);
  check('hidden count omitted for non-author', r.body?.data?.counts?.reactions === undefined, r.body?.data?.counts);
  r = await api(alice.token, 'GET', `/community/updates/${hiddenId}`);
  check('hidden count visible to author', r.body?.data?.counts?.reactions === 1, r.body?.data?.counts);

  console.log('\n── 1.6 Guides ───────────────────────────────────────────────');

  r = await api(alice.token, 'POST', '/community/guides', {
    topicCode: 'FINANCE',
    title: 'Opening a UK bank account with no proof of address',
    intro: 'Most branches will tell you no. Here is the route that actually works, step by step.',
    steps: [
      'Book an appointment online before you go, most branches no longer take walk-ins.',
      'Take your BRP, your university or employer letter, and your passport.',
      'Ask specifically for a basic account if they refuse a current account.',
    ],
    cityId: 'MANCHESTER',
  });
  check('create guide → 201', r.status === 201, r.body?.error);
  const guideId = r.body?.data?.id;
  created.guides.push(guideId);
  check('readTimeMinutes computed', r.body?.data?.readTimeMinutes >= 1);
  check('steps projected from blocks', Array.isArray(r.body?.data?.steps) && r.body.data.steps.length === 3);
  check('blocks stored', r.body?.data?.blocks?.[0]?.type === 'STEP');
  check('provenance null for member-written', r.body?.data?.provenance === null);

  r = await api(bob.token, 'PUT', `/community/guides/${guideId}/progress`, { progress: 0.42 });
  check('progress saved', r.body?.data?.progress === 0.42, r.body?.data);
  r = await api(bob.token, 'PUT', `/community/guides/${guideId}/progress`, { progress: 0.10 });
  check('progress does not go backwards', r.body?.data?.progress === 0.42, r.body?.data);

  r = await api(bob.token, 'GET', '/community/guides?section=CONTINUE_READING');
  check('CONTINUE_READING finds the started guide', r.body?.data?.some(g => g.id === guideId), r.body?.data?.length);

  r = await api(bob.token, 'POST', `/community/guides/${guideId}/bookmark`);
  check('bookmark → true', r.body?.data?.isBookmarked === true);
  r = await api(bob.token, 'POST', `/community/guides/${guideId}/feedback`, { useful: true });
  check('feedback accepted', r.body?.data?.useful === true);

  r = await api(bob.token, 'POST', '/community/guides/match', {
    categoryCode: 'BANK_ACCOUNT', title: 'How do I open a bank account without proof of address?',
  });
  check('guide match responds', r.status === 200 && Array.isArray(r.body?.data?.matches), r.body);
  console.log(`    (matches: ${r.body?.data?.matches?.length}, confidence: ${r.body?.data?.matches?.[0]?.confidence ?? 'n/a'})`);

  console.log('\n── 1.7 Groups ───────────────────────────────────────────────');

  r = await api(alice.token, 'POST', '/community/groups', {
    name: `E2E Manchester Nigerians ${Date.now()}`,
    description: 'Everything from where to find yam to where to worship in the city.',
    cityId: 'MANCHESTER',
  });
  check('create group → 201', r.status === 201, r.body?.error);
  const groupId = r.body?.data?.id;
  created.groups.push(groupId);
  check('creator is ADMIN, memberCount 1', r.body?.data?.viewer?.membership === 'ADMIN' && r.body?.data?.memberCount === 1, r.body?.data);
  check('isNew true', r.body?.data?.isNew === true);

  const groupName = r.body?.data?.name;
  r = await api(bob.token, 'POST', '/community/groups', {
    name: groupName, description: 'A duplicate name in the same city, which should be refused.',
    cityId: 'MANCHESTER',
  });
  check('duplicate name in city → 409 GROUP_NAME_TAKEN', r.status === 409 && r.body?.error?.code === 'GROUP_NAME_TAKEN', r.body?.error);

  r = await api(bob.token, 'POST', `/community/groups/${groupId}/posts`, { content: 'Hello!' });
  check('non-member cannot post → 403 NOT_A_MEMBER', r.status === 403 && r.body?.error?.code === 'NOT_A_MEMBER', r.body?.error);

  r = await api(bob.token, 'GET', `/community/groups/${groupId}/posts`);
  check('non-member gets preview flag', r.body?.meta?.preview === true, r.body?.meta);

  r = await api(bob.token, 'POST', `/community/groups/${groupId}/join`);
  check('open group join → MEMBER, count 2', r.body?.data?.membership === 'MEMBER' && r.body?.data?.memberCount === 2, r.body?.data);

  r = await api(bob.token, 'POST', `/community/groups/${groupId}/posts`, {
    content: 'Just found out MMU runs a free legal advice clinic on Thursdays.',
  });
  check('member can post → 201', r.status === 201, r.body?.error);
  const postId = r.body?.data?.id;

  r = await api(alice.token, 'POST', `/community/groups/${groupId}/posts/${postId}/replies`, { content: 'Useful, thank you.' });
  check('reply to group post → 201', r.status === 201, r.body?.error);

  r = await api(alice.token, 'GET', `/community/groups/${groupId}/posts/${postId}/replies`);
  check('replies return parent post too', !!r.body?.data?.post?.id && Array.isArray(r.body?.data?.replies), Object.keys(r.body?.data ?? {}));

  r = await api(alice.token, 'DELETE', `/community/groups/${groupId}/join`);
  check('last admin cannot leave → 409', r.status === 409 && r.body?.error?.code === 'LAST_ADMIN_CANNOT_LEAVE', r.body?.error);

  r = await api(alice.token, 'POST', '/community/groups', {
    name: `E2E Approval Group ${Date.now()}`,
    description: 'This one needs approval before anyone can join it at all.',
    cityId: 'MANCHESTER', joinPolicy: 'APPROVAL',
  });
  const approvalGroupId = r.body?.data?.id;
  created.groups.push(approvalGroupId);
  r = await api(bob.token, 'POST', `/community/groups/${approvalGroupId}/join`);
  check('approval group join → PENDING, count unchanged', r.body?.data?.membership === 'PENDING' && r.body?.data?.memberCount === 1, r.body?.data);
  r = await api(alice.token, 'GET', `/community/groups/${approvalGroupId}/join-requests`);
  check('admin sees the queue', r.body?.data?.length === 1, r.body?.data);
  r = await api(alice.token, 'POST', `/community/groups/${approvalGroupId}/join-requests/${bob.id}`, { decision: 'APPROVE' });
  check('approve → MEMBER, count 2', r.body?.data?.membership === 'MEMBER' && r.body?.data?.memberCount === 2, r.body?.data);

  console.log('\n── 1.1 Feed ─────────────────────────────────────────────────');

  r = await api(bob.token, 'GET', '/community/feed?limit=10');
  check('feed → 200', r.status === 200, r.body?.error);
  check('meta.totalCount is null (cursor paging)', r.body?.meta?.totalCount === null, r.body?.meta);
  check('items carry a type discriminator', r.body?.data?.every(i => !!i.type), r.body?.data?.map(i => i.type));
  const types = [...new Set(r.body?.data?.map(i => i.type) ?? [])];
  console.log(`    (types present: ${types.join(', ')}, items: ${r.body?.data?.length})`);

  r = await api(bob.token, 'GET', '/community/feed?types=REQUEST&limit=10');
  check('types filter honoured', r.body?.data?.every(i => i.type === 'REQUEST'), r.body?.data?.map(i => i.type));

  r = await api(bob.token, 'GET', '/community/feed?categories=VISA_DOCS&limit=10');
  check('category filter excludes UPDATE items', !r.body?.data?.some(i => i.type === 'UPDATE'), r.body?.data?.map(i => i.type));

  const firstFeed = await api(bob.token, 'GET', '/community/feed?limit=2');
  if (firstFeed.body?.meta?.nextCursor) {
    const second = await api(bob.token, 'GET', `/community/feed?limit=2&cursor=${encodeURIComponent(firstFeed.body.meta.nextCursor)}`);
    const firstIds = firstFeed.body.data.map(i => i.id);
    check('cursor page does not repeat items', !second.body?.data?.some(i => firstIds.includes(i.id)), { firstIds, secondIds: second.body?.data?.map(i => i.id) });
  } else { check('cursor page does not repeat items (skipped, one page)', true); }

  const target = firstFeed.body?.data?.[0];
  if (target) {
    r = await api(bob.token, 'POST', `/community/feed/${target.id}/less-like-this`, { type: target.type, reason: 'NOT_RELEVANT' });
    check('less-like-this → 204', r.status === 204, r.body);
    r = await api(bob.token, 'GET', '/community/feed?limit=20');
    check('suppressed item no longer in feed', !r.body?.data?.some(i => i.id === target.id));
  }

  console.log('\n── 1.8 Moderation & blocking ────────────────────────────────');

  r = await api(carol.token, 'POST', '/moderation/reports', {
    targetType: 'REQUEST', targetId: reqId, reasonCode: 'SPAM', note: 'This looks like spam to me.',
  });
  check('report → 202', r.status === 202, r.body?.error);

  r = await api(carol.token, 'POST', '/moderation/blocks', { userId: alice.id });
  check('block → 201', r.status === 201, r.body?.error);

  r = await api(carol.token, 'GET', '/community/requests?status=ALL&cityId=ANYWHERE&limit=50');
  check("blocked author's requests hidden from list", !r.body?.data?.some(x => x.id === reqId), r.body?.data?.length);

  r = await api(carol.token, 'GET', `/community/requests/${reqId}`);
  check('blocked content still fetchable with viewer.isBlocked', r.status === 200 && r.body?.data?.viewer?.isBlocked === true, { status: r.status, viewer: r.body?.data?.viewer });

  r = await api(carol.token, 'GET', '/moderation/blocks');
  check('blocked list returns the member', r.body?.data?.length === 1, r.body?.data);

  r = await api(carol.token, 'DELETE', `/moderation/blocks/${alice.id}`);
  check('unblock → 204', r.status === 204);

  console.log('\n── Anonymity & tombstones ───────────────────────────────────');

  r = await api(alice.token, 'POST', '/community/requests', {
    categoryCode: 'ACCOMMODATION', title: 'My landlord will not return my deposit',
    description: 'I moved out three months ago and he keeps ignoring my messages about the deposit.',
    cityId: 'MANCHESTER', visibility: 'ANONYMOUS',
  });
  const anonId = r.body?.data?.id;
  created.requests.push(anonId);
  r = await api(bob.token, 'GET', `/community/requests/${anonId}`);
  check('anonymous: author.id null', r.body?.data?.author?.id === null, r.body?.data?.author);
  check('anonymous: username null', r.body?.data?.author?.username === null);
  check('anonymous: displayName names the city', /Manchester/.test(r.body?.data?.author?.displayName ?? ''), r.body?.data?.author?.displayName);
  const anonToken = r.body?.data?.reportToken;
  r = await api(bob.token, 'POST', '/moderation/reports', {
    targetType: 'REQUEST', targetId: anonToken, reasonCode: 'HARASSMENT',
  });
  check('report anonymous post by reportToken → 202', r.status === 202, r.body?.error);
  r = await api(bob.token, 'POST', '/moderation/blocks', { userId: anonToken });
  check('block anonymous author by reportToken → 201', r.status === 201, r.body?.error);
  await api(bob.token, 'DELETE', `/moderation/blocks/${alice.id}`);

  r = await api(alice.token, 'DELETE', `/community/requests/${created.requests[0]}`);
  check('delete request → 204', r.status === 204);
  r = await api(bob.token, 'GET', `/community/requests/${created.requests[0]}`);
  check('deleted → 404 RESOURCE_DELETED (tombstone)', r.status === 404 && r.body?.error?.code === 'RESOURCE_DELETED', r.body?.error);

  console.log('\n── Circl Guard ──────────────────────────────────────────────');

  r = await api(alice.token, 'POST', '/community/requests', {
    categoryCode: 'ACCOMMODATION', title: 'I am scared and not safe at home right now',
    description: 'My partner beats me and I have nowhere to go. He took my passport last week.',
    cityId: 'MANCHESTER',
  });
  const guardReqId = r.body?.data?.id;
  created.requests.push(guardReqId);
  await new Promise(res => setTimeout(res, 700));
  const queued = await prisma.moderationQueueItem.findFirst({ where: { targetId: guardReqId } });
  check('high-risk post queued for Guard', !!queued, queued);
  check('risk level HIGH or CRITICAL', ['HIGH', 'CRITICAL'].includes(queued?.riskLevel), queued?.riskLevel);
  check('risk category DOMESTIC_ABUSE', queued?.riskCategory === 'DOMESTIC_ABUSE', queued?.riskCategory);
  check('matched signals recorded for the reviewer', Array.isArray(queued?.riskSignals) && queued.riskSignals.length > 0, queued?.riskSignals);
  console.log(`    (score ${queued?.riskScore}, signals: ${(queued?.riskSignals ?? []).map(s => s.pattern).join(' | ')})`);

  const anonQueued = await prisma.moderationQueueItem.findFirst({ where: { targetId: anonId, type: 'ANONYMOUS_POST' } });
  check('anonymous post queued for approval', !!anonQueued, anonQueued);

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  const ids = [alice.id, bob.id, carol.id];
  await prisma.moderationQueueItem.deleteMany({ where: { subjectUserId: { in: ids } } });
  await prisma.report.deleteMany({ where: { OR: [{ reporterId: { in: ids } }, { targetUserId: { in: ids } }] } });
  await prisma.activityEvent.deleteMany({ where: { userId: { in: ids } } });
  await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  console.log('  removed 3 test users and their content');

  console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
  await prisma.$disconnect(); await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.error(e); await prisma.$disconnect().catch(()=>{}); await pool.end().catch(()=>{}); process.exit(1); });
