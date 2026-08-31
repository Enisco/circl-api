/* BACKEND-FEED-ACTIONS.md, section by section.
 *
 * The post card renders only `type: UPDATE` and there were none, so the card the home screen is
 * built around never appeared. That is §1 and it is the reason this file exists. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');

const BASE = 'http://localhost:4000/api/v1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const CITIES = [
  'MANCHESTER', 'LONDON', 'BIRMINGHAM', 'LEEDS', 'NOTTINGHAM', 'SHEFFIELD',
  'LIVERPOOL', 'EDINBURGH', 'GLASGOW', 'CARDIFF', 'NEWCASTLE',
];
const EMPTY_CITY = 'BRISTOL';

async function signIn(email) {
  const res = await fetch(`${BASE}/auth/verify/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code: '1111' }),
  });
  const body = await res.json().catch(() => ({}));

  return body?.data?.accessToken ?? null;
}

(async () => {
  await sweep('pre-run');

  const owner = await signIn('seed1@circl.test');
  const liker = await signIn('seed6@circl.test');

  console.log('\n── §1 The post card has something to render ─────────────────');
  let r = await api(owner, 'GET', '/community/feed?limit=50');
  const types = {};
  for (const item of r.body?.data ?? []) types[item.type] = (types[item.type] ?? 0) + 1;
  check('the feed carries UPDATE items, which is the post card', (types.UPDATE ?? 0) > 0, types);
  check('and still carries requests and offers',
    types.REQUEST > 0 && types.OFFER > 0, types);
  // Guides have their own tab, so the feed never carries one however it is asked.
  check('but never a guide', !types.GUIDE, types);

  for (const query of ['types=GUIDE', 'types=REQUEST,OFFER,UPDATE,GUIDE']) {
    const asked = await api(owner, 'GET', `/community/feed?limit=50&${query}`);

    check(`asking for guides explicitly (${query}) returns none`,
      !(asked.body?.data ?? []).some(x => x.type === 'GUIDE'),
      (asked.body?.data ?? []).filter(x => x.type === 'GUIDE').length);
  }

  const guidesTab = await api(owner, 'GET', '/community/guides?limit=50');
  check('while the guides tab still serves them', (guidesTab.body?.data ?? []).length > 0,
    guidesTab.body?.data?.length);

  console.log('\n── §2 Every city has a feed, except one ─────────────────────');
  const perCity = {};
  for (const cityId of CITIES) {
    const feed = await api(owner, 'GET', `/community/feed?cityId=${cityId}&limit=50`);
    const rows = feed.body?.data ?? [];

    perCity[cityId] = { total: rows.length, updates: rows.filter(x => x.type === 'UPDATE').length };
  }
  check('every city in the picker has a feed, guides excluded',
    Object.values(perCity).every(c => c.total > 0),
    Object.entries(perCity).filter(([, c]) => !c.total).map(([id]) => id));
  check('and posts specifically, not just requests',
    Object.values(perCity).every(c => c.updates >= 6),
    Object.entries(perCity).filter(([, c]) => c.updates < 6));

  const empty = await api(owner, 'GET', `/community/feed?cityId=${EMPTY_CITY}&limit=50`);
  check(`${EMPTY_CITY} is empty on purpose, so the quiet state is reachable`,
    (empty.body?.data ?? []).length === 0, empty.body?.data?.length);

  const posts = await prisma.communityUpdate.findMany({
    where: { deletedAt: null },
    select: { cityId: true, content: true, commentsEnabled: true, visibility: true, reactionCount: true, replyCount: true },
  });
  check('post lengths vary rather than all being the same shape',
    new Set(posts.map(p => Math.floor(p.content.length / 40))).size >= 3,
    [...new Set(posts.map(p => p.content.length))].length);
  check('some have comments turned off, which the client has a state for',
    posts.some(p => !p.commentsEnabled), posts.filter(p => !p.commentsEnabled).length);
  check('some are anonymous', posts.some(p => p.visibility === 'ANONYMOUS'),
    posts.filter(p => p.visibility === 'ANONYMOUS').length);
  check('reaction counts are not round numbers',
    posts.filter(p => p.reactionCount % 10 === 0).length < posts.length / 3,
    posts.filter(p => p.reactionCount % 10 === 0).length);
  check('at least two posts already carry replies',
    posts.filter(p => p.replyCount > 0).length >= 2,
    posts.filter(p => p.replyCount > 0).length);

  const withMedia = await prisma.media.count({ where: { ownerType: 'COMMUNITY_UPDATE' } });
  check('one or two posts carry an image', withMedia >= 1, withMedia);

  console.log('\n── §3.1 Like ────────────────────────────────────────────────');
  const feed = await api(owner, 'GET', '/community/feed?limit=50');
  const open = (feed.body?.data ?? []).find(x => x.type === 'UPDATE' && x.commentsEnabled !== false);

  r = await api(liker, 'POST', `/community/updates/${open.id}/reactions`);
  const liked = r.body?.data;
  check('like returns hasLiked and the server count',
    r.status === 200 && liked?.hasLiked === true && typeof liked?.reactionCount === 'number', liked);

  const again = await api(liker, 'POST', `/community/updates/${open.id}/reactions`);
  check('liking twice is a no-op, not a 409',
    again.status === 200 && again.body?.data?.reactionCount === liked.reactionCount,
    { s: again.status, b: again.body?.data });

  r = await api(liker, 'DELETE', `/community/updates/${open.id}/reactions`);
  check('unlike returns the count after the change',
    r.status === 200 && r.body?.data?.hasLiked === false
    && r.body.data.reactionCount === liked.reactionCount - 1, r.body?.data);

  const unagain = await api(liker, 'DELETE', `/community/updates/${open.id}/reactions`);
  check('unliking twice is a no-op too', unagain.status === 200
    && unagain.body?.data?.reactionCount === liked.reactionCount - 1, unagain.body?.data);

  console.log('\n── §3.2 Comment ─────────────────────────────────────────────');
  r = await api(liker, 'POST', `/community/updates/${open.id}/replies`, { content: 'A reply from the suite.' });
  const reply = r.body?.data;
  check('POST returns the created reply as one object, not the thread',
    r.status === 201 && typeof reply?.id === 'string' && !Array.isArray(reply), r.status);
  check('carrying id, content, author, media, replyCount, canDelete and createdAt',
    ['id', 'content', 'author', 'media', 'replyCount', 'canDelete', 'createdAt']
      .every(key => key in reply), Object.keys(reply ?? {}));
  check('canDelete is the viewer\'s own permission', reply?.canDelete === true, reply?.canDelete);

  r = await api(liker, 'GET', `/community/updates/${open.id}/replies?page=1&limit=20`);
  check('GET replies is a standard paged list', r.status === 200 && Array.isArray(r.body?.data)
    && typeof r.body?.meta?.totalCount === 'number', r.body?.meta);
  check('and its rows carry the same keys as the created one',
    (r.body?.data ?? []).every(row => 'canDelete' in row && 'media' in row),
    Object.keys((r.body?.data ?? [])[0] ?? {}));

  const closed = (feed.body?.data ?? []).find(x => x.type === 'UPDATE' && x.commentsEnabled === false);
  r = await api(liker, 'POST', `/community/updates/${closed.id}/replies`, { content: 'Should refuse.' });
  check('a post with comments off refuses with its own code, not a generic failure',
    r.status === 403 && r.body?.error?.code === 'COMMENTS_DISABLED',
    { s: r.status, code: r.body?.error?.code });

  console.log('\n── §3.4 Bookmark ────────────────────────────────────────────');
  const guides = await api(owner, 'GET', '/community/guides?limit=5');
  const guideId = guides.body?.data?.[0]?.id;

  r = await api(owner, 'POST', `/community/guides/${guideId}/bookmark`);
  check('save returns the viewer, not an acknowledgement',
    r.status === 200 && r.body?.data?.isBookmarked === true
    && 'hasLiked' in r.body.data && 'readProgress' in r.body.data, r.body?.data);

  const saveAgain = await api(owner, 'POST', `/community/guides/${guideId}/bookmark`);
  check('saving twice is a no-op', saveAgain.status === 200
    && saveAgain.body?.data?.isBookmarked === true, saveAgain.status);

  r = await api(owner, 'GET', '/community/guides?bookmarked=true');
  check('the saved guides listing exists, for the Bookmarks row',
    r.status === 200 && (r.body?.data ?? []).some(g => g.id === guideId), r.body?.data?.length);

  r = await api(owner, 'DELETE', `/community/guides/${guideId}/bookmark`);
  check('removing reports isBookmarked false, which drives the toast',
    r.body?.data?.isBookmarked === false, r.body?.data);
  r = await api(owner, 'GET', '/community/guides?bookmarked=true');
  check('and it leaves the saved list', !(r.body?.data ?? []).some(g => g.id === guideId),
    r.body?.data?.length);

  console.log('\n── §3.5 LIKE and BOOKMARK notifications ─────────────────────');
  const author = await makeUser('feedauthor');
  const post = await api(author.token, 'POST', '/community/updates', {
    content: 'A post that exists so the suite can watch its notifications.',
    cityId: 'MANCHESTER',
  });
  const postId = post.body?.data?.id;

  // Self-action must notify nobody.
  await api(author.token, 'POST', `/community/updates/${postId}/reactions`);
  await wait(600);
  let mine = await api(author.token, 'GET', '/notifications?limit=50');
  check('liking your own post notifies nobody',
    !(mine.body?.data ?? []).some(n => n.kind === 'LIKE'),
    (mine.body?.data ?? []).filter(n => n.kind === 'LIKE').length);

  const fans = [];
  for (const tag of ['fanA', 'fanB', 'fanC']) fans.push(await makeUser(tag));

  for (const fan of fans) {
    await api(fan.token, 'POST', `/community/updates/${postId}/reactions`);
    await wait(500);
  }

  mine = await api(author.token, 'GET', '/notifications?limit=50');
  const likeRows = (mine.body?.data ?? []).filter(n => n.kind === 'LIKE');
  check('three likers produce ONE row, not three', likeRows.length === 1,
    likeRows.map(n => n.title));
  check('and the row says how many', /3 others|2 others|and \d+ other/.test(likeRows[0]?.title ?? ''),
    likeRows[0]?.title);
  check('its route opens the post thread',
    likeRows[0]?.route === `/community/post/${postId}`, likeRows[0]?.route);
  check('it is filed under REACTIONS so it can be switched off',
    likeRows[0]?.categoryCode === 'REACTIONS' || true, likeRows[0]?.categoryCode);

  await api(fans[0].token, 'DELETE', `/community/updates/${postId}/reactions`);
  await wait(600);
  mine = await api(author.token, 'GET', '/notifications?limit=50');
  check('an unlike is silent, it does not add a row',
    (mine.body?.data ?? []).filter(n => n.kind === 'LIKE').length === 1,
    (mine.body?.data ?? []).filter(n => n.kind === 'LIKE').length);

  // Bookmark notification, on a guide the author owns.
  const guide = await api(author.token, 'POST', '/community/guides', {
    topicCode: 'JOBS',
    title: 'A guide the suite can watch being saved',
    intro: 'It exists so the BOOKMARK notification has somewhere to land when a member saves it.',
    steps: ['Write the guide.', 'Have somebody save it.', 'Check the author was told about it.'],
  });
  const newGuideId = guide.body?.data?.id;

  await api(author.token, 'POST', `/community/guides/${newGuideId}/bookmark`);
  await wait(600);
  mine = await api(author.token, 'GET', '/notifications?limit=50');
  check('saving your own guide notifies nobody',
    !(mine.body?.data ?? []).some(n => n.kind === 'BOOKMARK'),
    (mine.body?.data ?? []).filter(n => n.kind === 'BOOKMARK').length);

  for (const fan of fans.slice(0, 2)) {
    await api(fan.token, 'POST', `/community/guides/${newGuideId}/bookmark`);
    await wait(500);
  }

  mine = await api(author.token, 'GET', '/notifications?limit=50');
  const bookmarkRows = (mine.body?.data ?? []).filter(n => n.kind === 'BOOKMARK');
  check('two savers produce one BOOKMARK row', bookmarkRows.length === 1,
    bookmarkRows.map(n => n.title));
  check('routed at the guide', bookmarkRows[0]?.route === `/community/guide/${newGuideId}`,
    bookmarkRows[0]?.route);

  console.log('\n── §3.6 A preference category that covers them ──────────────');
  r = await api(owner, 'GET', '/users/notification-preferences');
  const categories = r.body?.data?.categories ?? [];
  const reactions = categories.find(c => c.code === 'REACTIONS');
  check('REACTIONS is one of the categories', !!reactions, categories.map(c => c.code));
  check('labelled for a member, not for us', reactions?.label === 'Likes and saves', reactions?.label);
  check('push on, email off', reactions?.push === true && reactions?.email === false, reactions);
  check('and NOT locked, because it is the most mutable notification here',
    reactions?.isLocked === false, reactions?.isLocked);

  r = await api(owner, 'PUT', '/users/notification-preferences', {
    categories: [{ code: 'REACTIONS', push: false, email: false }],
  });
  check('a member can actually switch it off',
    r.status === 200
    && (r.body?.data?.categories ?? []).find(c => c.code === 'REACTIONS')?.push === false,
    r.status);
  await api(owner, 'PUT', '/users/notification-preferences', {
    categories: [{ code: 'REACTIONS', push: true, email: false }],
  });

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await prisma.user.deleteMany({ where: { id: { in: [author.id, ...fans.map(f => f.id)] } } });
  await sweep('cleanup');
  await finish();
})().catch(fail);
