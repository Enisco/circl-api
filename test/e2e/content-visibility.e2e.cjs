/* §6.5 Read-path visibility: what happens to content that a scan has held or limited.
 *
 * The safety pipeline that *sets* these states arrives next. This suite is about the half that has
 * to be in place first and is much easier to get wrong: eleven surfaces that must stop showing a
 * held post, and one that forgets. Nothing fails when a surface forgets — the post simply stays
 * up — so each one is asserted here by hand, with the state written straight into the column the
 * scanner will write.
 *
 * Two states, two different rules, and the difference is the point:
 *
 *   LIMITED — out of feeds, search, recommendations and counts; still on its author's profile and
 *             still there for anybody who follows a link to it.
 *   HELD    — nobody's but its author's. A direct read by anybody else is a 404, not a 403.
 */
const { api, check, dobFor, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');

/** Writes the state a scan would write, directly: nothing in the app sets these yet. */
const setState = (table, id, state) =>
  prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET "visibility_state" = $1::"ContentVisibilityState" WHERE "id" = $2`,
    state,
    id,
  );

const ids = (res, path = 'data') =>
  ((path === 'data' ? res.body?.data : res.body?.data?.[path]) ?? []).map(row => row.id);

(async () => {
  await sweep('pre-run');

  const author = await makeUser('vis-author', { cityId: 'BRISTOL' });
  const other = await makeUser('vis-other', { cityId: 'BRISTOL' });
  // A third member who joins nothing, for the checks about non-members.
  const seeker0 = await makeUser('vis-outsider', { cityId: 'BRISTOL' });

  console.log('\n── A held request ───────────────────────────────────────────');

  let res = await api(author.token, 'POST', '/community/requests', {
    title: 'E2E held request about a tenancy deposit',
    description: 'Seeded by content-visibility.e2e.cjs',
    categoryCode: 'ACCOMMODATION',
    cityId: 'BRISTOL',
  });
  check('a request is posted', res.status === 201, res.body?.error);

  const held = res.body?.data?.id;

  res = await api(author.token, 'POST', '/community/requests', {
    title: 'E2E limited request about a tenancy deposit',
    description: 'Seeded by content-visibility.e2e.cjs',
    categoryCode: 'ACCOMMODATION',
    cityId: 'BRISTOL',
  });

  check('a second one is posted', res.status === 201, res.body?.error);

  const limited = res.body?.data?.id;

  res = await api(author.token, 'POST', '/community/requests', {
    title: 'E2E visible request about a tenancy deposit',
    description: 'Seeded by content-visibility.e2e.cjs',
    categoryCode: 'ACCOMMODATION',
    cityId: 'BRISTOL',
  });

  check('and a third, which stays visible', res.status === 201, res.body?.error);

  const visible = res.body?.data?.id;

  await setState('community_requests', held, 'HELD');
  await setState('community_requests', limited, 'LIMITED');

  res = await api(other.token, 'GET', '/community/requests?cityId=BRISTOL&limit=50');
  check('the request list answers', res.status === 200, [res.status, res.body?.error]);
  check(
    'the list drops both the held and the limited one',
    !ids(res).includes(held) && !ids(res).includes(limited),
    { held, limited, listed: ids(res).length },
  );
  check('and keeps the visible one', ids(res).includes(visible), ids(res));

  res = await api(other.token, 'GET', '/community/requests?cityId=BRISTOL&limit=50');
  check(
    'the count agrees with the rows, so the pager cannot promise a page that is not there',
    res.body?.meta?.totalCount === (res.body?.data ?? []).length,
    [res.body?.meta?.totalCount, (res.body?.data ?? []).length],
  );

  res = await api(other.token, 'GET', `/community/requests/${held}`);
  check('a held request is a 404 to anybody else', res.status === 404, res.status);

  res = await api(author.token, 'GET', `/community/requests/${held}`);
  check('and still readable by its author', res.status === 200, res.body?.error);

  res = await api(other.token, 'GET', `/community/requests/${limited}`);
  check(
    'while a limited one is still there for anybody who follows the link',
    res.status === 200,
    res.body?.error,
  );

  console.log('\n── The feed and the search ──────────────────────────────────');

  res = await api(other.token, 'GET', '/community/feed?cityId=BRISTOL&limit=50');
  const feedIds = (res.body?.data ?? []).map(row => row.id ?? row.item?.id);

  check(
    'the feed carries neither',
    !feedIds.includes(held) && !feedIds.includes(limited),
    feedIds.slice(0, 5),
  );

  res = await api(other.token, 'GET', '/search?q=tenancy%20deposit&types=REQUEST');
  const found = (res.body?.data?.groups ?? []).flatMap(group =>
    (group.items ?? []).map(item => item.id),
  );

  check('nor does search', !found.includes(held) && !found.includes(limited), found);
  check('which still finds the visible one', found.includes(visible), found);

  console.log('\n── A held reply is not shown, even to the thread’s owner ────');

  res = await api(other.token, 'POST', `/community/requests/${visible}/responses`, {
    content: 'E2E reply that will be held',
    isHelpOffer: true,
  });
  check('a reply is posted', res.status === 201, res.body?.error);

  // `create` answers with the reply **and** the parent's new counts, so the id is one level in.
  const reply = res.body?.data?.response?.id;

  await setState('request_responses', reply, 'HELD');

  res = await api(author.token, 'GET', `/community/requests/${visible}/responses`);
  check('the request owner does not see the held reply', !ids(res).includes(reply), ids(res));

  res = await api(other.token, 'GET', `/community/requests/${visible}/responses`);
  check('its own author still does', ids(res).includes(reply), ids(res));

  console.log('\n── The ways in have to ask the same question ────────────────');

  // Every surface that serves a thread, not only the one that serves the item: before these,
  // a held request's replies and a held post's replies were readable one route along from a 404.
  res = await api(other.token, 'GET', `/community/requests/${held}/responses`);
  check('a held request does not serve its replies', res.status === 404, res.status);

  res = await api(author.token, 'GET', `/community/requests/${held}/responses`);
  check('though its author still reads them', res.status === 200, res.body?.error);

  res = await api(other.token, 'POST', `/community/requests/${held}/responses`, {
    content: 'E2E reply to a held request, which should not be possible',
  });
  check('and nobody can reply into it', res.status === 404, res.status);

  console.log('\n── A held group, and a held post inside a visible one ───────');

  res = await api(author.token, 'POST', '/community/groups', {
    name: `E2E held group ${Date.now()}`,
    description: 'Seeded by content-visibility.e2e.cjs',
    cityId: 'BRISTOL',
    joinPolicy: 'OPEN',
  });
  check('a group is created', res.status === 201, res.body?.error);

  const group = res.body?.data?.id;

  res = await api(author.token, 'POST', '/community/groups', {
    name: `E2E visible group ${Date.now()}`,
    description: 'Seeded by content-visibility.e2e.cjs',
    cityId: 'BRISTOL',
    joinPolicy: 'OPEN',
  });

  check('and a second group, which stays visible', res.status === 201, res.body?.error);

  const openGroup = res.body?.data?.id;

  res = await api(author.token, 'POST', `/community/groups/${openGroup}/posts`, {
    content: 'E2E group post that will be held',
  });
  check('a post is written in it', res.status === 201, res.body?.error);

  const groupPost = res.body?.data?.id;

  await setState('groups', group, 'HELD');
  await setState('group_posts', groupPost, 'HELD');

  res = await api(other.token, 'GET', '/community/groups?cityId=BRISTOL&limit=50');
  check('a held group is not browsable', !ids(res).includes(group), ids(res));

  res = await api(other.token, 'GET', `/community/groups/${group}`);
  check('and is a 404 to a non-member', res.status === 404, res.status);

  res = await api(author.token, 'GET', `/community/groups/${group}`);
  check(
    'while its members are not locked out of their own group by a scanner',
    res.status === 200,
    res.body?.error,
  );

  res = await api(other.token, 'POST', `/community/groups/${openGroup}/join`, {});
  res = await api(other.token, 'GET', `/community/groups/${openGroup}/posts`);
  check('a held post is off the wall', !ids(res).includes(groupPost), ids(res));

  res = await api(author.token, 'GET', `/community/groups/${openGroup}/posts`);
  check('but its author still sees it there', ids(res).includes(groupPost), ids(res));

  res = await api(seeker0.token, 'GET', `/community/groups/${group}/posts`);
  check('a held group does not serve its wall to a non-member', res.status === 404, res.status);

  res = await api(seeker0.token, 'POST', `/community/groups/${group}/join`, {});
  check('and nobody can join what they cannot see', res.status === 404, res.status);

  res = await api(author.token, 'GET', `/community/groups/${group}/posts`);
  check('while a member still reads their own group', res.status === 200, res.body?.error);

  console.log('\n── A held update, a held guide, a held offer ────────────────');

  res = await api(author.token, 'POST', '/community/updates', {
    content: 'E2E update that will be held',
    cityId: 'BRISTOL',
  });

  check('an update is posted', res.status === 201, res.body?.error);

  const update = res.body?.data?.id;

  res = await api(author.token, 'POST', '/community/offers', {
    title: 'E2E offer that will be held',
    description: 'Seeded by content-visibility.e2e.cjs',
    categoryCode: 'ACCOMMODATION',
    cityId: 'BRISTOL',
  });

  check('an offer is posted', res.status === 201, res.body?.error);

  const offer = res.body?.data?.id;

  res = await api(author.token, 'POST', '/community/guides', {
    topicCode: 'HOUSING',
    title: 'E2E guide that will be held about a tenancy deposit',
    intro: 'Seeded by content-visibility.e2e.cjs, long enough to pass the minimum length.',
    steps: [
      'A step long enough to be a step, which the validator insists on.',
      'A second step, for the same reason.',
    ],
    cityId: 'BRISTOL',
  });
  check('a guide is published', res.status === 201, res.body?.error);

  const guide = res.body?.data?.id;

  await setState('community_updates', update, 'HELD');
  await setState('community_offers', offer, 'HELD');
  await setState('guides', guide, 'HELD');

  for (const [label, path, id] of [
    ['updates', '/community/updates?cityId=BRISTOL&limit=50', update],
    ['offers', '/community/offers?cityId=BRISTOL&limit=50', offer],
    ['guides', '/community/guides?limit=50', guide],
  ]) {
    res = await api(other.token, 'GET', path);
    check(`the ${label} list drops a held one`, !ids(res).includes(id), ids(res).length);
  }

  res = await api(other.token, 'GET', `/community/updates/${update}/replies`);
  check('a held post does not serve its replies', res.status === 404, res.status);

  res = await api(author.token, 'GET', `/community/updates/${update}/replies`);
  check('though its author still reads them', res.status === 200, res.body?.error);

  for (const [label, path] of [
    ['update', `/community/updates/${update}`],
    ['offer', `/community/offers/${offer}`],
    ['guide', `/community/guides/${guide}`],
  ]) {
    res = await api(other.token, 'GET', path);
    check(`a held ${label} is a 404 to anybody else`, res.status === 404, res.status);

    res = await api(author.token, 'GET', path);
    check(`and still its author's to read`, res.status === 200, res.body?.error);
  }

  console.log('\n── Deflection must not suggest a held guide ─────────────────');

  res = await api(other.token, 'POST', '/community/guides/match', {
    title: 'E2E guide that will be held',
    categoryCode: 'ACCOMMODATION',
    cityId: 'BRISTOL',
  });
  check('guide matching answers', res.status === 200 || res.status === 201, res.body?.error);
  check(
    'and does not offer the held guide, which would publish it to the one member most likely to read it',
    !JSON.stringify(res.body?.data ?? {}).includes(guide),
    res.body?.data,
  );

  console.log('\n── A held listing is not in the directory, and not bookable ─');

  const pro = await makeUser('vis-pro', { cityId: 'BRISTOL' });

  res = await api(pro.token, 'POST', '/professionals/listings', {
    // Ungated on purpose (§2.9). This block is about a **safety** hold, and it needs the listing
    // to be visible first: a gated profession would be held pending approval before the scanner
    // ever got a say, and "not in the directory" would pass for the wrong reason.
    categoryCodes: ['BUSINESS_CONSULTING'],
    professionTitle: 'Immigration adviser',
    experienceLevel: 'EXPERT',
    about: 'Seeded by content-visibility.e2e.cjs, long enough to pass the minimum length.',
    consentAccepted: true,
  });
  check('a listing is created', res.status === 201, res.body?.error);

  const listing = res.body?.data?.listing?.id;

  // Narrowed by `q`: the directory pages out from the searched city into the nearest ones, so a
  // fresh listing in an empty city is not on page one of anything.
  res = await api(other.token, 'GET', '/professionals?q=Immigration%20adviser&limit=50');
  check('it is in the directory while it is visible', ids(res).includes(listing), [
    listing,
    ids(res).length,
  ]);

  await setState('professional_listings', listing, 'HELD');

  res = await api(other.token, 'GET', '/professionals?q=Immigration%20adviser&limit=50');
  check('and out of it once held', !ids(res).includes(listing), ids(res));

  res = await api(other.token, 'GET', `/professionals/${listing}`);
  check('the profile is a 404 to anybody else', res.status === 404, res.status);

  res = await api(pro.token, 'GET', `/professionals/${listing}`);
  check('and still theirs to see', res.status === 200, res.body?.error);

  res = await api(other.token, 'GET', `/professionals/listings/${listing}/slots`);
  check('a listing nobody may see offers no slots', res.status === 404, [
    res.status,
    res.body?.error?.code,
  ]);

  res = await api(other.token, 'POST', '/bookings', { listingId: listing });
  check(
    'and cannot be booked: a listing under review is not open for business',
    res.status === 404,
    [res.status, res.body?.error?.code],
  );

  console.log('\n── A held shop, and a held item in a visible shop ───────────');

  const seller = await makeUser('vis-seller', { cityId: 'BRISTOL' });

  res = await api(seller.token, 'POST', '/commerce/stores', {
    name: `E2E held shop ${Date.now()}`,
    area: 'Bedminster',
    description: 'Seeded by content-visibility.e2e.cjs',
  });
  check('a shop is created', res.status === 201, res.body?.error);

  const shop = res.body?.data?.id;

  res = await api(seller.token, 'POST', `/commerce/stores/${shop}/items`, {
    name: 'E2E item that will be held',
    price: 650,
    categoryCode: 'FOOD_GROCERIES',
  });
  check('an item is listed', res.status === 201, res.body?.error);

  const itemHeld = res.body?.data?.id;

  res = await api(seller.token, 'POST', `/commerce/stores/${shop}/items`, {
    name: 'E2E item that stays visible',
    price: 450,
    categoryCode: 'FOOD_GROCERIES',
  });

  const itemVisible = res.body?.data?.id;

  await setState('store_items', itemHeld, 'HELD');

  res = await api(other.token, 'GET', `/commerce/stores/${shop}/items`);
  check('the held item is off the shelf', !ids(res).includes(itemHeld), ids(res));
  check('and the other one is not', ids(res).includes(itemVisible), ids(res));

  res = await api(seller.token, 'GET', `/commerce/stores/${shop}/items`);
  check('the shopkeeper still sees their whole catalogue', ids(res).includes(itemHeld), ids(res));

  res = await api(other.token, 'GET', `/commerce/items/${itemHeld}`);
  check('a held item is a 404 to a shopper', res.status === 404, res.status);

  res = await api(seller.token, 'GET', `/commerce/items/${itemHeld}`);
  check('and still theirs to see', res.status === 200, res.body?.error);

  res = await api(other.token, 'POST', '/commerce/carts/validate', {
    lines: [{ itemId: itemHeld, quantity: 1 }],
  });
  check(
    'a cart holding one says so rather than pricing it',
    res.status === 200 &&
      res.body?.data?.hasIssues === true &&
      (res.body?.data?.lines ?? []).every(line => line.status === 'REMOVED'),
    res.body?.data,
  );

  await setState('stores', shop, 'HELD');

  res = await api(other.token, 'GET', '/commerce/stores?cityId=BRISTOL&limit=50');
  check('a held shop is out of browse', !ids(res).includes(shop), ids(res));

  res = await api(other.token, 'GET', `/commerce/stores/${shop}`);
  check('its page is a 404 to a shopper', res.status === 404, res.status);

  res = await api(seller.token, 'GET', `/commerce/stores/${shop}`);
  check('and still theirs to open', res.status === 200, res.body?.error);

  // The shelves are one route along from the page. Before this check they kept serving a held
  // shop's catalogue while its own page answered 404 — eleven surfaces and one that forgets.
  res = await api(other.token, 'GET', `/commerce/stores/${shop}/items`);
  check('a held shop takes its whole catalogue with it', res.status === 404, res.status);

  res = await api(seller.token, 'GET', `/commerce/stores/${shop}/items`);
  check('which the shopkeeper can still read', res.status === 200, res.body?.error);

  res = await api(other.token, 'POST', '/commerce/enquiries', {
    storeId: shop,
    lines: [{ itemId: itemVisible, quantity: 1 }],
    fulfilment: 'COLLECTION',
  });
  check('and it cannot take an order: a shop under review is not trading', res.status === 404, [
    res.status,
    res.body?.error?.code,
  ]);

  console.log('\n── A held Connect profile ──────────────────────────────────');

  const seeker = await makeUser('vis-seeker', { cityId: 'BRISTOL' });

  for (const member of [other, seeker]) {
    res = await api(member.token, 'PUT', '/connect/me', {
      typeCode: 'FRIENDSHIP',
      lookingFor: 'Seeded by content-visibility.e2e.cjs, meeting people in Bristol.',
      dateOfBirth: dobFor(28),
      isVisible: true,
    });
    check('a Connect profile is set up', res.status === 200 || res.status === 201, res.body?.error);
  }

  res = await api(seeker.token, 'GET', '/connect/profiles?limit=50');
  const grid = (res.body?.data ?? []).map(row => row.userId ?? row.id);

  check('both profiles are in discovery', grid.length > 0, grid.length);

  const theirProfile = await prisma.connectProfile.findFirst({
    where: { userId: other.id },
    select: { id: true },
  });

  await setState('connect_profiles', theirProfile.id, 'HELD');

  res = await api(seeker.token, 'GET', '/connect/profiles?limit=50');
  check(
    'a held profile is out of the grid',
    !(res.body?.data ?? []).some(row => row.id === theirProfile.id || row.userId === other.id),
    res.body?.data?.length,
  );

  res = await api(seeker.token, 'GET', `/connect/profiles/${theirProfile.id}`);
  check(
    'and reads as a 404 — the same answer a hidden profile gives, for the same reason',
    res.status === 404,
    res.status,
  );

  await sweep('content-visibility');
  await finish();
})().catch(async error => {
  await fail(error);
});
