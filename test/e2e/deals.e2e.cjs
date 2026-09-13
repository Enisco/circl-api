/* BACKEND-DEAL-PROGRESS.md.
 *
 * Circl takes no payment and cannot verify that any money moved, so the whole feature is a shared
 * record between two people. Every check below is about keeping that record honest: nobody ticks
 * the other side's box, nothing moves out of order, and a figure the other side has confirmed
 * cannot be quietly revised. A client rule is a courtesy — anybody can call the API. */
const { api, check, finish, makeUser, prisma, sweep } = require('./harness.cjs');

const stages = deal => (deal?.steps ?? []).map(step => step.stage);

(async () => {
  await sweep('deals');

  const seller = await makeUser('dealseller');
  const buyer = await makeUser('dealbuyer');
  const pro = await makeUser('dealpro', { bio: 'Eleven years fitting kitchens in Manchester.' });
  const client = await makeUser('dealclient');

  let r = await api(seller.token, 'POST', '/commerce/stores', {
    name: 'Ada Fresh Produce', type: 'LOCAL',
    description: 'Yams, plantain and fresh peppers, brought in twice a week.',
    area: 'Longsight', heritageTags: ['WEST_AFRICAN'],
  });
  const storeId = r.body?.data?.id;
  check('store created', r.status === 201 && !!storeId, r.body?.error);

  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Puna yam', price: 900, unitCode: 'EACH', categoryCode: 'FOOD_GROCERIES',
    description: 'Large tubers, in from Ghana on Thursday.',
  });
  const itemId = r.body?.data?.id;

  r = await api(pro.token, 'POST', '/professionals/listings', {
    categoryCodes: ['TRADES_REPAIRS'], professionTitle: 'Kitchen Fitter', experienceLevel: 'EXPERT',
    about: 'I fit kitchens and have done for eleven years, mostly around south Manchester.',
    consentAccepted: true,
  });
  const listingId = r.body?.data?.listing?.id ?? r.body?.data?.id;
  r = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'Full kitchen fit', description: 'Strip out, fit and finish, two rooms at most.',
    price: 180000, priceBasis: 'PER_JOB',
  });
  const serviceId = r.body?.data?.id;
  check('listing and service created', !!listingId && !!serviceId, r.body?.error);

  const thread = async (token, kind, id) =>
    (await api(token, 'POST', '/messages', { context: { kind, id } })).body?.data?.id;

  const shopThread = await thread(buyer.token, 'STORE', storeId);
  const itemThread = await thread(buyer.token, 'ITEM', itemId);
  const workThread = await thread(client.token, 'SERVICE', serviceId);
  r = await api(client.token, 'POST', '/messages', { recipientUserId: buyer.id });
  const plainThread = r.body?.data?.id;
  check('four threads open', !!shopThread && !!itemThread && !!workThread && !!plainThread);

  console.log('\n── 1 A deal belongs to a thread about something being sold ──');

  r = await api(buyer.token, 'GET', `/deals/conversation/${shopThread}`);
  check('no deal is a 404, which is the normal state of a thread', r.status === 404, r.status);

  r = await api(client.token, 'POST', `/deals/conversation/${plainThread}`, {
    amount: 2000, timing: 'UPFRONT',
  });
  check('a plain DM cannot carry one: a favour is not a sale', r.status === 422, { status: r.status, error: r.body?.error?.code });

  r = await api(buyer.token, 'POST', `/deals/conversation/${shopThread}`, {
    amount: 3500, currency: 'GBP', timing: 'ON_COMPLETION', deposit: null, collects: false,
    summary: 'Two yams and a bag of rice',
  });
  const shopDeal = r.body?.data;
  check('propose → 201', r.status === 201, r.body?.error);
  check('the track follows the thread: a shop thread is COMMERCE', shopDeal?.track === 'COMMERCE', shopDeal?.track);
  check('money comes back as an object, not the pence it went in as', shopDeal?.terms?.amount?.amount === 3500 && shopDeal?.terms?.amount?.currency === 'GBP', shopDeal?.terms?.amount);
  check('no deposit is null, not zero', shopDeal?.terms?.deposit === null, shopDeal?.terms?.deposit);
  check('proposing does NOT mark AGREED, or the acceptor has nothing to tap', stages(shopDeal).length === 0, stages(shopDeal));
  check('it records who proposed', shopDeal?.proposedByRole === 'PAYER', shopDeal?.proposedByRole);
  check('and the buyer of a shop thread is the payer', shopDeal?.viewerRole === 'PAYER', shopDeal?.viewerRole);
  check('nothing is agreed yet', shopDeal?.isAgreedByBoth === false, shopDeal?.isAgreedByBoth);

  r = await api(seller.token, 'GET', `/deals/conversation/${shopThread}`);
  check('viewerRole is per-caller: the seller is the provider', r.body?.data?.viewerRole === 'PROVIDER', r.body?.data?.viewerRole);
  check('while proposedByRole is fixed for both of them', r.body?.data?.proposedByRole === 'PAYER', r.body?.data?.proposedByRole);

  console.log('\n── 3.6 A deposit has to leave a balance ─────────────────────');

  r = await api(client.token, 'POST', `/deals/conversation/${workThread}`, {
    amount: 180000, timing: 'ON_COMPLETION', deposit: 180000,
  });
  check('a deposit equal to the total is refused: nothing left to pay', r.status === 422 && r.body?.error?.details?.[0]?.field === 'deposit', r.body?.error);

  console.log('\n── 3.3 Only the other party may accept ─────────────────────');

  r = await api(buyer.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['AGREED'] });
  check('the proposer cannot agree with themselves', r.status === 422 && r.body?.error?.code === 'INVALID_TRANSITION', r.body?.error);

  r = await api(seller.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['DISPATCHED'] });
  check('and nothing moves before the terms are agreed', r.status === 422, r.body?.error);

  r = await api(buyer.token, 'POST', `/deals/conversation/${shopThread}`, {
    amount: 4000, timing: 'ON_COMPLETION', summary: 'Two yams, a bag of rice and palm oil',
  });
  check('re-proposing an un-agreed deal replaces the terms', r.status === 201 && r.body?.data?.terms?.amount?.amount === 4000, r.body?.data?.terms);
  check('and keeps it un-agreed', r.body?.data?.isAgreedByBoth === false, r.body?.data?.isAgreedByBoth);
  check('on the same deal, not a second one', r.body?.data?.id === shopDeal.id, r.body?.data?.id);

  // "Suggest different terms": the other side counters instead of only being able to refuse.
  r = await api(seller.token, 'POST', `/deals/conversation/${shopThread}`, {
    amount: 4200, timing: 'ON_COMPLETION', summary: 'Two yams, rice and palm oil — 42 for the lot',
  });
  check('the other side can suggest different terms rather than only refuse', r.status === 201 && r.body?.data?.terms?.amount?.amount === 4200, r.body?.data?.terms);
  check('and acceptance moves to whoever did not propose last', r.body?.data?.proposedByRole === 'PROVIDER', r.body?.data?.proposedByRole);
  check('still one deal, still un-agreed', r.body?.data?.id === shopDeal.id && r.body?.data?.isAgreedByBoth === false, r.body?.data);

  r = await api(seller.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['AGREED'] });
  check('so the side that suggested them cannot now accept their own', r.status === 422 && r.body?.error?.code === 'INVALID_TRANSITION', r.body?.error);

  r = await api(buyer.token, 'POST', `/deals/conversation/${shopThread}`, {
    amount: 4000, timing: 'ON_COMPLETION', summary: 'Two yams, a bag of rice and palm oil',
  });
  check('and it can go back the other way as often as they like', r.status === 201 && r.body?.data?.proposedByRole === 'PAYER', r.body?.data?.proposedByRole);

  r = await api(seller.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['AGREED'] });
  check('the other side agrees → 200', r.status === 200, r.body?.error);
  check('which sets isAgreedByBoth', r.body?.data?.isAgreedByBoth === true, r.body?.data);
  check('marked by the role that took it', r.body?.data?.steps?.[0]?.byRole === 'PROVIDER', r.body?.data?.steps?.[0]);
  check('and the step carries a label the client does not have to invent', r.body?.data?.steps?.[0]?.label === 'Terms agreed', r.body?.data?.steps?.[0]);

  r = await api(buyer.token, 'POST', `/deals/conversation/${shopThread}`, {
    amount: 5000, timing: 'UPFRONT',
  });
  check('terms are frozen once agreed: they set the order', r.status === 409 && r.body?.error?.code === 'INVALID_TRANSITION', r.body?.error);

  console.log('\n── 3.1 and 3.2 Nobody ticks the other side\'s box ───────────');

  r = await api(buyer.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['DISPATCHED'] });
  check('a payer cannot mark DISPATCHED', r.status === 422 && r.body?.error?.code === 'INVALID_TRANSITION', r.body?.error);

  r = await api(buyer.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['GOODS_RECEIVED'] });
  check('nor receive goods that were never sent', r.status === 422, r.body?.error);

  r = await api(seller.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['PAID'], amount: 4000 });
  check('and a provider cannot mark PAID on the buyer\'s behalf', r.status === 422, r.body?.error);

  r = await api(seller.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['DISPATCHED'] });
  check('the provider marks their own step', r.status === 200 && stages(r.body?.data).includes('DISPATCHED'), r.body?.error);

  r = await api(seller.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['DISPATCHED'] });
  check('a second DISPATCHED is a refusal, not a silent overwrite', r.status === 422, r.body?.error);

  r = await api(buyer.token, 'POST', `/deals/${shopDeal.id}/steps`, {
    stages: ['PAID', 'GOODS_RECEIVED'], amount: 4000,
  });
  check('two steps in one call: collecting and paying at the counter is one event', r.status === 200, r.body?.error);
  const paid = (r.body?.data?.steps ?? []).find(step => step.stage === 'PAID');
  check('applied in spine order, not the order asked', stages(r.body?.data).join('>') === 'AGREED>DISPATCHED>GOODS_RECEIVED>PAID', stages(r.body?.data));
  check('the paying step carries the figure', paid?.amount?.amount === 4000, paid);
  check('and the steps that are not about money carry none', (r.body?.data?.steps ?? []).find(s => s.stage === 'DISPATCHED')?.amount === null);

  r = await api(buyer.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['PAID'], amount: 100 });
  check('a second PAID is a 422', r.status === 422, r.body?.error);

  console.log('\n── 3.4 A confirmed figure is frozen ────────────────────────');

  r = await api(seller.token, 'PATCH', `/deals/${shopDeal.id}/amount`, { amount: 9999 });
  check('only the paying side may correct their own claim', r.status === 403, { status: r.status, error: r.body?.error?.code });

  r = await api(buyer.token, 'PATCH', `/deals/${shopDeal.id}/amount`, { amount: 3800 });
  check('the payer corrects it before confirmation', r.status === 200, r.body?.error);
  check('and the step shows the corrected figure', (r.body?.data?.steps ?? []).find(s => s.stage === 'PAID')?.amount?.amount === 3800, r.body?.data?.steps);

  r = await api(seller.token, 'GET', '/deals/earnings?track=COMMERCE');
  check('an unconfirmed claim is worth nothing to a total', r.body?.data?.received?.amount === 0, r.body?.data);
  check('and nothing is completed yet', r.body?.data?.completed === 0, r.body?.data);

  r = await api(seller.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['PAYMENT_CONFIRMED'] });
  check('the provider confirms the payment', r.status === 200, r.body?.error);

  r = await api(buyer.token, 'PATCH', `/deals/${shopDeal.id}/amount`, { amount: 10 });
  check('after which the payer cannot revise the shared record alone', r.status === 422 && r.body?.error?.code === 'INVALID_TRANSITION', r.body?.error);

  r = await api(seller.token, 'GET', '/deals/earnings?track=COMMERCE');
  check('a confirmed payment reaches the total', r.body?.data?.received?.amount === 3800, r.body?.data);
  check('as a money object with a currency', r.body?.data?.received?.currency === 'GBP', r.body?.data?.received);

  r = await api(buyer.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['DONE'] });
  check('either side may mark DONE', r.status === 200 && stages(r.body?.data).includes('DONE'), r.body?.error);

  r = await api(seller.token, 'GET', '/deals/earnings?track=COMMERCE');
  check('completed counts deals that reached DONE', r.body?.data?.completed === 1, r.body?.data);

  r = await api(buyer.token, 'GET', '/deals/earnings?track=COMMERCE');
  check('a member with no shop has no earnings screen', r.status === 404, r.status);

  r = await api(seller.token, 'GET', '/deals/earnings');
  check('track is required: two tracks are two screens', r.status === 422 || r.status === 400, r.status);

  console.log('\n── 2 The order is computed from the terms ──────────────────');

  r = await api(buyer.token, 'POST', `/deals/conversation/${itemThread}`, {
    amount: 1800, timing: 'UPFRONT', collects: true, summary: 'Two puna yams, collecting Saturday',
  });
  const itemDeal = r.body?.data;
  check('an item thread is COMMERCE too', itemDeal?.track === 'COMMERCE', itemDeal?.track);
  check('collects is carried as asked', itemDeal?.terms?.collects === true, itemDeal?.terms);

  await api(seller.token, 'POST', `/deals/${itemDeal.id}/steps`, { stages: ['AGREED'] });

  r = await api(seller.token, 'POST', `/deals/${itemDeal.id}/steps`, { stages: ['DISPATCHED'] });
  check('UPFRONT puts the payment pair first: dispatch comes later', r.status === 422, r.body?.error);

  r = await api(buyer.token, 'POST', `/deals/${itemDeal.id}/steps`, { stages: ['PAID'] });
  check('paying first is the whole point of UPFRONT', r.status === 200, r.body?.error);
  check('and an omitted amount falls back to what the terms say is due', (r.body?.data?.steps ?? []).find(s => s.stage === 'PAID')?.amount?.amount === 1800, r.body?.data?.steps);

  await api(seller.token, 'POST', `/deals/${itemDeal.id}/steps`, { stages: ['PAYMENT_CONFIRMED'] });

  r = await api(buyer.token, 'POST', `/deals/${itemDeal.id}/steps`, { stages: ['DISPATCHED'] });
  check('even the refusal is worded for a collection', r.status === 422 && /ready to collect/.test(r.body?.error?.message ?? ''), r.body?.error?.message);

  r = await api(seller.token, 'POST', `/deals/${itemDeal.id}/steps`, { stages: ['DISPATCHED'] });
  check('a buyer collecting is told the order is ready, not that it was sent',
    (r.body?.data?.steps ?? []).find(s => s.stage === 'DISPATCHED')?.label === 'Ready to collect',
    (r.body?.data?.steps ?? []).find(s => s.stage === 'DISPATCHED'));

  r = await api(buyer.token, 'GET', `/messages/${itemThread}/messages?limit=20`);
  check('and the note in the thread reads the way the panel beside it does',
    (r.body?.data ?? []).some(m => /marked: Ready to collect/.test(m.body ?? '')),
    (r.body?.data ?? []).filter(m => m.kind === 'SYSTEM').map(m => m.body));

  r = await api(buyer.token, 'GET', '/notifications?limit=40');
  check('and so does the notification the buyer is sent',
    (r.body?.data ?? []).some(row => /marked: Ready to collect/.test(row.title ?? '')),
    (r.body?.data ?? []).filter(row => row.kind === 'DEAL').map(row => row.title));

  r = await api(client.token, 'POST', `/deals/conversation/${workThread}`, {
    amount: 180000, timing: 'UPFRONT', deposit: 40000, summary: 'Kitchen fit, 4 weeks',
  });
  const workDeal = r.body?.data;
  check('a service thread is PROFESSIONAL', workDeal?.track === 'PROFESSIONAL', workDeal?.track);
  check('the deposit comes back as money', workDeal?.terms?.deposit?.amount === 40000, workDeal?.terms?.deposit);

  await api(pro.token, 'POST', `/deals/${workDeal.id}/steps`, { stages: ['AGREED'] });

  r = await api(client.token, 'POST', `/deals/${workDeal.id}/steps`, { stages: ['PAID'] });
  check('a deposit forces the balance to the end, whatever the timing said', r.status === 422, r.body?.error);

  r = await api(client.token, 'POST', `/deals/${workDeal.id}/steps`, {
    stages: ['DEPOSIT_PAID', 'PAID'],
  });
  check('a deposit and a balance are two figures, so one call carries one', r.status === 422 && r.body?.error?.details?.[0]?.field === 'stages', r.body?.error);

  r = await api(client.token, 'POST', `/deals/${workDeal.id}/steps`, { stages: ['DEPOSIT_PAID'] });
  check('the deposit sits right after AGREED', r.status === 200, r.body?.error);
  check('and defaults to the deposit figure, not the total', (r.body?.data?.steps ?? []).find(s => s.stage === 'DEPOSIT_PAID')?.amount?.amount === 40000, r.body?.data?.steps);

  r = await api(client.token, 'POST', `/deals/${workDeal.id}/steps`, { stages: ['DISPATCHED'] });
  check('a commerce step is not part of a professional deal', r.status === 422, r.body?.error);

  r = await api(pro.token, 'POST', `/deals/${workDeal.id}/steps`, { stages: ['DEPOSIT_CONFIRMED', 'STARTED', 'WORK_DELIVERED'] });
  check('three of the provider\'s own steps in one call', r.status === 200, r.body?.error);

  r = await api(client.token, 'POST', `/deals/${workDeal.id}/steps`, { stages: ['ACCEPTED', 'PAID'] });
  check('the client accepts the work and pays the balance', r.status === 200, r.body?.error);
  check('the balance is the total less the deposit', (r.body?.data?.steps ?? []).find(s => s.stage === 'PAID')?.amount?.amount === 140000, r.body?.data?.steps);

  r = await api(pro.token, 'POST', `/deals/${workDeal.id}/steps`, { stages: ['PAYMENT_CONFIRMED', 'DONE'] });
  check('and the provider confirms and closes it', r.status === 200 && stages(r.body?.data).includes('DONE'), r.body?.error);

  r = await api(pro.token, 'GET', '/deals/earnings?track=PROFESSIONAL');
  check('both confirmed payments count, deposit included', r.body?.data?.received?.amount === 180000, r.body?.data);
  check('and one completed deal', r.body?.data?.completed === 1, r.body?.data);

  r = await api(pro.token, 'GET', '/deals/earnings?track=COMMERCE');
  check('a professional with no shop gets no commerce earnings', r.status === 404, r.status);

  console.log('\n── 4 One notification per call, to the other party only ────');

  const inbox = async token => (await api(token, 'GET', '/notifications?limit=40')).body?.data ?? [];
  const dealRows = (await inbox(seller.token)).filter(row => row.kind === 'DEAL');
  check('the seller was told about the buyer\'s steps', dealRows.length > 0, dealRows.length);
  check('and the target is the thread, because a deal has no screen of its own',
    dealRows.every(row => row.target?.type === 'DEAL' && [shopThread, itemThread].includes(row.target?.id)),
    dealRows.map(row => row.target));
  check('both of the seller\'s deals are represented',
    new Set(dealRows.map(row => row.target?.id)).size === 2, dealRows.map(row => row.target?.id));
  check('the body names the person and the step', /marked: /.test(dealRows[0]?.title ?? ''), dealRows[0]?.title);

  const twoAtOnce = dealRows.filter(row => /Received and Payment sent|Payment sent and Received/.test(row.title ?? ''));
  check('two steps in one call is one notification, not two', twoAtOnce.length === 1, dealRows.map(row => row.title));

  // The title says who did what. The body says which deal, so somebody running two at once can
  // tell them apart on a lock screen without opening either thread.
  check('the body names the deal and its figure',
    twoAtOnce[0]?.body === '£40.00 · Two yams, a bag of rice and palm oil', twoAtOnce[0]?.body);

  const corrected = dealRows.find(row => /corrected payment sent/.test(row.title ?? ''));
  check('and follows a correction', corrected?.body === '£38.00 · Two yams, a bag of rice and palm oil', corrected?.body);

  const proBox = (await inbox(pro.token)).filter(row => row.kind === 'DEAL');
  const balance = proBox.find(row => /Work accepted and Payment sent/.test(row.title ?? ''));
  check('a balance reads as the balance, not as the whole job',
    balance?.body === '£1400.00 · Kitchen fit, 4 weeks', balance?.body);

  const buyerBox = (await inbox(buyer.token)).filter(row => row.kind === 'DEAL');
  check('a step that is not about money falls back to the total',
    buyerBox.some(row => /marked: Terms agreed/.test(row.title ?? '') && row.body === '£40.00 · Two yams, a bag of rice and palm oil'),
    buyerBox.filter(row => /Terms agreed/.test(row.title ?? '')).map(row => row.body));

  const ownRows = (await inbox(buyer.token)).filter(row => row.kind === 'DEAL' && row.actor?.id === buyer.id);
  check('nobody is notified about their own tap', ownRows.length === 0, ownRows.map(row => row.title));

  r = await api(buyer.token, 'GET', `/messages/${shopThread}/messages?limit=50`);
  const notes = (r.body?.data ?? []).filter(m => m.kind === 'SYSTEM');
  check('every step left a note in the thread, so the transcript tells the story',
    notes.filter(m => /marked:/.test(m.body ?? '')).length >= 5, notes.map(m => m.body));
  check('including the proposal itself', notes.some(m => /proposed terms/.test(m.body ?? '')), notes.map(m => m.body));

  console.log('\n── 5 The three numbers, off one implementation ─────────────');

  r = await api(seller.token, 'GET', '/deals/work?track=COMMERCE');
  const sellerWork = r.body?.data;
  check('work returns the three numbers', r.status === 200 && typeof sellerWork?.awaitingReply === 'number' && typeof sellerWork?.openThreads === 'number' && typeof sellerWork?.done === 'number', sellerWork);
  check('counted over every thread: the seller has two', sellerWork?.openThreads === 2, sellerWork);

  r = await api(pro.token, 'GET', '/deals/work?track=PROFESSIONAL');
  const dealWork = r.body?.data;
  r = await api(pro.token, 'GET', '/professionals/home');
  check('and professionals/home agrees with it, field for field',
    JSON.stringify(dealWork) === JSON.stringify(r.body?.data?.myWork), { dealWork, myWork: r.body?.data?.myWork });

  await api(pro.token, 'POST', `/messages/${workThread}/messages`, { clientId: 'deal-p1', body: 'All finished today, the worktop is sealed.' });
  r = await api(pro.token, 'GET', '/deals/work?track=PROFESSIONAL');
  check('the professional having spoken last is not work waiting on them', r.body?.data?.awaitingReply === 0, r.body?.data);

  await api(client.token, 'POST', `/messages/${workThread}/messages`, { clientId: 'deal-c1', body: 'Looks great, thank you.' });
  r = await api(pro.token, 'GET', '/deals/work?track=PROFESSIONAL');
  check('the client speaking again puts it back', r.body?.data?.awaitingReply === 1, r.body?.data);

  await api(pro.token, 'POST', `/messages/${workThread}/archive`);
  r = await api(pro.token, 'GET', '/deals/work?track=PROFESSIONAL');
  check('archiving is the only thing that finishes an enquiry', r.body?.data?.done === 1 && r.body?.data?.openThreads === 0, r.body?.data);

  console.log('\n── 5 The seller\'s own two counters ────────────────────────');

  r = await api(seller.token, 'GET', '/commerce/stores/me');
  check('the owner sees their page views', typeof r.body?.data?.views === 'number', r.body?.data?.views);
  check('and responseRate is null below three enquiries', r.body?.data?.responseRate === null, r.body?.data?.responseRate);

  r = await api(buyer.token, 'GET', `/commerce/stores/${storeId}`);
  check('a buyer sees neither', r.body?.data?.views === undefined && r.body?.data?.responseRate === undefined, { views: r.body?.data?.views, responseRate: r.body?.data?.responseRate });

  for (const tag of ['dealq1', 'dealq2', 'dealq3']) {
    const asker = await makeUser(tag);
    const t = await thread(asker.token, 'STORE', storeId);

    await api(asker.token, 'POST', `/messages/${t}/messages`, { clientId: `${tag}-1`, body: 'Do you have goat meat in this week?' });

    if (tag !== 'dealq3') {
      await api(seller.token, 'POST', `/messages/${t}/messages`, { clientId: `${tag}-2`, body: 'Yes, Thursday.' });
    }
  }

  r = await api(seller.token, 'GET', '/commerce/stores/me');
  // Four members have opened a thread with this shop and the seller has typed a reply to two of
  // them: the buyer they did a whole deal with in steps and system notes never got a message.
  check('past three it is an integer percent, not a fraction', r.body?.data?.responseRate === 50, r.body?.data?.responseRate);

  console.log('\n── 6 DONE is what unlocks a review, both ways ─────────────');

  r = await api(buyer.token, 'GET', `/commerce/stores/${storeId}`);
  check('a done deal unlocks the shop review', r.body?.data?.viewer?.canReview === true, r.body?.data?.viewer);

  r = await api(seller.token, 'GET', `/commerce/stores/${storeId}`);
  check('but never on your own shop', r.body?.data?.viewer?.canReview === false, r.body?.data?.viewer);

  r = await api(buyer.token, 'GET', `/messages/${shopThread}`);
  check('and the inbox offers it on the thread', r.body?.data?.viewer?.canReview === true, r.body?.data?.viewer);

  r = await api(seller.token, 'GET', `/messages/${shopThread}`);
  check('to the seller as well: their experience of a customer is worth the same', r.body?.data?.viewer?.canReview === true, r.body?.data?.viewer);

  r = await api(buyer.token, 'POST', '/reviews', {
    subjectUserId: seller.id, context: 'ORDER', sourceId: shopThread, rating: 5,
    comment: 'Yams were exactly as described and the pickup was easy.',
  });
  check('the buyer reviews the seller off the thread', r.status === 201, r.body?.error);
  check('labelled as a deal rather than an order', r.body?.data?.contextLabel === 'Agreed through Circl', r.body?.data?.contextLabel);

  r = await api(seller.token, 'POST', '/reviews', {
    subjectUserId: buyer.id, context: 'ORDER', sourceId: shopThread, rating: 5,
    comment: 'Collected when they said they would and paid on the spot.',
  });
  check('and the seller reviews the buyer, same source', r.status === 201, r.body?.error);

  r = await api(buyer.token, 'POST', '/reviews', {
    subjectUserId: seller.id, context: 'ORDER', sourceId: shopThread, rating: 4, comment: 'Changed my mind about the rating.',
  });
  check('once each, and the existing one comes back to edit', r.status === 409 && r.body?.error?.code === 'REVIEW_ALREADY_LEFT', r.body?.error);

  r = await api(buyer.token, 'GET', `/messages/${shopThread}`);
  check('the offer goes away once taken', r.body?.data?.viewer?.canReview === false, r.body?.data?.viewer);

  r = await api(client.token, 'POST', '/reviews', {
    subjectUserId: pro.id, context: 'PROFESSIONAL', sourceId: workThread, rating: 5,
    comment: 'Fitted the kitchen in three weeks and cleaned up after himself.',
  });
  check('a done professional deal reviews the same way', r.status === 201, r.body?.error);

  r = await api(pro.token, 'POST', '/reviews', {
    subjectUserId: client.id, context: 'PROFESSIONAL', sourceId: workThread, rating: 5,
    comment: 'Knew what they wanted and paid the balance the same day.',
  });
  check('and the professional may review their client', r.status === 201, r.body?.error);

  r = await api(buyer.token, 'POST', '/reviews', {
    subjectUserId: seller.id, context: 'ORDER', sourceId: itemThread, rating: 5, comment: 'Nothing has finished here yet.',
  });
  check('a deal that is not DONE unlocks nothing', r.status === 422 && r.body?.error?.code === 'REVIEW_NOT_ELIGIBLE', r.body?.error);

  // The track is half the check: a shop's custom must not land on the seller's professional record.
  r = await api(buyer.token, 'POST', '/reviews', {
    subjectUserId: seller.id, context: 'PROFESSIONAL', sourceId: shopThread, rating: 5,
    comment: 'Filing a shop order against their professional reputation.',
  });
  check('a commerce deal cannot be filed as a professional review', r.status === 422 && r.body?.error?.code === 'REVIEW_NOT_ELIGIBLE', { status: r.status, error: r.body?.error?.code });

  r = await api(client.token, 'POST', '/reviews', {
    subjectUserId: pro.id, context: 'ORDER', sourceId: workThread, rating: 5,
    comment: 'And a job of work is not an order.',
  });
  check('nor the other way round', r.status === 422 && r.body?.error?.code === 'REVIEW_NOT_ELIGIBLE', { status: r.status, error: r.body?.error?.code });

  console.log('\n── 3 and 7 Flagging a problem ─────────────────────────────');

  r = await api(buyer.token, 'POST', `/deals/${itemDeal.id}/problem`, {
    note: 'I paid on Saturday and the yams were never put aside.',
  });
  check('flagging → 200', r.status === 200, r.body?.error);
  check('the deal says so', r.body?.data?.hasProblem === true, r.body?.data);
  check('and keeps the note', /never put aside/.test(r.body?.data?.problemNote ?? ''), r.body?.data?.problemNote);
  check('it reverses no step: Circl decides nothing', stages(r.body?.data).includes('PAID'), stages(r.body?.data));

  r = await api(buyer.token, 'GET', '/messages?kind=SUPPORT');
  const support = (r.body?.data ?? [])[0];
  check('a thread with Circl\'s team was opened', !!support, r.body?.data);

  r = await api(buyer.token, 'GET', `/messages/${support?.id}/messages?limit=10`);
  const brief = (r.body?.data ?? []).map(m => m.body ?? '').join('\n');
  check('with both sides named', /E2E dealbuyer/.test(brief) && /E2E dealseller/.test(brief), brief.slice(0, 300));
  check('the amount as money a person can read', /£18\.00/.test(brief), brief.slice(0, 300));
  check('what has been marked so far', /Marked so far/.test(brief), brief.slice(0, 300));
  check('and what they said', /never put aside/.test(brief), brief.slice(0, 300));

  const sellerTold = (await inbox(seller.token)).filter(row => /flagged a problem/.test(row.title ?? ''));
  check('the other party is told too', sellerTold.length === 1, sellerTold.map(row => row.title));
  check('and the body is what they wrote, not the terms they already know',
    sellerTold[0]?.body === 'I paid on Saturday and the yams were never put aside.', sellerTold[0]?.body);

  r = await api(client.token, 'POST', `/deals/${itemDeal.id}/problem`, { note: 'Not my deal.' });
  check('somebody outside the thread cannot flag it', r.status === 403 || r.status === 404, r.status);

  console.log('\n── Circl\'s team in the room is not a side of the deal ─────');

  // What a dispute does: it puts staff into the thread the two of them were already using.
  const staff = await makeUser('dealstaff');

  await prisma.conversationParticipant.create({
    data: { conversationId: itemThread, userId: staff.id, role: 'STAFF' },
  });

  r = await api(staff.token, 'GET', `/deals/conversation/${itemThread}`);
  check('staff in the thread cannot read the deal as one of its sides', r.status === 403, { status: r.status, error: r.body?.error?.code });

  r = await api(staff.token, 'POST', `/deals/${itemDeal.id}/steps`, { stages: ['DISPATCHED'] });
  check('and cannot tick the seller\'s box', r.status === 403, { status: r.status, error: r.body?.error?.code });

  r = await api(staff.token, 'PATCH', `/deals/${itemDeal.id}/amount`, { amount: 1 });
  check('nor revise the buyer\'s figure', r.status === 403, r.status);

  r = await api(staff.token, 'POST', `/deals/${itemDeal.id}/problem`, { note: 'Looking into this.' });
  check('nor flag it on their behalf', r.status === 403, r.status);

  const bare = await makeUser('dealbare');
  const bareThread = await thread(bare.token, 'STORE', storeId);

  await prisma.conversationParticipant.create({
    data: { conversationId: bareThread, userId: staff.id, role: 'STAFF' },
  });

  r = await api(staff.token, 'POST', `/deals/conversation/${bareThread}`, { amount: 500, timing: 'UPFRONT' });
  check('and cannot open one between themselves and the seller', r.status === 403, { status: r.status, error: r.body?.error?.code });

  r = await api(bare.token, 'POST', `/deals/conversation/${bareThread}`, { amount: 500, timing: 'UPFRONT' });
  check('while the buyer in the same thread still can', r.status === 201, r.body?.error);
  check('with the buyer as payer, not the staff account', r.body?.data?.viewerRole === 'PAYER', r.body?.data);

  const bareTold = (await inbox(seller.token)).find(row => row.route === `/messages/${bareThread}`);
  check('a deal with nothing written about it still says what it is worth',
    bareTold?.body === '£5.00', bareTold?.body);

  console.log('\n── Access ─────────────────────────────────────────────────');

  r = await api(client.token, 'GET', `/deals/conversation/${shopThread}`);
  check('a deal is only visible inside its thread', r.status === 403, { status: r.status, error: r.body?.error?.code });

  r = await api(client.token, 'POST', `/deals/${shopDeal.id}/steps`, { stages: ['DONE'] });
  check('and only its two parties can mark anything', r.status === 403 || r.status === 422, r.status);

  r = await api(null, 'GET', `/deals/conversation/${shopThread}`);
  check('unauthenticated is a 401', r.status === 401, r.status);

  await sweep('deals');
  await finish();
})().catch(async error => {
  console.error(error);
  process.exit(1);
});
