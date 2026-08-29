/* Media: keys, presigning and signed reads (spec 0.11).
 *
 * The whole section turns on one substitution: the client sends object KEYS and
 * never sees a URL it did not receive from us. This checks both halves of that,
 * because the failure mode is silent -- a serialiser that forgets the signer
 * returns a null avatar, which renders exactly like "no photo set". */
const { api, makeUser, check, finish, sweep, prisma } = require('./harness.cjs');

(async () => {
  await sweep();
  const u = await makeUser('media');

  const up = await api(u.token, 'POST', '/media/uploads', {
    purpose: 'COMMUNITY',
    files: [{ mimeType: 'image/jpeg', byteSize: 2048 }],
  });
  check('upload mint → 201', up.status === 201, { s: up.status, b: up.body });

  const slot = up.body?.data?.[0] ?? {};
  check('returns a key, not an id', typeof slot.key === 'string' && !slot.mediaId, slot);
  check('key is namespaced by purpose and owner',
    slot.key?.startsWith(`circl/community/${u.id}/`), slot.key);
  check('returns a presigned uploadUrl', typeof slot.uploadUrl === 'string' && slot.uploadUrl.length > 0, slot.uploadUrl?.slice(0, 60));
  check('signs exactly Content-Type and Content-Length',
    JSON.stringify(Object.keys(slot.uploadHeaders ?? {}).sort()) === '["Content-Length","Content-Type"]',
    slot.uploadHeaders);
  check('uploadHeaders match what was requested',
    slot.uploadHeaders?.['Content-Type'] === 'image/jpeg' && String(slot.uploadHeaders?.['Content-Length']) === '2048',
    slot.uploadHeaders);
  check('carries an expiry', typeof slot.expiresAt === 'string', slot.expiresAt);

  const row = await prisma.media.findFirst({ where: { storageKey: slot.key } });
  check('row is PENDING until attached', row?.status === 'PENDING', row?.status);
  check('row holds no url column', row && !('url' in row) && !('thumbnailUrl' in row), Object.keys(row ?? {}));
  check('scan status starts PENDING', row?.scanStatus === 'PENDING', row?.scanStatus);

  // Attach it and read it back: the key must come back as a signed URL.
  const post = await api(u.token, 'POST', '/community/updates', {
    content: 'Signed media round trip', mediaKeys: [slot.key],
  });
  check('composer accepts the key', post.status === 201, { s: post.status, b: post.body });

  const media = post.body?.data?.media?.[0];
  check('serialised media exposes a url', typeof media?.url === 'string', media);
  check('url is signed', /X-Amz-Signature=/.test(media?.url ?? ''), media?.url?.slice(0, 140));
  check('and points at the bucket, not at this API',
    !/localhost|\/api\/v1\//.test(media?.url ?? ''), media?.url?.slice(0, 140));
  check('serialised media does not leak the storage key',
    !('storageKey' in (media ?? {})), Object.keys(media ?? {}));

  const attached = await prisma.media.findFirst({ where: { storageKey: slot.key } });
  check('attach flipped the row to ATTACHED', attached?.status === 'ATTACHED', attached?.status);

  // Another member's key must not be attachable.
  const other = await makeUser('media2');
  const stolen = await api(other.token, 'POST', '/community/updates', {
    content: 'Not mine', mediaKeys: [slot.key],
  });
  check('a key belonging to someone else is refused', stolen.status === 422 || stolen.status === 403, stolen.status);

  // A key that was never minted must read as a clean 422, not a 500.
  const ghost = await api(u.token, 'POST', '/community/updates', {
    content: 'Ghost key', mediaKeys: ['circl/community/nobody/never-existed.jpg'],
  });
  check('an unknown key → 422 MEDIA_NOT_FOUND',
    ghost.status === 422 && ghost.body?.error?.code === 'MEDIA_NOT_FOUND',
    { s: ghost.status, e: ghost.body?.error?.code });

  const nulls = await api(u.token, 'POST', '/community/updates', {
    content: 'Null key', mediaKeys: [null],
  });
  check('a null in mediaKeys → 400, never 500', nulls.status === 400, nulls.status);

  console.log('\n── 0.11.5 a real round trip to the bucket ───────────────────');
  const roundTripper = await makeUser('s3rt');
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex'); // a PNG signature, enough to be real bytes

  const mint = await api(roundTripper.token, 'POST', '/media/uploads', {
    purpose: 'COMMUNITY',
    files: [{ mimeType: 'image/png', byteSize: bytes.length }],
  });
  const rtSlot = mint.body?.data?.[0] ?? {};
  check('minted a presigned PUT', typeof rtSlot.uploadUrl === 'string', mint.status);
  check('the URL points at the bucket', /circl-dev-storage-s3\.s3\.eu-north-1\.amazonaws\.com/.test(rtSlot.uploadUrl ?? ''), rtSlot.uploadUrl?.slice(0, 90));

  // Exactly the two headers returned, and no Authorization.
  const put = await fetch(rtSlot.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': rtSlot.uploadHeaders['Content-Type'] },
    body: bytes,
  });
  check('S3 accepted the upload', put.status === 200, { status: put.status, body: (await put.text()).slice(0, 300) });
  check('and returned an ETag', !!put.headers.get('etag'), put.headers.get('etag'));

  // A deliberately wrong content type must be rejected: it is signed.
  const wrong = await fetch(rtSlot.uploadUrl, {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: bytes,
  });
  check('a Content-Type that was not signed is refused', wrong.status === 403, wrong.status);

  // Now the read leg: attach it and follow the signed URL.
  const rtPost = await api(roundTripper.token, 'POST', '/community/updates', {
    content: 'A real object in the real bucket', mediaKeys: [rtSlot.key],
  });
  const rtUrl = rtPost.body?.data?.media?.[0]?.url;
  check('the composer accepted it', rtPost.status === 201, rtPost.status);
  check('read URL is signed for the bucket', /X-Amz-Signature=/.test(rtUrl ?? ''), rtUrl?.slice(0, 100));

  const fetched = await fetch(rtUrl);
  const rtBody = Buffer.from(await fetched.arrayBuffer());
  check('the signed read returns 200', fetched.status === 200, { s: fetched.status, b: rtBody.toString().slice(0, 200) });
  check('and the exact bytes that were uploaded', rtBody.equals(bytes), { got: rtBody.length, want: bytes.length });

  // A tampered key must not be readable.
  const tampered = rtUrl.replace(/seed|-/, 'x');
  const bad = await fetch(tampered);
  check('a tampered signed URL is refused', bad.status === 403 || bad.status === 404, bad.status);


  await sweep();
  await finish();
})();
