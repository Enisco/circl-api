/**
 * Editing the media on a service and on a product, from `BACKEND-TODO.md` 1.1.
 *
 * The field used to take upload keys and nothing else, and every write destroyed the rows it was
 * replacing — so a professional with three photographs who added a fourth could only name the one
 * they had just picked, and the server had to read that as either "these four" or "this one, and
 * lose the three". It read it as the second. There was no shape of request that said "keep what is
 * here, and add this", which made adding a photograph and removing one equally impossible.
 *
 * So the checks below are all one question: does the array mean the whole set, in order?
 */
const {
  api,
  approveListing,
  check,
  fail,
  finish,
  makeUser,
  sweep,
  uploadPng,
  uploadStubVideo,
} = require('./harness.cjs');

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

/** Media ids in order, which is what "the whole set, in display order" has to come back as. */
const idsOf = data => (data?.media ?? []).map(file => file.id);
const kindsOf = data => (data?.media ?? []).map(file => `${file.type}:${file.role}`);

(async () => {
  await sweep('media-sets');

  const pro = await makeUser('mediasetpro', { bio: 'Twelve years of removals around Leeds.' });
  const seller = await makeUser('mediasetseller');

  let r = await api(pro.token, 'POST', '/professionals/listings', {
    categoryCodes: ['LOGISTICS'],
    professionTitle: 'Man and Van',
    experienceLevel: 'EXPERT',
    about: 'Removals and single items, mostly around Leeds and Bradford, twelve years at it.',
    consentAccepted: true,
  });

  const listingId = r.body?.data?.listing?.id ?? r.body?.data?.id;

  await approveListing(listingId);

  r = await api(seller.token, 'POST', '/commerce/stores', {
    name: 'Ada Fresh Produce',
    type: 'LOCAL',
    description: 'Yams, plantain and fresh peppers, brought in twice a week.',
    area: 'Longsight',
    heritageTags: ['WEST_AFRICAN'],
  });

  const storeId = r.body?.data?.id;

  check('a listing and a shop to attach things to', !!listingId && !!storeId, r.body?.error);

  // ───────────────────────────────────────────────────────────────────────────
  heading('1. A service that already has three photographs');

  const first = await uploadPng(pro.token, 'PROFESSIONAL', 1200, 900);
  const second = await uploadPng(pro.token, 'PROFESSIONAL', 1200, 900);
  const third = await uploadPng(pro.token, 'PROFESSIONAL', 1200, 900);

  r = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'Full house move, two movers',
    description:
      'Two movers and a Luton van for the day, blankets and straps included, stairs are fine.',
    pricePence: 26000,
    priceBasis: 'PER_JOB',
    mediaKeys: [
      { key: first, role: 'SHOWCASE' },
      { key: second, role: 'SHOWCASE' },
      { key: third, role: 'PROMO' },
    ],
  });

  const serviceId = r.body?.data?.id;
  const original = idsOf(r.body?.data);

  check('three photographs go on at create', r.status === 201 && original.length === 3, {
    status: r.status,
    error: r.body?.error,
  });

  heading('2. Adding a fourth, by naming the three that are here');

  const fourth = await uploadPng(pro.token, 'PROFESSIONAL', 1200, 900);

  r = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${serviceId}`, {
    mediaKeys: [...original.map(id => ({ id })), { key: fourth, role: 'SHOWCASE' }],
  });

  const afterAdd = idsOf(r.body?.data);

  check('the service comes back with four', r.status === 200 && afterAdd.length === 4, {
    status: r.status,
    error: r.body?.error,
    media: afterAdd.length,
  });
  check(
    'and the three that were already here are the same rows, in the same order',
    afterAdd.slice(0, 3).join() === original.join(),
    { before: original, after: afterAdd },
  );
  check(
    'a kept entry that sends no role keeps the role it had, rather than being demoted to SHOWCASE',
    kindsOf(r.body?.data)[2] === 'IMAGE:PROMO',
    kindsOf(r.body?.data),
  );

  heading('3. Removing one, and reordering the rest');

  const keep = afterAdd.filter(id => id !== afterAdd[1]);

  r = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${serviceId}`, {
    mediaKeys: [{ id: keep[2] }, { id: keep[0] }, { id: keep[1] }],
  });

  check(
    'one removed and the other three reordered, in one write',
    r.status === 200 && idsOf(r.body?.data).join() === [keep[2], keep[0], keep[1]].join(),
    { status: r.status, media: idsOf(r.body?.data), error: r.body?.error },
  );

  heading('4. What the array still refuses');

  r = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${serviceId}`, {
    mediaKeys: [{ id: '00000000-0000-4000-8000-000000000000' }],
  });

  check(
    'an id that is not on this record is 422 MEDIA_NOT_FOUND',
    r.status === 422 && r.body?.error?.code === 'MEDIA_NOT_FOUND',
    { status: r.status, code: r.body?.error?.code },
  );
  check(
    'and the refusal names the entry it could not find, rather than "one or more"',
    // `data` sits beside `error` in the envelope, not inside it.
    (r.body?.data?.missing ?? []).includes('00000000-0000-4000-8000-000000000000'),
    r.body?.data,
  );

  const strangerPhoto = await uploadPng(seller.token, 'COMMERCE', 400, 400);

  r = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${serviceId}`, {
    mediaKeys: [{ key: strangerPhoto, role: 'SHOWCASE' }],
  });

  check(
    'somebody else’s upload is still refused',
    r.status === 422 && r.body?.error?.code === 'MEDIA_NOT_FOUND',
    { status: r.status, code: r.body?.error?.code },
  );

  const current = (await api(pro.token, 'GET', `/professionals/services/${serviceId}`)).body?.data;

  check('and a refused write changed nothing', idsOf(current).length === 3, idsOf(current));

  r = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${serviceId}`, {
    mediaKeys: [{ id: idsOf(current)[0] }, { id: idsOf(current)[0] }],
  });

  check(
    'the same file twice in one set is refused rather than silently collapsed',
    r.status === 422,
    { status: r.status, code: r.body?.error?.code },
  );

  // The same mistake with keys rather than ids. It used to come back as `Not found:` with an empty
  // list after it, because the row was found once and counted twice.
  const twice = await uploadPng(pro.token, 'PROFESSIONAL', 800, 600);

  r = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${serviceId}`, {
    mediaKeys: [{ key: twice }, { key: twice }],
  });

  check('the same upload key twice is refused, and named', r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });

  check(
    'and the refusal says which key, rather than reporting it missing',
    (r.body?.data?.repeated ?? []).includes(twice) &&
      !(r.body?.error?.details?.[0]?.message ?? '').endsWith(': '),
    { details: r.body?.error?.details, data: r.body?.data },
  );

  heading('5. An id on a create, where there is nothing to name yet');

  r = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, {
    name: 'Single item, two flights up',
    description: 'One sofa, one wardrobe, that kind of job. Two of us and a tail-lift van.',
    pricePence: 8000,
    priceBasis: 'PER_JOB',
    mediaKeys: [{ id: idsOf(current)[0] }],
  });

  check(
    'is 422, and says to send the upload keys',
    r.status === 422 && r.body?.error?.code === 'MEDIA_NOT_FOUND',
    { status: r.status, code: r.body?.error?.code, message: r.body?.error?.message },
  );

  heading('6. A video keeps its poster frame across an edit');

  const clip = await uploadStubVideo(pro.token, 'PROFESSIONAL');
  const poster = await uploadPng(pro.token, 'PROFESSIONAL', 1080, 1920);

  r = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${serviceId}`, {
    mediaKeys: [
      ...idsOf(current).map(id => ({ id })),
      { key: clip, role: 'TESTIMONIAL', posterKey: poster },
    ],
  });

  const withVideo = r.body?.data?.media ?? [];
  const videoId = withVideo.find(file => file.type === 'VIDEO')?.id;

  check(
    'the clip goes on with its frame',
    r.status === 200 &&
      /^https?:\/\//.test(withVideo.find(f => f.type === 'VIDEO')?.thumbnailUrl ?? ''),
    { status: r.status, media: kindsOf(r.body?.data), error: r.body?.error },
  );

  r = await api(pro.token, 'PATCH', `/professionals/listings/${listingId}/services/${serviceId}`, {
    mediaKeys: [{ id: videoId }],
  });

  const keptVideo = (r.body?.data?.media ?? [])[0];

  check(
    'and keeping only the video — with no posterKey to send — keeps the frame too',
    r.status === 200 && /^https?:\/\//.test(keptVideo?.thumbnailUrl ?? ''),
    { status: r.status, media: r.body?.data?.media, error: r.body?.error },
  );
  check(
    'the gallery is the video alone: the poster is not a photograph',
    r.body?.data?.mediaCounts?.images === 0 && r.body?.data?.mediaCounts?.videos === 1,
    r.body?.data?.mediaCounts,
  );

  // ───────────────────────────────────────────────────────────────────────────
  heading('7. The same field on a product');

  const itemPhoto = await uploadPng(seller.token, 'COMMERCE', 1000, 1000);
  const itemSecond = await uploadPng(seller.token, 'COMMERCE', 1000, 1000);

  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, {
    name: 'Jollof rice, party size',
    description: 'Cooked to order for ten to twelve people.',
    price: 4500,
    categoryCode: 'FOOD_GROCERIES',
    mediaKeys: [{ key: itemPhoto, role: 'SHOWCASE' }],
  });

  const itemId = r.body?.data?.id;
  const itemMediaId = idsOf(r.body?.data)[0];

  check('a product with one photograph', r.status === 201 && !!itemMediaId, r.body?.error);

  r = await api(seller.token, 'PATCH', `/commerce/items/${itemId}`, {
    mediaKeys: [{ id: itemMediaId }, { key: itemSecond, role: 'SHOWCASE' }],
  });

  check(
    'keeps the first and adds the second',
    r.status === 200 && idsOf(r.body?.data).length === 2 && idsOf(r.body?.data)[0] === itemMediaId,
    { status: r.status, media: idsOf(r.body?.data), error: r.body?.error },
  );

  heading('8. photoKeys, which the app believed did this already');

  const itemThird = await uploadPng(seller.token, 'COMMERCE', 1000, 1000);
  const kept = idsOf(r.body?.data);

  r = await api(seller.token, 'PATCH', `/commerce/items/${itemId}`, {
    photoKeys: [kept[0], itemThird],
  });

  check(
    'a media id in photoKeys keeps that photo, beside a fresh storage key',
    r.status === 200 && idsOf(r.body?.data).length === 2 && idsOf(r.body?.data)[0] === kept[0],
    { status: r.status, media: idsOf(r.body?.data), error: r.body?.error },
  );
  check(
    'and the one left out is gone',
    !idsOf(r.body?.data).includes(kept[1]),
    idsOf(r.body?.data),
  );

  heading('9. The limits count the whole set, not just what is arriving');

  // The product has two photographs at this point and the published limit is five.
  const filler = [];

  for (let i = 0; i < 3; i += 1) {
    filler.push(await uploadPng(seller.token, 'COMMERCE', 400, 400));
  }

  r = await api(seller.token, 'PATCH', `/commerce/items/${itemId}`, {
    mediaKeys: [
      ...idsOf(r.body?.data).map(id => ({ id })),
      ...filler.map(key => ({ key, role: 'SHOWCASE' })),
    ],
  });

  check('five photographs is the published limit and five is allowed', r.status === 200, {
    status: r.status,
    error: r.body?.error,
  });

  const sixth = await uploadPng(seller.token, 'COMMERCE', 400, 400);

  r = await api(seller.token, 'PATCH', `/commerce/items/${itemId}`, {
    mediaKeys: [...idsOf(r.body?.data).map(id => ({ id })), { key: sixth, role: 'SHOWCASE' }],
  });

  check(
    'a sixth is refused, counted against the five already attached rather than against one',
    r.status === 422,
    { status: r.status, code: r.body?.error?.code, message: r.body?.error?.message },
  );

  heading('10. Both arrays in one write: mediaKeys decides, photoKeys is ignored');

  // BACKEND-TODO-UPDATED 1.1. The app sends both today — `photoKeys` as the whole photo set and
  // `mediaKeys` as this session's picks — and nothing said which won. It turned on whether
  // `mediaKeys` was *empty*, so the same request shape had two outcomes.
  // Re-read, because the last response was the refusal of the sixth and carries no item.
  const five = idsOf((await api(seller.token, 'GET', `/commerce/items/${itemId}`)).body?.data);

  check('the product has its five photographs to start from', five.length === 5, five);

  r = await api(seller.token, 'PATCH', `/commerce/items/${itemId}`, {
    photoKeys: five,
    mediaKeys: [{ id: five[0] }, { id: five[1] }],
  });

  check(
    'sending both applies mediaKeys and ignores photoKeys outright',
    r.status === 200 && idsOf(r.body?.data).length === 2,
    { status: r.status, media: idsOf(r.body?.data), error: r.body?.error },
  );

  r = await api(seller.token, 'PATCH', `/commerce/items/${itemId}`, {
    photoKeys: idsOf(r.body?.data),
    mediaKeys: [],
  });

  check(
    'an empty mediaKeys clears the set rather than falling back to photoKeys',
    r.status === 200 && idsOf(r.body?.data).length === 0,
    { status: r.status, media: idsOf(r.body?.data), error: r.body?.error },
  );

  await sweep('media-sets');
  await finish();
})().catch(fail);
