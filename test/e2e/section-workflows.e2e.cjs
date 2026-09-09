/* BACKEND-SECTION-WORKFLOWS.md, section by section.
 *
 * Booking is gone from the app, so a thread is now the whole relationship. That only works if a
 * thread files under the right section and can carry a review, neither of which it did. */
const { api, check, dobFor, finish, makeUser, prisma, sweep } = require('./harness.cjs');

(async () => {
  await sweep('section-workflows');

  const pro = await makeUser('swpro', { bio: 'Nine years in UK immigration law.' });
  const client = await makeUser('swclient');
  const shopkeeper = await makeUser('swshop');

  let r = await api(pro.token, 'POST', '/professionals/listings', {
    categoryCodes: ['IMMIGRATION'],
    professionTitle: 'Immigration Adviser',
    experienceLevel: 'EXPERT',
    about: 'I specialise in UK immigration law and have done for nine years now.',
    consentAccepted: true,
  });
  const listingId = r.body?.data?.listing?.id ?? r.body?.data?.id;
  check('listing created', r.status === 201 && !!listingId, r.body?.error);

  console.log('\n── 2.1 A thread about a professional listing ────────────────');

  r = await api(client.token, 'POST', '/messages', { context: { kind: 'PROFESSIONAL', id: listingId } });
  const conversationId = r.body?.data?.id ?? r.body?.data?.conversation?.id;
  check('starts with no recipientUserId: a listing has one owner', r.status === 201, r.body?.error);
  check('kind is PROFESSIONAL, so the section filter has something to filter on', r.body?.data?.kind === 'PROFESSIONAL', r.body?.data?.kind);
  check('the strip carries the profession title', r.body?.data?.context?.title === 'Immigration Adviser', r.body?.data?.context);
  check('the subtitle names the professional and their city', /E2E swpro/.test(r.body?.data?.context?.subtitle ?? ''), r.body?.data?.context?.subtitle);
  check('and routes to the profile', r.body?.data?.context?.route === `/professionals/profile/${listingId}`, r.body?.data?.context?.route);

  r = await api(client.token, 'POST', '/messages', { context: { kind: 'PROFESSIONAL', id: listingId } });
  check('messaging the same professional twice is one thread, 200 not 201', r.status === 200 && (r.body?.data?.id ?? r.body?.data?.conversation?.id) === conversationId, { status: r.status });

  r = await api(client.token, 'POST', '/messages', { context: { kind: 'PROFESSIONAL', id: 'no-such-listing' } });
  check('a listing that does not exist is a 404, not an empty thread', r.status === 404, r.status);

  console.log('\n── A thread about ONE service, not the whole listing ────────');

  r = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'Appeal support', description: 'Preparing and lodging an appeal after a refusal.',
    price: 40000, priceBasis: 'PER_JOB',
  });
  const appealId = r.body?.data?.id;
  r = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'Initial consultation', description: 'An hour to look at your case and say what is possible.',
    price: 6500, priceBasis: 'PER_HOUR',
  });
  const consultId = r.body?.data?.id;
  check('two services on the listing', !!appealId && !!consultId, r.body?.error);

  r = await api(client.token, 'POST', '/messages', { context: { kind: 'SERVICE', id: appealId } });
  const appealThreadId = r.body?.data?.id;
  check('a service names its owner, so no recipientUserId', r.status === 201, r.body?.error);
  check('it files under Professionals like a listing thread', r.body?.data?.kind === 'PROFESSIONAL', r.body?.data?.kind);
  check('the strip is the service, not the profession', r.body?.data?.context?.title === 'Appeal support', r.body?.data?.context);
  check('with the professional underneath', /E2E swpro/.test(r.body?.data?.context?.subtitle ?? ''), r.body?.data?.context?.subtitle);
  check('and the price as it was listed today', r.body?.data?.context?.trailing === '£400.00', r.body?.data?.context?.trailing);
  check('the route still resolves the live listing', r.body?.data?.context?.route === `/professionals/profile/${listingId}`, r.body?.data?.context?.route);
  check('chipped as a listing thread', r.body?.data?.label === 'ABOUT_LISTING', r.body?.data?.label);

  r = await api(client.token, 'POST', '/messages', { context: { kind: 'SERVICE', id: consultId } });
  check('a second service is a second thread, as a second shop item is', r.status === 201 && r.body?.data?.id !== appealThreadId, { status: r.status });
  check('and it carries its own price', r.body?.data?.context?.trailing === '£65.00', r.body?.data?.context?.trailing);

  r = await api(client.token, 'POST', '/messages', { context: { kind: 'SERVICE', id: appealId } });
  check('the same service twice is one thread, 200 not 201', r.status === 200 && r.body?.data?.id === appealThreadId, { status: r.status });

  await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${appealId}`, {
    name: 'Appeal support', price: 55000, priceBasis: 'PER_JOB',
  });
  r = await api(client.token, 'GET', `/messages/${appealThreadId}`);
  check('raising the price later does not rewrite the thread it was agreed in', r.body?.data?.context?.trailing === '£400.00', r.body?.data?.context?.trailing);

  r = await api(client.token, 'POST', '/messages', { context: { kind: 'SERVICE', id: 'no-such-service' } });
  check('a service that does not exist is a 404', r.status === 404, r.status);

  console.log('\n── 2.2 A thread about a Connect profile ─────────────────────');

  r = await api(pro.token, 'PUT', '/connect/me', {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Practising English after work.',
    dateOfBirth: dobFor(34), isVisible: true,
  });
  const connectProfileId = r.body?.data?.id;
  check('connect profile created', r.status === 200, r.body?.error);

  r = await api(client.token, 'POST', '/messages', { context: { kind: 'CONNECT_PROFILE', id: connectProfileId } });
  const connectThreadId = r.body?.data?.id;
  check('an open inbox can be messaged from Connect', r.status === 201, r.body?.error);
  check('kind is CONNECT', r.body?.data?.kind === 'CONNECT', r.body?.data?.kind);
  check('the strip leads with the connection type and city', /Language exchange|Language Exchange/.test(r.body?.data?.context?.title ?? '') && /Manchester/.test(r.body?.data?.context?.title ?? ''), r.body?.data?.context);
  check('and carries their own words underneath', /Practising English/.test(r.body?.data?.context?.subtitle ?? ''), r.body?.data?.context);
  check('and routes to the Connect profile', r.body?.data?.context?.route === `/connect/profile/${connectProfileId}`, r.body?.data?.context?.route);

  console.log('\n── 2.3 A thread about a shop ────────────────────────────────');

  r = await api(shopkeeper.token, 'POST', '/commerce/stores', { name: 'Mama Nkechi Foods', area: 'Moss Side' });
  const storeId = r.body?.data?.id;
  check('store created', r.status === 201, r.body?.error);

  r = await api(client.token, 'POST', '/messages', { context: { kind: 'STORE', id: storeId } });
  const storeThreadId = r.body?.data?.id;
  check('messaging a shop from its profile is no longer a plain DM', r.status === 201, r.body?.error);
  check('kind is COMMERCE, so it files under the shop tab', r.body?.data?.kind === 'COMMERCE', r.body?.data?.kind);
  check('the strip is the store name', r.body?.data?.context?.title === 'Mama Nkechi Foods', r.body?.data?.context);
  check('and routes to the store', r.body?.data?.context?.route === `/commerce/store/${storeId}`, r.body?.data?.context?.route);

  console.log('\n── 3. kind is set from the context, and filters server-side ─');

  r = await api(client.token, 'POST', '/messages', { recipientUserId: shopkeeper.id });
  check('a thread about nothing in particular is still DIRECT', r.body?.data?.kind === 'DIRECT', r.body?.data?.kind);

  r = await api(client.token, 'GET', '/messages?kind=PROFESSIONAL');
  check('?kind=PROFESSIONAL returns only professional threads', (r.body?.data ?? []).every(c => c.kind === 'PROFESSIONAL'), (r.body?.data ?? []).map(c => c.kind));
  check('and finds this one', (r.body?.data ?? []).some(c => c.id === conversationId), r.body?.meta);

  r = await api(client.token, 'GET', '/messages?kind=CONNECT');
  check('?kind=CONNECT finds the Connect thread', (r.body?.data ?? []).some(c => c.id === connectThreadId), r.body?.meta);

  r = await api(client.token, 'GET', '/messages?kind=COMMERCE');
  check('?kind=COMMERCE finds the shop thread', (r.body?.data ?? []).some(c => c.id === storeThreadId), r.body?.meta);

  console.log('\n── Tapping through: the row, the room, and the way back ─────');

  r = await api(client.token, 'GET', '/messages');
  const rows = r.body?.data ?? [];
  const proRow = rows.find(c => c.id === conversationId);
  const storeRow = rows.find(c => c.id === storeThreadId);
  const connectRow = rows.find(c => c.id === connectThreadId);
  check('every context thread is in the inbox', !!proRow && !!storeRow && !!connectRow, rows.map(c => c.kind));
  check('a row carries the id the room is opened by', typeof proRow?.id === 'string', proRow?.id);
  check('and the context it is about, so the room renders its strip without a second call', !!proRow?.context?.title && !!proRow?.context?.route, proRow?.context);
  check('the shop row routes to the shop, not to an item', storeRow?.context?.route === `/commerce/store/${storeId}`, storeRow?.context?.route);
  check('and is chipped as a shop thread', storeRow?.label === 'ABOUT_SHOP', storeRow?.label);
  check('the professional row routes to the profile the doc names', proRow?.context?.route === `/professionals/profile/${listingId}`, proRow?.context?.route);

  r = await api(client.token, 'GET', `/messages/${conversationId}`);
  check('opening the room by id works', r.status === 200, r.body?.error);
  check('and the room knows its context', r.body?.data?.context?.id === listingId && r.body?.data?.kind === 'PROFESSIONAL', r.body?.data?.context);

  r = await api(client.token, 'GET', `/professionals/${listingId}`);
  check('the professional profile points back at the existing thread', r.body?.data?.viewer?.conversationId === conversationId, r.body?.data?.viewer);

  r = await api(client.token, 'GET', `/commerce/stores/${storeId}`);
  check('the shop profile points back at the shop thread, not an item one', r.body?.data?.viewer?.conversationId === storeThreadId, r.body?.data?.viewer);

  // Connect is only browsable by somebody who is on Connect themselves, so the client needs a
  // profile of their own before that screen answers at all.
  await api(client.token, 'PUT', '/connect/me', {
    typeCode: 'FRIENDSHIP', lookingFor: 'Meeting people nearby at the weekend.',
    dateOfBirth: dobFor(29), isVisible: true,
  });
  r = await api(client.token, 'GET', `/connect/profiles/${connectProfileId}`);
  check('the Connect profile points back at its thread', r.body?.data?.viewer?.conversationId === connectThreadId, { status: r.status, viewer: r.body?.data?.viewer });

  console.log('\n── 4. A review earned through the thread ────────────────────');

  const review = { subjectUserId: pro.id, context: 'PROFESSIONAL', sourceId: conversationId, rating: 5, comment: 'Sorted my visa paperwork inside a week.' };

  r = await api(client.token, 'POST', '/reviews', review);
  check('refused before anybody has spoken', r.status === 422 && r.body?.error?.code === 'REVIEW_NOT_ELIGIBLE', { status: r.status, code: r.body?.error?.code });

  await api(client.token, 'POST', `/messages/${conversationId}/messages`, { clientId: 'sw-1', body: 'Are you taking new clients this month?' });
  r = await api(client.token, 'POST', '/reviews', review);
  check('still refused when only one of them has spoken', r.status === 422, r.status);

  await api(pro.token, 'POST', `/messages/${conversationId}/messages`, { clientId: 'sw-2', body: 'I am, yes. Send the refusal letter over.' });
  r = await api(client.token, 'POST', '/reviews', review);
  check('accepted once both have', r.status === 201, r.body?.error);
  check('it counts toward the average, unlike prior work', r.body?.data?.countsToAverage === true, r.body?.data);
  check('labelled for the client rather than mapped by it', r.body?.data?.contextLabel === 'Worked together on Circl', r.body?.data?.contextLabel);

  r = await api(client.token, 'POST', '/reviews', { ...review, rating: 4, comment: 'A second go at the very same thread.' });
  check('a second review on the same thread is the existing 409', r.status === 409 && r.body?.error?.code === 'REVIEW_ALREADY_LEFT', { status: r.status, code: r.body?.error?.code });

  r = await api(pro.token, 'POST', '/reviews', { ...review, subjectUserId: client.id });
  check('the subject cannot review themselves back off the same thread', r.status === 422, { status: r.status, code: r.body?.error?.code });

  r = await api(client.token, 'GET', `/reviews/${pro.id}`);
  check('byContext carries a PROFESSIONAL count, so the chip appears', r.body?.data?.summary?.byContext?.PROFESSIONAL === 1, r.body?.data?.summary?.byContext);
  check('and it moved the average off zero', r.body?.data?.summary?.average === 5, r.body?.data?.summary);

  r = await api(client.token, 'GET', `/reviews/${pro.id}?context=PROFESSIONAL`);
  check('?context=PROFESSIONAL filters, as the other values do', (r.body?.data?.reviews ?? []).length === 1, r.body?.data?.reviews?.length);

  console.log('\n── Done is per person, and the review prompt that follows ──');

  r = await api(client.token, 'GET', `/messages/${conversationId}`);
  check('viewer.isArchived says which way the menu should read', r.body?.data?.viewer?.isArchived === false, r.body?.data?.viewer);
  check('canReview is already false on the thread reviewed above', r.body?.data?.viewer?.canReview === false, r.body?.data?.viewer);

  r = await api(client.token, 'GET', `/messages/${appealThreadId}`);
  check('a service thread with only one voice cannot be reviewed', r.body?.data?.viewer?.canReview === false, r.body?.data?.viewer);

  await api(client.token, 'POST', `/messages/${appealThreadId}/messages`, { clientId: 'sw-a1', body: 'Could you take the appeal on?' });
  await api(pro.token, 'POST', `/messages/${appealThreadId}/messages`, { clientId: 'sw-a2', body: 'Yes. Send me the refusal letter.' });
  r = await api(client.token, 'GET', `/messages/${appealThreadId}`);
  check('and can once both have written in it', r.body?.data?.viewer?.canReview === true, r.body?.data?.viewer);

  r = await api(pro.token, 'GET', `/messages/${appealThreadId}`);
  check('the professional cannot review themselves off their own thread', r.body?.data?.viewer?.canReview === false, r.body?.data?.viewer);

  r = await api(client.token, 'POST', '/reviews', {
    subjectUserId: pro.id, context: 'PROFESSIONAL', sourceId: appealThreadId,
    rating: 5, comment: 'Took the appeal on at short notice and won it.',
  });
  check('a service thread is accepted as the record a review hangs off', r.status === 201, r.body?.error);
  check('and the label names the service', r.body?.data?.contextLabel === 'Worked together on Circl · Appeal support', r.body?.data?.contextLabel);

  r = await api(client.token, 'GET', `/messages/${appealThreadId}`);
  check('canReview turns off once a review has been left', r.body?.data?.viewer?.canReview === false, r.body?.data?.viewer);

  await api(client.token, 'POST', `/messages/${appealThreadId}/archive`, {});
  r = await api(client.token, 'GET', `/messages/${appealThreadId}`);
  check('marking it done is visible to the member who did it', r.body?.data?.viewer?.isArchived === true, r.body?.data?.viewer);

  r = await api(pro.token, 'GET', `/messages/${appealThreadId}`);
  check('and to nobody else: my being finished says nothing about yours', r.body?.data?.viewer?.isArchived === false, r.body?.data?.viewer);

  r = await api(client.token, 'GET', '/messages');
  const archivedRow = (r.body?.data ?? []).find(c => c.id === appealThreadId);
  check('an archived thread leaves the inbox', archivedRow === undefined, archivedRow?.id);

  r = await api(client.token, 'GET', '/messages?archived=true');
  const doneOnly = r.body?.data ?? [];
  check('the Done chip returns the archived thread', doneOnly.some(c => c.id === appealThreadId), doneOnly.map(c => c.id));
  check('and nothing that is still open', doneOnly.every(c => c.viewer?.isArchived === true), doneOnly.map(c => c.viewer?.isArchived));
  check('so a finished thread can be found again', doneOnly.length >= 1 && !doneOnly.some(c => c.id === conversationId), doneOnly.length);

  r = await api(client.token, 'GET', '/messages?archived=true&kind=PROFESSIONAL');
  check('every other filter still applies alongside it', (r.body?.data ?? []).every(c => c.kind === 'PROFESSIONAL' && c.viewer?.isArchived === true), r.body?.data?.map(c => c.kind));

  r = await api(client.token, 'GET', '/messages?archived=false');
  check('archived=false is the inbox, same as sending nothing', (r.body?.data ?? []).every(c => c.viewer?.isArchived === false), r.body?.data?.map(c => c.viewer?.isArchived));

  r = await api(client.token, 'GET', '/messages?includeArchived=true');
  check('includeArchived still returns both, unchanged', (r.body?.data ?? []).some(c => c.id === appealThreadId) && (r.body?.data ?? []).some(c => c.id === conversationId), r.body?.meta);

  r = await api(pro.token, 'GET', '/professionals/home');
  check('the professional\'s own done count is theirs alone', r.body?.data?.myWork?.done === 0, r.body?.data?.myWork);

  await api(pro.token, 'POST', `/messages/${appealThreadId}/archive`, {});
  r = await api(pro.token, 'GET', '/professionals/home');
  check('and moves when they mark it done themselves', r.body?.data?.myWork?.done === 1, r.body?.data?.myWork);
  check('which takes it out of openThreads', r.body?.data?.myWork?.openThreads === 2, r.body?.data?.myWork);
  await api(pro.token, 'DELETE', `/messages/${appealThreadId}/archive`);

  await api(client.token, 'DELETE', `/messages/${appealThreadId}/archive`);
  r = await api(client.token, 'GET', `/messages/${appealThreadId}`);
  check('moving it back to the inbox undoes it', r.body?.data?.viewer?.isArchived === false, r.body?.data?.viewer);

  r = await api(client.token, 'GET', '/messages?archived=true');
  check('and it leaves the Done list', !(r.body?.data ?? []).some(c => c.id === appealThreadId), r.body?.data?.map(c => c.id));

  console.log('\n── 5.1 The work waiting on a professional ───────────────────');

  r = await api(pro.token, 'GET', '/professionals/home');
  check('myWork is present for somebody with a listing', !!r.body?.data?.myWork, r.body?.data?.myWork);
  check('openThreads counts service threads as their work too', r.body?.data?.myWork?.openThreads === 3, r.body?.data?.myWork);
  // Two of the three have an unread message in them; the consultation thread has no messages at all.
  check('an unread message counts as waiting, even though they replied', r.body?.data?.myWork?.awaitingReply === 2, r.body?.data?.myWork);

  await api(pro.token, 'POST', `/messages/${conversationId}/read`, {});
  await api(pro.token, 'POST', `/messages/${appealThreadId}/read`, {});
  r = await api(pro.token, 'GET', '/professionals/home');
  check('and stops once they have read them and answered last', r.body?.data?.myWork?.awaitingReply === 0, r.body?.data?.myWork);

  await api(client.token, 'POST', `/messages/${conversationId}/messages`, { clientId: 'sw-3', body: 'One more question before I send it.' });
  r = await api(pro.token, 'GET', '/professionals/home');
  check('the client speaking again puts it back', r.body?.data?.myWork?.awaitingReply === 1, r.body?.data?.myWork);

  r = await api(client.token, 'GET', '/professionals/home');
  check('omitted for a member with no listing', r.body?.data?.myWork === undefined, r.body?.data?.myWork);

  console.log('\n── 5.3 nearYou is city-only, and may be empty ───────────────');

  const elsewhere = await makeUser('swfar', { cityId: 'TRURO' });
  r = await api(elsewhere.token, 'GET', '/professionals/home');
  check('a city with nobody in it returns an empty rail, not a padded one', (r.body?.data?.nearYou ?? []).every(p => p.city?.id === 'TRURO'), (r.body?.data?.nearYou ?? []).map(p => p.city?.id));

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await sweep('section-workflows');
  await finish();
})();
