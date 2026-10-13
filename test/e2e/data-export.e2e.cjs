/**
 * B16: the subject access request that used to never finish.
 *
 * `DataExportRequest` rows have been created since the member-facing button shipped, and nothing
 * built them — `markReady` had no caller. Under UK GDPR that is worse than not having the button:
 * the member exercised a right, we recorded that they did, and nothing happened.
 *
 * So the thing this suite asserts is completion, end to end: a member asks, the job builds, the
 * row goes READY with a key and a seven-day expiry, and the audit trail says so with no actor —
 * because a schedule did it, not a person. The archive's own validity (a real `unzip` reading
 * every file) is proven in `zip.spec.ts`, where it can be checked byte by byte.
 */
const {
  adminHeaders,
  api,
  check,
  clearRateLimits,
  fail,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);

const requestFor = userId =>
  prisma.dataExportRequest.findFirst({ where: { userId }, orderBy: { requestedAt: 'desc' } });

const runBuilder = headers =>
  api(null, 'POST', '/admin/jobs/data-exports.build/run', null, headers);

async function main() {
  await sweep('pre-run');
  await clearRateLimits();

  const admin = await makeAdmin('export-admin', 'super_admin');
  const headers = adminHeaders(admin);

  // ── 1. A member asks for their data ──────────────────────────────────────
  heading('1. the request, and the job that finishes it');

  const member = await makeUser('export-member', { cityId: 'BRISTOL' });

  // Something to export, so the archive is not empty of the member's own content.
  let r = await api(member.token, 'POST', '/community/requests', {
    title: 'Looking for a plumber who can come on a Saturday',
    description: 'The kitchen tap has been dripping for a week and I work weekdays.',
    categoryCode: 'VISA_DOCS',
    cityId: 'BRISTOL',
  });

  check('the member has posted something → 201', r.status === 201, r.body?.error);

  r = await api(member.token, 'POST', '/users/me/data-export');

  // 202: accepted, and the answer arrives by email rather than in this response.
  check('asking for their data → 202', r.status === 202, {
    status: r.status,
    error: r.body?.error,
  });

  let row = await requestFor(member.id);

  check('records a pending request', row?.status === 'PENDING', row?.status);
  check('with nothing built yet', row?.downloadKey === null && row?.readyAt === null, {
    key: row?.downloadKey,
    readyAt: row?.readyAt,
  });
  check('and no attempt made', row?.attempts === 0, row?.attempts);

  r = await api(member.token, 'POST', '/users/me/data-export');

  check(
    'a second tap while it is pending is a 409, not a second request',
    r.status === 409 && r.body?.error?.code === 'EXPORT_ALREADY_PENDING',
    { status: r.status, code: r.body?.error?.code },
  );

  r = await runBuilder(headers);

  check('the builder runs → 200', r.status === 200, { status: r.status, error: r.body?.error });

  row = await requestFor(member.id);

  check('and the request is ready', row?.status === 'READY', row?.status);
  check('with an object key to download', typeof row?.downloadKey === 'string', row?.downloadKey);
  check(
    'keyed on the request rather than the member, so an old key is not guessable',
    (row?.downloadKey ?? '').includes(row?.id),
    row?.downloadKey,
  );
  check('stamped ready', !!row?.readyAt, row?.readyAt);
  check('counted as one attempt', row?.attempts === 1, row?.attempts);

  const sevenDays = 7 * 86_400_000;
  const held = row?.expiresAt ? row.expiresAt.getTime() - row.readyAt.getTime() : 0;

  check('and kept for seven days (§13.7)', Math.abs(held - sevenDays) < 60_000, {
    heldMs: held,
    wantMs: sevenDays,
  });

  // ── 2. What the member is told ───────────────────────────────────────────
  heading('2. the member’s own view of it');

  r = await api(member.token, 'GET', '/users/me/data-export');

  check('their status reads READY', r.body?.data?.status === 'READY', r.body?.data);
  check(
    'and carries no download url: delivery is the emailed link (§13.7)',
    r.body?.data?.downloadUrl === null,
    r.body?.data?.downloadUrl,
  );
  check('with the expiry they can read', !!r.body?.data?.expiresAt, r.body?.data?.expiresAt);

  // ── 3. The trail ─────────────────────────────────────────────────────────
  heading('3. the audit entry, with nobody as the actor');

  const trail = await prisma.auditLog.findMany({
    where: { targetId: member.id, action: { startsWith: 'member.data_export' } },
    select: { action: true, actorId: true, area: true, metadata: true },
    orderBy: { occurredAt: 'asc' },
  });

  const ready = trail.find(entry => entry.action === 'member.data_export_ready');

  check(
    'the export records that it completed',
    !!ready,
    trail.map(entry => entry.action),
  );
  check(
    'with no actor, because a schedule did it rather than a person',
    ready?.actorId === null,
    ready?.actorId,
  );
  check('filed under MEMBERS', ready?.area === 'MEMBERS', ready?.area);
  check(
    'and names the request it was for',
    ready?.metadata?.requestId === row?.id,
    ready?.metadata,
  );
  check(
    'with all ten documents in the archive, and bytes in it',
    ready?.metadata?.files === 10 && ready?.metadata?.bytes > 0,
    ready?.metadata,
  );

  // ── 4. The job is idempotent, and the retry limit holds ──────────────────
  heading('4. nothing is built twice, and nothing is retried for ever');

  const before = await requestFor(member.id);

  await runBuilder(headers);

  const after = await requestFor(member.id);

  check(
    'a second pass leaves the finished export alone',
    after?.readyAt?.getTime() === before?.readyAt?.getTime() &&
      after?.downloadKey === before?.downloadKey,
    { before: before?.readyAt, after: after?.readyAt },
  );

  const stuck = await makeUser('export-stuck', { cityId: 'BRISTOL' });

  await api(stuck.token, 'POST', '/users/me/data-export');
  await prisma.dataExportRequest.updateMany({
    where: { userId: stuck.id },
    data: { attempts: 3 },
  });

  await runBuilder(headers);

  const exhausted = await requestFor(stuck.id);

  check(
    'a request that has used its three attempts is left alone, not retried every five minutes',
    exhausted?.status === 'PENDING' && exhausted?.attempts === 3,
    { status: exhausted?.status, attempts: exhausted?.attempts },
  );

  // ── 5. The staff path ends the same way ──────────────────────────────────
  heading('5. an export staff start on a member’s behalf');

  const subject = await makeUser('export-subject', { cityId: 'BRISTOL' });

  r = await api(
    null,
    'POST',
    `/admin/members/${subject.id}/data-export`,
    { reasonCode: 'LEGAL_GDPR' },
    headers,
  );

  check('staff can start one → 200', r.status === 200, { status: r.status, error: r.body?.error });

  await runBuilder(headers);

  const staffStarted = await requestFor(subject.id);

  check('and it finishes like any other', staffStarted?.status === 'READY', staffStarted?.status);
  check(
    'delivered to the member and not to the staff member who asked',
    staffStarted?.downloadKey?.includes(subject.id),
    staffStarted?.downloadKey,
  );

  // ── 6. The run log ───────────────────────────────────────────────────────
  heading('6. B19: the job run writes its own history');

  const runs = await prisma.queueJobLog.findMany({
    where: { operation: 'data-exports.build' },
    select: { status: true, trigger: true, userId: true, durationMs: true, metadata: true },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  check('the runs are recorded at all, which they never used to be', runs.length > 0, runs.length);
  check('as successes', runs[0]?.status === 'SUCCESS', runs[0]?.status);
  check('triggered by hand', runs[0]?.trigger === 'MANUAL', runs[0]?.trigger);
  check('naming who asked', runs[0]?.userId === admin.id, {
    got: runs[0]?.userId,
    want: admin.id,
  });
  check('with how long it took', typeof runs[0]?.durationMs === 'number', runs[0]?.durationMs);
  check('and what it did', typeof runs[0]?.metadata?.summary === 'string', runs[0]?.metadata);

  const audited = await prisma.auditLog.findFirst({
    where: { action: 'job.run', actorId: admin.id },
    select: { targetId: true, metadata: true },
  });

  check(
    'and running a job by hand is audited, which it also never used to be',
    audited?.targetId === 'data-exports.build',
    audited,
  );

  await sweep('post-run');
  await finish();
}

main().catch(fail);
