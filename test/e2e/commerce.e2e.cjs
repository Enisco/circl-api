/* Section 4 end-to-end check. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');



const allDay = () => ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY']
  .map(day => ({ day, openMinutes: 0, closeMinutes: 1439 }));

(async () => {
  await sweep('pre-run');

  // A phone number, so the store setup prefill has one to offer and label.
  const seller = await makeUser('seller', {
    heritageTag: 'WEST_AFRICAN',
    phoneNumber: '7700900123',
    phoneNumberDiallingCode: '+44',
  });
  const buyer = await makeUser('buyer');
  const ids = [seller.id, buyer.id];

  console.log('\n── 4.1.2 Store setup prefill ────────────────────────────────');

  let r = await api(seller.token, 'GET', '/commerce/stores/setup/prefill');
  check('prefill → 200', r.status === 200, r.body?.error);
  check('store null before setup', r.body?.data?.store === null);
  check('city prefilled', r.body?.data?.prefill?.cityId === 'MANCHESTER');
  check('phone prefilled and LABELLED as from the profile', r.body?.data?.prefill?.phoneNumber === '+447700900123' && r.body?.data?.prefill?.phoneSource === 'PROFILE', r.body?.data?.prefill);
  check("seller's own heritage suggested as a store tag", r.body?.data?.prefill?.suggestedHeritageTags?.includes('WEST_AFRICAN'), r.body?.data?.prefill);
  check('WHERE and CONTACT steps marked PREFILLED', r.body?.data?.steps?.filter(s => s.status === 'PREFILLED').length === 2, r.body?.data?.steps);

  console.log('\n── 4.8.1 Store creation & contact validation ────────────────');

  r = await api(seller.token, 'POST', '/commerce/stores', {
    name: 'Mama Nkechi Foods', type: 'LOCAL',
    description: 'West African groceries, frozen fish and fresh produce.',
    area: 'Moss Side', heritageTags: ['WEST_AFRICAN'], delivers: true,
    openingHours: allDay(),
    contact: [
      { channel: 'WHATSAPP', value: '+44 7911 123456' },
      { channel: 'INSTAGRAM', value: '@mamankechi' },
      { channel: 'WEBSITE', value: 'https://www.mamankechi.co.uk' },
      { channel: 'PHONE', value: '' },
    ],
  });
  check('create store → 201', r.status === 201, r.body?.error);
  const storeId = r.body?.data?.id;
  check('7 opening-hours entries, Monday first', r.body?.data?.openingHours?.length === 7 && r.body.data.openingHours[0].day === 'MONDAY', r.body?.data?.openingHours?.length);
  check('empty contact field is skipped, not an error', r.body?.data?.contact?.length === 3, r.body?.data?.contact);
  check('instagram stored without @, displayed with one', r.body?.data?.contact?.find(c => c.channel === 'INSTAGRAM')?.display === '@mamankechi', r.body?.data?.contact);
  check('website displayed without scheme or www', r.body?.data?.contact?.find(c => c.channel === 'WEBSITE')?.display === 'mamankechi.co.uk', r.body?.data?.contact);
  check('type is {code,label}', r.body?.data?.type?.code === 'LOCAL' && !!r.body?.data?.type?.label);
  check('isNew true', r.body?.data?.isNew === true);

  r = await api(seller.token, 'POST', '/commerce/stores', { name: 'Second Shop', area: 'Rusholme' });
  check('second store → 409 with the existing one in data', r.status === 409 && r.body?.error?.code === 'STORE_ALREADY_EXISTS' && r.body?.data?.store?.id === storeId, r.body?.error);

  r = await api(seller.token, 'PATCH', `/commerce/stores/${storeId}`, {
    contact: [{ channel: 'WHATSAPP', value: '123' }],
  });
  check('short phone → 422 naming the field', r.status === 422 && r.body?.error?.details?.[0]?.field === 'contact[0].value', r.body?.error);

  r = await api(seller.token, 'PATCH', `/commerce/stores/${storeId}`, {
    contact: [{ channel: 'WEBSITE', value: 'notawebsite' }],
  });
  check('website without a dot → 422', r.status === 422, r.body?.error);

  console.log('\n── 4.5.1 Address safety ─────────────────────────────────────');

  await api(seller.token, 'PATCH', `/commerce/stores/${storeId}`, {
    addressLine1: '14 Claremont Road', postcode: 'M14 4TJ', latitude: 53.4512345, longitude: -2.2334567,
  });
  r = await api(buyer.token, 'GET', `/commerce/stores/${storeId}`);
  check('exact address visible when not hidden', r.body?.data?.address?.line1 === '14 Claremont Road' && r.body?.data?.address?.postcode === 'M14 4TJ', r.body?.data?.address);

  await api(seller.token, 'PATCH', `/commerce/stores/${storeId}`, { hidesExactAddress: true });
  r = await api(buyer.token, 'GET', `/commerce/stores/${storeId}`);
  check('hidden: line1 and postcode never sent', r.body?.data?.address?.line1 === null && r.body?.data?.address?.postcode === null, r.body?.data?.address);
  check('hidden: coordinate rounded to roughly a kilometre', r.body?.data?.address?.latitude === 53.45 && r.body?.data?.address?.longitude === -2.23, r.body?.data?.address);
  check('hidden: flagged as approximate', r.body?.data?.address?.isApproximate === true);
  check('hidden: the area still shows', r.body?.data?.address?.area === 'Moss Side');

  const rowAfterHide = await prisma.store.findUnique({ where: { id: storeId } });
  check('turning the flag on erases the stored address, not just the response', rowAfterHide?.addressLine1 === null && rowAfterHide?.postcode === null, { line1: rowAfterHide?.addressLine1 });

  console.log('\n── 4.8.3 Items ──────────────────────────────────────────────');

  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Egusi (ground melon seed)', price: 650, unitCode: 'PER_500G',
    categoryCode: 'FOOD_GROCERIES', description: 'Freshly ground, bagged in the shop each week.',
  });
  check('add item → 201', r.status === 201, r.body?.error);
  const egusiId = r.body?.data?.id;
  check('price is a money object', r.body?.data?.price?.amount === 650);
  check('unit is a code plus a label', r.body?.data?.unit?.code === 'PER_500G' && r.body?.data?.unit?.label === 'per 500g', r.body?.data?.unit);
  check('coverPhotoUrl null with no photos, not an error', r.body?.data?.coverPhotoUrl === null);

  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Whiting fish', price: 1800, categoryCode: 'FRESH_FROZEN',
  });
  const whitingId = r.body?.data?.id;
  check('second item → 201', r.status === 201, r.body?.error);

  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Free thing', price: 0, categoryCode: 'FOOD_GROCERIES',
  });
  check('zero price → 400 naming the field', r.status === 400 && r.body?.error?.details?.some(d => d.field === 'price'), r.body?.error?.details);

  r = await api(buyer.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Not mine', price: 100, categoryCode: 'HOME',
  });
  check('non-owner cannot add items → 403', r.status === 403, r.body?.error);

  r = await api(buyer.token, 'GET', `/commerce/stores/${storeId}/items`);
  check('catalogue → 200 with both items', r.body?.data?.length === 2, r.body?.data?.length);

  console.log('\n── 4.4 Browse ───────────────────────────────────────────────');

  r = await api(buyer.token, 'GET', '/commerce/stores?cityId=MANCHESTER');
  check('browse stores → finds it', r.body?.data?.some(s => s.id === storeId), r.body?.data?.length);
  check('isOpenNow computed server-side', r.body?.data?.find(s => s.id === storeId)?.isOpenNow === true, r.body?.data?.[0]?.isOpenNow);
  check('distanceMiles is null without coordinates (D25)', r.body?.data?.[0]?.distanceMiles === null);

  r = await api(buyer.token, 'GET', '/commerce/stores?priceBand=FROM_5_TO_10');
  check('price band: store passes on ANY item in the band', r.body?.data?.some(s => s.id === storeId), r.body?.data?.length);
  r = await api(buyer.token, 'GET', '/commerce/stores?priceBand=UNDER_5');
  check('price band: no item under £5, so no match', !r.body?.data?.some(s => s.id === storeId), r.body?.data?.length);

  r = await api(buyer.token, 'GET', '/commerce/stores?heritage=WEST_AFRICAN');
  check('heritage filter uses the SHARED taxonomy', r.body?.data?.some(s => s.id === storeId));

  r = await api(buyer.token, 'GET', '/commerce/items?categories=FRESH_FROZEN');
  const whiting = r.body?.data?.find(i => i.id === whitingId);
  check('browse items by category', !!whiting, r.body?.data?.map(i => i.name));
  check('item carries storeIsOpenNow read through its store', whiting?.storeIsOpenNow === true, whiting);

  r = await api(buyer.token, 'GET', '/commerce/items?sort=PRICE_LOW');
  check('price sort works', r.body?.data?.[0]?.price?.amount <= r.body?.data?.[1]?.price?.amount, r.body?.data?.map(i => i.price?.amount));

  await api(seller.token, 'PATCH', `/commerce/stores/${storeId}/status`, { status: 'HOLIDAY' });
  r = await api(buyer.token, 'GET', '/commerce/stores?openNow=true');
  check('a store on holiday is not open, even mid-afternoon', !r.body?.data?.some(s => s.id === storeId), r.body?.data?.length);
  r = await api(buyer.token, 'POST', '/commerce/enquiries', {
    storeId, lines: [{ itemId: egusiId, quantity: 1 }], fulfilment: 'COLLECTION',
  });
  check('holiday store → 422 STORE_CLOSED', r.status === 422 && r.body?.error?.code === 'STORE_CLOSED', r.body?.error);
  await api(seller.token, 'PATCH', `/commerce/stores/${storeId}/status`, { status: 'OPEN' });

  console.log('\n── 4.6 Cart validation ──────────────────────────────────────');

  r = await api(buyer.token, 'POST', '/commerce/carts/validate', {
    lines: [{ itemId: egusiId, quantity: 2 }, { itemId: whitingId, quantity: 1 }],
  });
  check('validate → 200', r.status === 200, r.body?.error);
  check('re-priced from the catalogue', r.body?.data?.estimatedTotal?.amount === 650 * 2 + 1800, r.body?.data?.estimatedTotal);
  check('no issues on a clean cart', r.body?.data?.hasIssues === false);

  await api(seller.token, 'PATCH', `/commerce/items/${whitingId}`, { isAvailable: false });
  r = await api(buyer.token, 'POST', '/commerce/carts/validate', {
    lines: [{ itemId: egusiId, quantity: 2 }, { itemId: whitingId, quantity: 1 }],
  });
  check('sold-out line flagged before sending', r.body?.data?.lines?.find(l => l.itemId === whitingId)?.status === 'UNAVAILABLE', r.body?.data?.lines);
  check('total excludes the unavailable line', r.body?.data?.estimatedTotal?.amount === 1300, r.body?.data?.estimatedTotal);

  r = await api(buyer.token, 'POST', '/commerce/enquiries', {
    storeId, lines: [{ itemId: whitingId, quantity: 1 }], fulfilment: 'COLLECTION',
  });
  check('unavailable item → 422 ITEMS_UNAVAILABLE naming the ids', r.status === 422 && r.body?.error?.code === 'ITEMS_UNAVAILABLE' && r.body?.data?.itemIds?.includes(whitingId), r.body);
  await api(seller.token, 'PATCH', `/commerce/items/${whitingId}`, { isAvailable: true });

  console.log('\n── 4.7 Enquiries ────────────────────────────────────────────');

  r = await api(seller.token, 'POST', '/commerce/enquiries', {
    storeId, lines: [{ itemId: egusiId, quantity: 1 }], fulfilment: 'COLLECTION',
  });
  check('cannot enquire at your own store → 422', r.status === 422 && r.body?.error?.code === 'CANNOT_ENQUIRE_OWN_STORE', r.body?.error);

  r = await api(buyer.token, 'POST', '/commerce/enquiries', {
    storeId, lines: [{ itemId: egusiId, quantity: 2 }], fulfilment: 'DELIVERY',
  });
  check('delivery without an address → 422', r.status === 422 && r.body?.error?.details?.some(d => d.field === 'deliveryAddress'), r.body?.error);

  r = await api(buyer.token, 'POST', '/commerce/enquiries', {
    storeId, lines: [{ itemId: egusiId, quantity: 2 }, { itemId: whitingId, quantity: 1 }],
    fulfilment: 'DELIVERY', deliveryAddress: '12 Wilmslow Road, Manchester',
  });
  check('create enquiry → 201', r.status === 201, r.body?.error);
  const enquiryId = r.body?.data?.id;
  check('human-readable reference, distinct from the id', /^C-\d{4}$/.test(r.body?.data?.reference) && r.body?.data?.reference !== r.body?.data?.id, r.body?.data?.reference);
  check('estimatedTotal re-priced server-side', r.body?.data?.estimatedTotal?.amount === 650 * 2 + 1800, r.body?.data?.estimatedTotal);
  check('conversationId returned', typeof r.body?.data?.conversationId === 'string');
  check('buyer-facing stage is PLACED', r.body?.data?.stage === 'PLACED', r.body?.data?.stage);
  check('no payment fields anywhere', !JSON.stringify(r.body?.data).match(/payout|escrow|stripe|refund/i));

  const enquiryConv = r.body?.data?.conversationId;
  const sysMsg = await prisma.message.findFirst({ where: { conversationId: enquiryConv, kind: 'SYSTEM' } });
  check('system message says the total is an estimate to agree between themselves', /agree the final amount/.test(sysMsg?.body ?? ''), sysMsg?.body);

  r = await api(buyer.token, 'GET', `/commerce/enquiries/${enquiryId}`);
  check('buyer cannot accept their own enquiry', r.body?.data?.viewer?.canAccept === false, r.body?.data?.viewer);
  r = await api(seller.token, 'GET', `/commerce/enquiries/${enquiryId}`);
  check('seller can accept', r.body?.data?.viewer?.canAccept === true && r.body?.data?.viewer?.role === 'SELLER', r.body?.data?.viewer);

  r = await api(buyer.token, 'POST', `/commerce/enquiries/${enquiryId}/ready`);
  check('buyer cannot mark ready → 403', r.status === 403, r.body?.error);

  r = await api(seller.token, 'POST', `/commerce/enquiries/${enquiryId}/accept`);
  check('accept → stage ACCEPTED', r.body?.data?.stage === 'ACCEPTED', r.body?.error);
  r = await api(seller.token, 'POST', `/commerce/enquiries/${enquiryId}/ready`);
  check('ready → stage ON_THE_WAY', r.body?.data?.stage === 'ON_THE_WAY', r.body?.error);
  r = await api(buyer.token, 'POST', `/commerce/enquiries/${enquiryId}/received`);
  check('received → CLOSED, never "Paid out"', r.body?.data?.stage === 'CLOSED', r.body?.data?.stage);
  check('canReview opens on receipt', r.body?.data?.viewer?.canReview === true);

  r = await api(seller.token, 'GET', '/commerce/enquiries?role=SELLER');
  check('seller list → 200 with needsYourAction', r.status === 200 && typeof r.body?.data?.[0]?.needsYourAction === 'boolean', r.body?.error);
  r = await api(buyer.token, 'GET', '/commerce/enquiries?role=SELLER');
  check('role=SELLER without a store → 403 NOT_A_SELLER', r.status === 403 && r.body?.error?.code === 'NOT_A_SELLER', r.body?.error);

  console.log('\n── 4.1.4 Store reviews are SELLER reviews ───────────────────');

  r = await api(buyer.token, 'POST', '/reviews', {
    subjectUserId: seller.id, rating: 5, comment: 'Fresh egusi and she threw in extra plantain. Lovely shop.',
    context: 'ORDER', sourceId: enquiryId,
  });
  check('review the seller, context ORDER → 201', r.status === 201, r.body?.error);
  check('counts toward the average', r.body?.data?.countsToAverage === true);

  const storeReviewTable = await prisma.$queryRawUnsafe(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'store_reviews'",
  );
  check('there is deliberately no store_reviews table', storeReviewTable[0].n === 0, storeReviewTable);

  r = await api(buyer.token, 'GET', `/reviews/${seller.id}?context=ORDER`);
  check('the store profile reads the seller\'s reviews', r.body?.data?.reviews?.length === 1, r.body?.data?.summary);

  r = await api(buyer.token, 'GET', `/commerce/stores/${storeId}`);
  check('the store rating comes from the seller\'s reputation', r.body?.data?.rating?.average === 5 && r.body?.data?.rating?.count === 1, r.body?.data?.rating);
  check('canReview false once reviewed', r.body?.data?.viewer?.canReview === false);

  console.log('\n── 4.8.3 Item deletion & demand hints ───────────────────────');

  r = await api(seller.token, 'DELETE', `/commerce/items/${egusiId}`);
  check('item in an enquiry is delisted, not deleted', r.body?.data?.removed === false && r.body?.data?.delisted === true, r.body?.data);
  r = await api(buyer.token, 'GET', `/commerce/enquiries/${enquiryId}`);
  check('the enquiry keeps its own contents', r.body?.data?.lines?.length === 2 && r.body.data.lines[0].name === 'Egusi (ground melon seed)', r.body?.data?.lines);

  r = await api(seller.token, 'GET', `/commerce/stores/${storeId}/demand-hints`);
  check('no fabricated demand with no data', r.status === 200 && r.body?.data?.length === 0, r.body?.data);

  // Four real searches for the same thing should surface as a hint.
  for (let i = 0; i < 4; i++) {
    await api(buyer.token, 'GET', '/commerce/items?q=plantain&cityId=MANCHESTER');
  }
  await new Promise(res => setTimeout(res, 600));
  r = await api(seller.token, 'GET', `/commerce/stores/${storeId}/demand-hints`);
  check('real searches surface as a demand hint', r.body?.data?.some(h => h.term === 'plantain' && h.searches >= 3), r.body?.data);
  check('hint names the city so it is checkable', r.body?.data?.[0]?.cityName === 'Manchester', r.body?.data?.[0]);

  console.log('\n── 4.3 / 4.8.4 Home, my store, insights ─────────────────────');

  r = await api(seller.token, 'GET', '/commerce/home');
  check('home → 200', r.status === 200, r.body?.error);
  check('myStore present for a seller', r.body?.data?.myStore?.id === storeId, r.body?.data?.myStore);
  check('popular section carries its reason', /Manchester/.test(r.body?.data?.popularReason ?? ''), r.body?.data?.popularReason);
  r = await api(buyer.token, 'GET', '/commerce/home');
  check('myStore null for a non-seller', r.body?.data?.myStore === null);
  check('cart is null, because it lives on the client (D20)', r.body?.data?.cart === null);

  r = await api(seller.token, 'GET', '/commerce/stores/me');
  check('my store → 200 with counts', r.status === 200 && typeof r.body?.data?.pendingEnquiryCount === 'number', r.body?.error);
  r = await api(buyer.token, 'GET', '/commerce/stores/me');
  check('no store → 404 STORE_NOT_FOUND', r.status === 404 && r.body?.error?.code === 'STORE_NOT_FOUND', r.body?.error);

  r = await api(seller.token, 'GET', '/commerce/stores/me/insights');
  check('insights → 200', r.status === 200, r.body?.error);
  check('no earnings, payouts or balances', !JSON.stringify(r.body?.data).match(/earning|payout|balance/i), Object.keys(r.body?.data ?? {}));

  console.log('\n── 4.10 Managed storefront ──────────────────────────────────');

  r = await api(seller.token, 'POST', '/managed-requests', {
    subjectType: 'STOREFRONT', helpAreas: ['LISTINGS', 'ADVERTISING'],
    notes: 'I do not have time to photograph everything.',
  });
  check('managed request → 201 with a thread', r.status === 201 && !!r.body?.data?.conversationId, r.body?.error);
  const managedMsg = await prisma.message.findFirst({
    where: { conversationId: r.body.data.conversationId, kind: 'SYSTEM' },
  });
  check('store details attached server-side, not re-asked', managedMsg?.systemData?.storeName === 'Mama Nkechi Foods' && managedMsg?.systemData?.itemCount === 2, managedMsg?.systemData);

  console.log('\n── 4.1.3 One dispute resource, shared with bookings ─────────');

  // 4.1.3: one polymorphic endpoint, not a near-identical one per section.
  r = await api(buyer.token, 'POST', '/disputes', {
    subjectType: 'ORDER', subjectId: enquiryId, reasonCode: 'NOT_AS_DESCRIBED',
    description: 'The whiting was not fresh and the bag had been opened already.',
  });
  check('raise an order dispute via POST /disputes → 201', r.status === 201, r.body?.error);
  const dispute = await prisma.dispute.findFirst({ where: { enquiryId } });
  check('stored with subjectType ORDER on the SHARED table', dispute?.subjectType === 'ORDER', dispute?.subjectType);
  check('reuses the enquiry thread rather than opening a new one', dispute?.conversationId === enquiryConv, { dispute: dispute?.conversationId, enquiry: enquiryConv });

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await sweep('cleanup');

  await finish();
})().catch(fail);
