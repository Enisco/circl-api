/* Validation tables 2.13, 3.8, 4.12 and 5.9, driven through the live API. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');

const str = n => 'a'.repeat(n);
const dobFor = y => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - y); return d.toISOString().slice(0, 10); };

(async () => {
  await sweep('pre-run');
  const pro = await makeUser('vpro');
  const client = await makeUser('vcli');

  console.log('\n── 2.13 Professionals ───────────────────────────────────────');

  const listing = v => ({ categoryCodes: ['LEGAL'], experienceLevel: 'EXPERT', consentAccepted: true, about: str(50), professionTitle: str(20), ...v });

  let r = await api(pro.token, 'POST', '/professionals/listings', listing({ professionTitle: str(2) }));
  check('Listing.professionTitle: 2 rejected', r.status === 400, r.status);
  r = await api(pro.token, 'POST', '/professionals/listings', listing({ professionTitle: str(81) }));
  check('Listing.professionTitle: 81 rejected', r.status === 400, r.status);
  r = await api(pro.token, 'POST', '/professionals/listings', listing({ about: str(19) }));
  check('Listing.about: 19 rejected', r.status === 400, r.status);
  r = await api(pro.token, 'POST', '/professionals/listings', listing({ about: str(4001) }));
  check('Listing.about: 4001 rejected', r.status === 400, r.status);
  r = await api(pro.token, 'POST', '/professionals/listings', listing({ categoryCodes: [] }));
  check('Listing.categoryCodes: empty rejected', r.status === 400, r.status);
  r = await api(pro.token, 'POST', '/professionals/listings', listing({ categoryCodes: ['LEGAL','IMMIGRATION','HEALTHCARE','TECH_SOFTWARE'] }));
  check('Listing.categoryCodes: 4 rejected', r.status === 400, r.status);
  r = await api(pro.token, 'POST', '/professionals/listings', listing({ consentAccepted: false }));
  check('Listing.consentAccepted: false rejected', r.status === 400, r.status);

  r = await api(pro.token, 'POST', '/professionals/listings', listing({ professionTitle: str(3), about: str(20) }));
  check('Listing: boundaries 3/20 accepted', r.status === 201, r.body?.error?.message);
  const listingId = r.body?.data?.listing?.id;

  r = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, { name: str(1) });
  check('Service.name: 1 rejected', r.status === 400, r.status);
  r = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, { name: str(81) });
  check('Service.name: 81 rejected', r.status === 400, r.status);
  r = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, { name: str(20), description: str(501) });
  check('Service.description: 501 rejected', r.status === 400, r.status);
  r = await api(pro.token, 'POST', `/professionals/listings/${listingId}/services`, { name: str(2), description: str(500), price: 6500 });
  check('Service: boundaries 2/500 accepted', r.status === 201, r.body?.error?.message);
  const serviceId = r.body?.data?.id;

  r = await api(client.token, 'POST', '/professionals/briefs', { categoryCode: 'LEGAL', description: str(4001) });
  check('Brief.description: 4001 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/professionals/briefs', { categoryCode: 'LEGAL', description: str(4000) });
  check('Brief.description: 4000 accepted', r.status === 201, r.body?.error?.message);

  r = await api(client.token, 'POST', '/bookings', { listingId, serviceId, details: str(2001) });
  check('Booking.details: 2001 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/bookings', { listingId, serviceId, details: str(2000) });
  check('Booking.details: 2000 accepted', r.status === 201, r.body?.error?.message);
  const bookingId = r.body?.data?.id;

  await api(pro.token, 'POST', `/bookings/${bookingId}/accept`);
  await api(pro.token, 'POST', `/bookings/${bookingId}/start`);
  await api(pro.token, 'POST', `/bookings/${bookingId}/deliver`, {});
  r = await api(client.token, 'POST', `/bookings/${bookingId}/request-changes`, { message: str(2001) });
  check('Request changes.message: 2001 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', `/bookings/${bookingId}/request-changes`, { message: str(2000) });
  check('Request changes.message: 2000 accepted', r.status === 200, r.body?.error?.message);

  r = await api(client.token, 'POST', `/bookings/${bookingId}/disputes`, { reasonCode: 'QUALITY', description: str(19) });
  check('Dispute.description: 19 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', `/bookings/${bookingId}/disputes`, { reasonCode: 'QUALITY', description: str(4001) });
  check('Dispute.description: 4001 rejected', r.status === 400, r.status);

  await api(pro.token, 'POST', `/bookings/${bookingId}/deliver`, {});
  await api(client.token, 'POST', `/bookings/${bookingId}/complete`);

  const review = v => ({ subjectUserId: pro.id, rating: 5, context: 'BOOKING', sourceId: bookingId, comment: str(50), ...v });
  r = await api(client.token, 'POST', '/reviews', review({ comment: str(19) }));
  check('Review.comment: 19 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/reviews', review({ comment: str(2001) }));
  check('Review.comment: 2001 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/reviews', review({ rating: 0 }));
  check('Review.rating: 0 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/reviews', review({ rating: 6 }));
  check('Review.rating: 6 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/reviews', review({ tags: ['VISA_ADVICE','JOB_HELP','MOVING','CHILDCARE','ON_TIME','FAIR_PRICE'] }));
  check('Review.tags: 6 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/reviews', review({ comment: str(20), rating: 1 }));
  check('Review: boundaries 20 chars / rating 1 accepted', r.status === 201, r.body?.error?.message);

  console.log('\n── 3.8 Connect ──────────────────────────────────────────────');

  const cp = v => ({ typeCode: 'FRIENDSHIP', lookingFor: str(20), dateOfBirth: dobFor(30), ...v });
  r = await api(client.token, 'PUT', '/connect/me', cp({ lookingFor: str(9) }));
  check('lookingFor: 9 rejected', r.status === 400, r.status);
  r = await api(client.token, 'PUT', '/connect/me', cp({ lookingFor: str(501) }));
  check('lookingFor: 501 rejected', r.status === 400, r.status);
  r = await api(client.token, 'PUT', '/connect/me', cp({ languages: ['ENGLISH','YORUBA','IGBO','HAUSA','FRENCH','ARABIC','URDU'] }));
  check('languages: 7 rejected', r.status === 400, r.status);
  r = await api(client.token, 'PUT', '/connect/me',
    cp({ interests: ['JOB_SEARCH','MUSIC','TECH','STUDY','TRAVEL','GAMING','READING','OUTDOORS','BUSINESS'] }));
  check('interests: 9 rejected', r.status === 400, r.status);
  r = await api(client.token, 'PUT', '/connect/me', cp({ lookingFor: str(10) }));
  check('lookingFor: 10 accepted', r.status === 200, r.body?.error?.message);

  const target = await makeUser('vtgt');
  await api(target.token, 'PUT', '/connect/me', { typeCode: 'FRIENDSHIP', lookingFor: str(20), dateOfBirth: dobFor(28), isVisible: true });
  r = await api(client.token, 'POST', '/connect/requests', { toProfileId: target.id, note: str(301) });
  check('Request note: 301 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/connect/requests', { toProfileId: target.id, note: str(300) });
  check('Request note: 300 accepted', r.status === 201, r.body?.error?.message);

  console.log('\n── 4.12 Commerce ────────────────────────────────────────────');

  const seller = await makeUser('vsell');
  const store = v => ({ name: str(20), area: str(20), ...v });
  r = await api(seller.token, 'POST', '/commerce/stores', store({ name: str(1) }));
  check('Store.name: 1 rejected', r.status === 400, r.status);
  r = await api(seller.token, 'POST', '/commerce/stores', store({ name: str(61) }));
  check('Store.name: 61 rejected', r.status === 400, r.status);
  r = await api(seller.token, 'POST', '/commerce/stores', store({ area: str(1) }));
  check('Store.area: 1 rejected', r.status === 400, r.status);
  r = await api(seller.token, 'POST', '/commerce/stores', store({ area: str(81) }));
  check('Store.area: 81 rejected', r.status === 400, r.status);
  r = await api(seller.token, 'POST', '/commerce/stores', store({ description: str(1001) }));
  check('Store.description: 1001 rejected', r.status === 400, r.status);
  r = await api(seller.token, 'POST', '/commerce/stores', store({ heritageTags: ['WEST_AFRICAN','EAST_AFRICAN','CARIBBEAN','SOUTH_ASIAN','BRITISH'] }));
  check('Store.heritageTags: 5 rejected', r.status === 400, r.status);
  r = await api(seller.token, 'POST', '/commerce/stores', store({ name: str(2), area: str(2), description: str(1000), heritageTags: ['WEST_AFRICAN'] }));
  check('Store: boundaries 2/2/1000/4 accepted', r.status === 201, r.body?.error?.message);
  const storeId = r.body?.data?.id;

  const item = v => ({ name: str(20), price: 500, categoryCode: 'FOOD_GROCERIES', ...v });
  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, item({ name: str(1) }));
  check('Item.name: 1 rejected', r.status === 400, r.status);
  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, item({ name: str(101) }));
  check('Item.name: 101 rejected', r.status === 400, r.status);
  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, item({ price: 0 }));
  check('Item.price: 0 rejected', r.status === 400, r.status);
  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, item({ description: str(1001) }));
  check('Item.description: 1001 rejected', r.status === 400, r.status);
  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, item({ photoMediaIds: ['a','b','c','d','e','f'] }));
  check('Item.photoMediaIds: 6 rejected', r.status === 400, r.status);
  r = await api(seller.token, 'POST', `/commerce/stores/${storeId}/items`, item({ name: str(2), price: 1, description: str(1000) }));
  check('Item: boundaries 2/1p/1000 accepted', r.status === 201, r.body?.error?.message);
  const itemId = r.body?.data?.id;

  const enq = v => ({ storeId, lines: [{ itemId, quantity: 1 }], fulfilment: 'COLLECTION', ...v });
  r = await api(client.token, 'POST', '/commerce/enquiries', enq({ lines: [] }));
  check('Enquiry.lines: empty rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/commerce/enquiries', enq({ lines: Array(51).fill({ itemId, quantity: 1 }) }));
  check('Enquiry.lines: 51 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/commerce/enquiries', enq({ lines: [{ itemId, quantity: 0 }] }));
  check('Enquiry quantity: 0 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/commerce/enquiries', enq({ lines: [{ itemId, quantity: 100 }] }));
  check('Enquiry quantity: 100 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/commerce/enquiries', enq({ note: str(1001) }));
  check('Enquiry.note: 1001 rejected', r.status === 400, r.status);
  await api(seller.token, 'PATCH', `/commerce/stores/${storeId}`, { delivers: true });
  r = await api(client.token, 'POST', '/commerce/enquiries', enq({ fulfilment: 'DELIVERY', deliveryAddress: str(5) }));
  check('Enquiry.deliveryAddress: 5 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/commerce/enquiries', enq({ fulfilment: 'DELIVERY', deliveryAddress: str(301) }));
  check('Enquiry.deliveryAddress: 301 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/commerce/enquiries', enq({ fulfilment: 'DELIVERY', deliveryAddress: str(6), note: str(1000) }));
  check('Enquiry: boundaries 6/1000 accepted', r.status === 201, r.body?.error?.message);

  console.log('\n── 5.9 Messaging ────────────────────────────────────────────');

  await prisma.userProfile.updateMany({ where: { userId: seller.id }, data: { openInbox: true } });
  r = await api(client.token, 'POST', '/messages', { recipientUserId: seller.id });
  const convId = r.body?.data?.id;
  check('thread opened for the message checks', r.status === 201 || r.status === 200, r.body?.error);

  r = await api(client.token, 'POST', `/messages/${convId}/messages`, { clientId: 'c1', body: str(4001) });
  check('body (TEXT): 4001 rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', `/messages/${convId}/messages`, { clientId: 'c2', body: str(4000) });
  check('body (TEXT): 4000 accepted', r.status === 201, r.body?.error?.message);
  r = await api(client.token, 'POST', `/messages/${convId}/messages`, { clientId: str(65), body: 'x' });
  check('clientId: 65 chars rejected', r.status === 400, r.status);
  r = await api(client.token, 'POST', `/messages/${convId}/messages`, { clientId: str(64), body: 'x' });
  check('clientId: 64 chars accepted', r.status === 201, r.body?.error?.message);
  r = await api(client.token, 'POST', `/messages/${convId}/messages`, { clientId: 'c5', kind: 'IMAGE', attachmentIds: ['a','b','c','d','e','f'] });
  check('attachmentIds: 6 rejected', r.status === 400, r.status);

  console.log('\n── 0.11 media rules ─────────────────────────────────────────');
  r = await api(client.token, 'POST', '/media/uploads', { files: [{ mimeType: 'application/pdf', byteSize: 100 }] });
  check('unsupported mime → 422 MEDIA_TYPE_NOT_ALLOWED', r.status === 422 && r.body?.error?.code === 'MEDIA_TYPE_NOT_ALLOWED', r.body?.error);
  r = await api(client.token, 'POST', '/media/uploads', { files: [{ mimeType: 'image/jpeg', byteSize: 11 * 1024 * 1024 }] });
  check('image over 10MB → 422 MEDIA_TOO_LARGE', r.status === 422 && r.body?.error?.code === 'MEDIA_TOO_LARGE', r.body?.error);
  r = await api(client.token, 'POST', '/media/uploads', { files: [{ mimeType: 'video/mp4', byteSize: 101 * 1024 * 1024 }] });
  check('video over 100MB → 422', r.status === 422, r.body?.error);
  r = await api(client.token, 'POST', '/media/uploads', { files: [{ mimeType: 'audio/m4a', byteSize: 1000, durationMs: 300001 }] });
  check('voice note over 5 min → 400', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/media/uploads', { files: [{ mimeType: 'audio/m4a', byteSize: 1000, durationMs: 700 }] });
  check('voice note under 0.8s → 400', r.status === 400, r.status);
  r = await api(client.token, 'POST', '/media/uploads',
    { files: [{ mimeType: 'audio/m4a', byteSize: 1000, durationMs: 14000, waveform: Array(41).fill(0.5) }] });
  check('waveform over 40 floats → 400', r.status === 400, r.status);

  const img = await api(client.token, 'POST', '/media/uploads',
    { files: Array(6).fill({ mimeType: 'image/jpeg', byteSize: 1000 }) });
  const sixIds = img.body?.data?.map(d => d.mediaId) ?? [];
  r = await api(client.token, 'POST', '/community/updates', { content: 'six photos', mediaIds: sixIds });
  check('6 images on one post rejected', r.status === 400 || r.status === 422, r.status);

  const mix = await api(client.token, 'POST', '/media/uploads',
    { files: [{ mimeType: 'image/jpeg', byteSize: 1000 }, { mimeType: 'video/mp4', byteSize: 1000 }] });
  const mixIds = mix.body?.data?.map(d => d.mediaId) ?? [];
  r = await api(client.token, 'POST', '/community/updates', { content: 'mixed', mediaIds: mixIds });
  check('images + video together → 422 MEDIA_MIXED_TYPES', r.status === 422 && r.body?.error?.code === 'MEDIA_MIXED_TYPES', r.body?.error);

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await sweep('cleanup');
  await finish();
})().catch(fail);
