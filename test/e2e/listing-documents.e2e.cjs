'use strict';

/**
 * §2.9's supporting documents: the evidence behind a gated profession.
 *
 * A member who wants to offer immigration advice uploads one to five documents showing they are
 * qualified, and a reviewer reads them. That replaced checking regulators' registers by hand.
 *
 * These are the most sensitive files on the platform — certificates with home addresses on them —
 * so most of what is asserted here is about handling them carefully: the bytes decide the type, EXIF
 * comes off before the file is stored for good, one listing owns a document, Support cannot open
 * one, and a superseded one stops being readable.
 */

const {
  adminHeaders,
  api,
  check,
  fail,
  finish,
  jpegWithExif,
  makeAdmin,
  makeUser,
  prisma,
  realPdf,
  sweep,
  uploadDocument,
} = require('./harness.cjs');

const GATED = 'IMMIGRATION';
const OPEN = 'TECH_SOFTWARE';

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const key = () => ({
  'Idempotency-Key': `e2e-doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
});

const listingBody = (overrides = {}) => ({
  professionTitle: 'Immigration paperwork help',
  experienceLevel: 'MID_LEVEL',
  about: 'I help people with visa applications and settled status paperwork in Manchester.',
  categoryCodes: [GATED],
  cityId: 'MANCHESTER',
  consentAccepted: true,
  ...overrides,
});

async function main() {
  console.log('═══ test listing-documents ═══');

  const adviser = await makeUser('doc-adviser');
  const coder = await makeUser('doc-coder');
  const other = await makeUser('doc-other');
  const staff = await makeAdmin('doc-reviewer', 'super_admin');
  const support = await makeAdmin('doc-support', 'support');
  const headers = adminHeaders(staff);

  // ── 1. PDFs, for this purpose and no other ───────────────────────────────
  heading('1. a PDF is accepted here and nowhere else');

  const asDocument = await api(adviser.token, 'POST', '/media/uploads', {
    purpose: 'VERIFICATION',
    files: [{ mimeType: 'application/pdf', byteSize: 2048, fileName: 'cert.pdf' }],
  });

  check(
    'a PDF is accepted for VERIFICATION',
    asDocument.status === 201,
    asDocument.status || asDocument.body,
  );
  check(
    'and the ticket carries the id the listing will need',
    typeof asDocument.body?.data?.[0]?.id === 'string',
    asDocument.body?.data?.[0],
  );
  check(
    'alongside the key, which is what photos use',
    typeof asDocument.body?.data?.[0]?.key === 'string',
    asDocument.body?.data?.[0],
  );
  check(
    'and the key is under the private verification prefix',
    (asDocument.body?.data?.[0]?.key ?? '').startsWith('circl/verification/'),
    asDocument.body?.data?.[0]?.key,
  );

  const asPost = await api(adviser.token, 'POST', '/media/uploads', {
    purpose: 'COMMUNITY',
    files: [{ mimeType: 'application/pdf', byteSize: 2048 }],
  });

  // A PDF is a program as much as a document. The one place one is accepted is the one place a
  // human opens it deliberately, behind staff auth, from a private prefix, as an attachment.
  check('but refused for a community post', asPost.status === 422, asPost.status);
  check(
    'naming the field rather than failing opaquely',
    (asPost.body?.error?.details ?? []).some(entry => entry.field === 'files[0].mimeType'),
    asPost.body?.error,
  );

  // ── 2. A gated profession needs documents ────────────────────────────────
  heading('2. a gated profession needs 1 to 5 documents');

  const none = await api(adviser.token, 'POST', '/professionals/listings', listingBody());

  check('submitting with none is refused', none.status === 400, none.status);
  check('with its own code', none.body?.error?.code === 'DOCUMENTS_REQUIRED', none.body?.error);
  check(
    'naming documentIds',
    (none.body?.error?.details ?? []).some(entry => entry.field === 'documentIds'),
    none.body?.error,
  );

  const sixIds = [];

  for (let i = 0; i < 6; i += 1) {
    const doc = await uploadDocument(adviser.token, { fileName: `cert-${i}.pdf` });

    sixIds.push(doc.id);
  }

  const tooMany = await api(
    adviser.token,
    'POST',
    '/professionals/listings',
    listingBody({ documentIds: sixIds }),
  );

  check('six is too many', tooMany.status === 400, tooMany.status);
  check(
    'with its own code',
    tooMany.body?.error?.code === 'TOO_MANY_DOCUMENTS',
    tooMany.body?.error,
  );

  // ── 3. The bytes decide the type ─────────────────────────────────────────
  heading('3. the bytes decide, not the declared type');

  // Declared as a PNG, actually a PDF. Stored and served back as an image, whatever the browser
  // did with it next would be the platform's problem.
  const liar = await uploadDocument(adviser.token, {
    mimeType: 'image/png',
    bytes: realPdf(1),
    fileName: 'not-really-a-png.png',
  });
  const lying = await api(
    adviser.token,
    'POST',
    '/professionals/listings',
    listingBody({ documentIds: [liar.id] }),
  );

  check('a file that is not what it claims is refused', lying.status === 422, lying.status);
  check('as not usable', lying.body?.error?.code === 'DOCUMENT_NOT_USABLE', lying.body?.error);

  const rejectedRow = await prisma.media.findUnique({
    where: { id: liar.id },
    select: { scanStatus: true },
  });

  // Treated exactly like an infected file, so a second attempt cannot attach it either.
  check(
    'and marked so nothing can attach it later',
    rejectedRow?.scanStatus === 'INFECTED',
    rejectedRow,
  );

  const again = await api(
    adviser.token,
    'POST',
    '/professionals/listings',
    listingBody({ documentIds: [liar.id] }),
  );

  check('a second attempt with it is refused too', again.status === 422, again.status);

  // ── 4. Somebody else's document ──────────────────────────────────────────
  heading('4. a document belongs to the member who uploaded it');

  const theirs = await uploadDocument(other.token, { fileName: 'someone-elses.pdf' });
  const borrowed = await api(
    adviser.token,
    'POST',
    '/professionals/listings',
    listingBody({ documentIds: [theirs.id] }),
  );

  check('another member’s document cannot be attached', borrowed.status === 422, borrowed.status);
  check(
    'and the refusal does not confirm it exists',
    borrowed.body?.error?.code === 'DOCUMENT_NOT_USABLE' &&
      /could not be found/.test(borrowed.body?.error?.message ?? ''),
    borrowed.body?.error,
  );

  // ── 5. A submission that works ───────────────────────────────────────────
  heading('5. a submission with its documents');

  const certificate = await uploadDocument(adviser.token, {
    pages: 3,
    fileName: 'IAA-registration.pdf',
  });
  const photo = await uploadDocument(adviser.token, {
    mimeType: 'image/jpeg',
    bytes: jpegWithExif(),
    fileName: 'insurance-photo.jpg',
  });

  const created = await api(
    adviser.token,
    'POST',
    '/professionals/listings',
    listingBody({ documentIds: [certificate.id, photo.id] }),
  );

  check('the listing is created', created.status === 201, created.status || created.body);

  const listingId = created.body?.data?.listing?.id;
  const review = created.body?.data?.listing?.review;

  check('it is pending', review?.state === 'PENDING', review?.state);
  check('and not public', review?.isPublic === false, review?.isPublic);
  check(
    'the member sees their own documents back',
    review?.documents?.length === 2,
    review?.documents,
  );
  check(
    'with the names they gave them, in the order they sent',
    review?.documents?.[0]?.fileName === 'IAA-registration.pdf' &&
      review?.documents?.[1]?.fileName === 'insurance-photo.jpg',
    review?.documents?.map(doc => doc.fileName),
  );
  check(
    'and a size and a type, but no URL',
    typeof review?.documents?.[0]?.sizeBytes === 'number' &&
      review?.documents?.[0]?.mimeType === 'application/pdf' &&
      !('url' in (review?.documents?.[0] ?? {})),
    review?.documents?.[0],
  );

  const stored = await prisma.media.findMany({
    where: { ownerType: 'LISTING_DOCUMENT', ownerId: listingId },
    select: { id: true, pageCount: true, mimeType: true, byteSize: true, storageKey: true },
    orderBy: { position: 'asc' },
  });

  check('both are attached to the listing', stored.length === 2, stored.length);
  check(
    'the PDF’s page count was read off its page tree',
    stored[0]?.pageCount === 3,
    stored[0]?.pageCount,
  );

  // ── 6. EXIF comes off ────────────────────────────────────────────────────
  heading('6. the photo’s location data is gone');

  const uploadedBytes = jpegWithExif();

  check('the file as uploaded had GPS in it', uploadedBytes.includes('GPSLatitude'), true);

  // A phone writes the coordinates of wherever the photo was taken — for a photo of a certificate,
  // usually somebody's home.
  const photoRow = stored.find(row => row.mimeType === 'image/jpeg');

  check(
    'and the stored file is smaller, because the EXIF block came off',
    photoRow && photoRow.byteSize < uploadedBytes.length,
    { stored: photoRow?.byteSize, uploaded: uploadedBytes.length },
  );

  // ── 7. The reviewer's side ───────────────────────────────────────────────
  heading('7. what the reviewer sees');

  const queue = await api(
    null,
    'GET',
    '/admin/professional-reviews?perPage=100',
    undefined,
    headers,
  );
  const row = (queue.body?.data ?? []).find(entry => entry.id === listingId);

  check('the row says how many documents there are', row?.documentCount === 2, row?.documentCount);

  const detail = await api(
    null,
    'GET',
    `/admin/professional-reviews/${listingId}`,
    undefined,
    headers,
  );

  check(
    'the detail lists them',
    detail.body?.data?.documents?.length === 2,
    detail.body?.data?.documents,
  );
  check(
    'with the name, type, size, page count and when it arrived',
    (() => {
      const doc = detail.body?.data?.documents?.[0];

      return (
        doc?.fileName === 'IAA-registration.pdf' &&
        doc?.mimeType === 'application/pdf' &&
        typeof doc?.sizeBytes === 'number' &&
        doc?.pageCount === 3 &&
        typeof doc?.uploadedAt === 'string'
      );
    })(),
    detail.body?.data?.documents?.[0],
  );
  check(
    'and no URL anywhere near them',
    !JSON.stringify(detail.body?.data?.documents ?? []).includes('http'),
    detail.body?.data?.documents,
  );
  check(
    'the regulator checklist is gone, because the documents are the evidence now',
    (detail.body?.data?.gatedCategories ?? []).every(entry => !('credentialBodies' in entry)),
    detail.body?.data?.gatedCategories,
  );

  // ── 8. Opening one ───────────────────────────────────────────────────────
  heading('8. opening a document');

  const file = await api(
    null,
    'GET',
    `/admin/professional-reviews/${listingId}/documents/${certificate.id}`,
    undefined,
    headers,
    { raw: true },
  );

  check('a reviewer can open it', file.status === 200, file.status);

  const supportTry = await api(
    null,
    'GET',
    `/admin/professional-reviews/${listingId}/documents/${certificate.id}`,
    undefined,
    adminHeaders(support),
  );

  // Support reads the queue but does not open identity papers.
  check('Support cannot', supportTry.status === 403, supportTry.status);

  const strange = await api(
    null,
    'GET',
    `/admin/professional-reviews/${listingId}/documents/${theirs.id}`,
    undefined,
    headers,
  );

  check(
    'a document from another listing is a 404, not somebody else’s file',
    strange.status === 404,
    strange.status,
  );

  const viewed = await prisma.auditLog.findFirst({
    where: { action: 'listing.document_viewed', targetId: listingId },
    select: { id: true, metadata: true, actorId: true },
  });

  check('the view is on the audit trail', !!viewed, viewed);
  check('naming the document', viewed?.metadata?.documentId === certificate.id, viewed?.metadata);
  check('and who looked', viewed?.actorId === staff.id, viewed?.actorId);

  await api(
    null,
    'GET',
    `/admin/professional-reviews/${listingId}/documents/${certificate.id}`,
    undefined,
    headers,
  );

  // Paging through a six-page PDF should be one entry, not six.
  check(
    'a second look inside fifteen minutes writes no second entry',
    (await prisma.auditLog.count({
      where: { action: 'listing.document_viewed', targetId: listingId, actorId: staff.id },
    })) === 1,
    await prisma.auditLog.count({
      where: { action: 'listing.document_viewed', targetId: listingId },
    }),
  );

  // ── 9. Resubmission ──────────────────────────────────────────────────────
  heading('9. a decline, then a resubmission');

  await api(null, 'POST', `/admin/professional-reviews/${listingId}/claim`, {}, headers);
  await api(
    null,
    'POST',
    `/admin/professional-reviews/${listingId}/decide`,
    {
      outcome: 'REJECTED',
      reasonCode: 'SAFETY_CONCERN',
      note: 'The certificate does not name a registration number.',
      memberMessage: 'Please upload a document showing your IAA registration number.',
    },
    { ...headers, ...key() },
  );

  const declined = await api(adviser.token, 'GET', '/professionals/me');
  const declinedReview = (declined.body?.data?.listing ?? declined.body?.data)?.review;

  check(
    'the member reads the reviewer’s words',
    declinedReview?.state === 'REJECTED',
    declinedReview?.state,
  );
  check(
    'and their documents are still listed, so the form opens on them',
    declinedReview?.documents?.length === 2,
    declinedReview?.documents,
  );

  const replacement = await uploadDocument(adviser.token, { fileName: 'IAA-F2026-1234.pdf' });
  const resubmitted = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    documentIds: [certificate.id, replacement.id],
    about: 'I help with visa applications. IAA registration F2026-1234, Manchester based.',
  });

  check(
    'the resubmission is accepted',
    resubmitted.status === 200,
    resubmitted.status || resubmitted.body,
  );
  check(
    'it is pending again',
    resubmitted.body?.data?.review?.state === 'PENDING',
    resubmitted.body?.data?.review,
  );
  check(
    'with the new set, not the old one plus the new',
    resubmitted.body?.data?.review?.documents?.length === 2,
    resubmitted.body?.data?.review?.documents?.map(doc => doc.fileName),
  );

  const supersededRow = await prisma.media.findUnique({
    where: { id: photo.id },
    select: { supersededAt: true, ownerId: true },
  });

  // Kept, not deleted: it was the evidence behind a decision, and an appeal about that decision is
  // an appeal about these files. `retention.purge-documents` removes it ninety days on.
  check(
    'the dropped one is superseded rather than deleted',
    !!supersededRow?.supersededAt,
    supersededRow,
  );
  check(
    'and still attached, so the record holds',
    supersededRow?.ownerId === listingId,
    supersededRow?.ownerId,
  );

  const gone = await api(
    null,
    'GET',
    `/admin/professional-reviews/${listingId}/documents/${photo.id}`,
    undefined,
    headers,
  );

  check(
    'but no longer openable: a reviewer decides a submission, and it is not in this one',
    gone.status === 404,
    gone.status,
  );

  const afterDetail = await api(
    null,
    'GET',
    `/admin/professional-reviews/${listingId}`,
    undefined,
    headers,
  );

  check(
    'and the detail shows only the current submission',
    afterDetail.body?.data?.documents?.length === 2 &&
      !afterDetail.body?.data?.documents.some(doc => doc.id === photo.id),
    afterDetail.body?.data?.documents?.map(doc => doc.fileName),
  );

  check(
    'a superseded document cannot be re-attached',
    (
      await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
        documentIds: [photo.id],
      })
    ).status === 422,
  );

  // ── 10. An edit that is not a resubmission ───────────────────────────────
  heading('10. a price change is not a resubmission');

  const priceOnly = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    priceFrom: 7500,
  });

  // `documentIds` absent means "leave them alone". Checked against what is attached rather than
  // against nothing, or every price change on a gated listing would be refused for having none.
  check(
    'it is accepted without documentIds',
    priceOnly.status === 200,
    priceOnly.status || priceOnly.body,
  );
  check(
    'and the documents are untouched',
    priceOnly.body?.data?.review?.documents?.length === 2,
    priceOnly.body?.data?.review?.documents,
  );

  // ── 10b. Swapping a document is a resubmission ───────────────────────────
  heading('10b. swapping an approved listing’s documents re-opens the review');

  await api(null, 'POST', `/admin/professional-reviews/${listingId}/claim`, {}, headers);
  await api(
    null,
    'POST',
    `/admin/professional-reviews/${listingId}/decide`,
    { outcome: 'APPROVED', reasonCode: 'CORRECTION', note: 'Registration number checked.' },
    { ...headers, ...key() },
  );

  const approved = await api(adviser.token, 'GET', '/professionals/me');

  check(
    'it is approved and live',
    (approved.body?.data?.listing ?? approved.body?.data)?.review?.state === 'APPROVED',
    (approved.body?.data?.listing ?? approved.body?.data)?.review,
  );

  const swapped = await uploadDocument(adviser.token, { fileName: 'different-paper.pdf' });
  const afterSwap = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    documentIds: [swapped.id],
  });

  // The documents are part of what was approved — a reviewer read *those* papers. Without this a
  // member approved on a genuine certificate could swap it for anything and stay live: the same
  // hole as letting an approved listing rewrite its own about paragraph, one field across.
  check(
    'changing them alone sends it back',
    afterSwap.status === 200,
    afterSwap.status || afterSwap.body,
  );
  check(
    'to PENDING, and out of sight while it waits',
    afterSwap.body?.data?.review?.state === 'PENDING' &&
      afterSwap.body?.data?.review?.isPublic === false,
    afterSwap.body?.data?.review,
  );

  const unchanged = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    documentIds: [swapped.id],
  });

  check(
    'but re-sending the same set is not a change',
    unchanged.body?.data?.review?.state === 'PENDING',
    unchanged.body?.data?.review,
  );

  // ── 11. An ungated profession takes none ─────────────────────────────────
  heading('11. an ungated profession takes none, and keeps none');

  const spare = await uploadDocument(coder.token, { fileName: 'unnecessary.pdf' });
  const unwanted = await api(
    coder.token,
    'POST',
    '/professionals/listings',
    listingBody({
      categoryCodes: [OPEN],
      professionTitle: 'React developer',
      about: 'I build web apps for small businesses in Manchester, mostly React and Node.',
      documentIds: [spare.id],
    }),
  );

  // Refused rather than ignored: accepting files the platform has no reason to hold, and then
  // holding them, is how a data-minimisation promise quietly stops being true.
  check('sending documents anyway is refused', unwanted.status === 400, unwanted.status);
  check(
    'with its own code',
    unwanted.body?.error?.code === 'DOCUMENTS_NOT_REQUIRED',
    unwanted.body?.error,
  );

  const plain = await api(
    coder.token,
    'POST',
    '/professionals/listings',
    listingBody({
      categoryCodes: [OPEN],
      professionTitle: 'React developer',
      about: 'I build web apps for small businesses in Manchester, mostly React and Node.',
    }),
  );

  check('without them it is created', plain.status === 201, plain.status || plain.body);
  check(
    'and live immediately',
    plain.body?.data?.listing?.review === null,
    plain.body?.data?.listing?.review,
  );

  // ── 12. Leaving the gated profession lets the documents go ───────────────
  heading('12. switching to an ungated profession drops the documents');

  const moved = await api(adviser.token, 'PATCH', `/professionals/listings/${listingId}`, {
    categoryCodes: [OPEN],
    professionTitle: 'Backend engineer',
    about: 'I build APIs. Ten years of Node and Postgres, Manchester based.',
  });

  check('the change is accepted', moved.status === 200, moved.status || moved.body);
  check(
    'and there is nothing left to review',
    moved.body?.data?.review === null,
    moved.body?.data?.review,
  );

  const left = await prisma.media.count({
    where: { ownerType: 'LISTING_DOCUMENT', ownerId: listingId, supersededAt: null },
  });

  check('no document is part of a current submission any more', left === 0, left);
  check(
    'but they are still on record until the retention window closes',
    (await prisma.media.count({ where: { ownerType: 'LISTING_DOCUMENT', ownerId: listingId } })) >
      0,
  );

  await sweep('listing-documents');
  await finish();
}

main().catch(fail);
