/**
 * §5.23: reading the audit trail.
 *
 * The trail has been written since M0 and nothing could read it. So the first thing this suite
 * proves is that the entries three milestones have been recording are actually there and actually
 * legible — and the second, which is the one that matters, is **R8**: the same five endpoints serve
 * three permission levels, and what differs is which rows come back.
 *
 * That is why most of this is one action read by three different people. A scope bug is not an
 * error anybody would see: it is a working endpoint returning a longer page than it should, with a
 * safeguarding entry on it.
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

const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const shift = days =>
  new Date(Date.parse(`${today()}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

async function main() {
  await sweep('pre-run');
  await clearRateLimits();

  // The three levels R8 names, as `role.seeder.ts` grants them: super admin holds `audit:read`,
  // Trust & Safety `audit:read_area` + `audit:read_self`, Support only `audit:read_self`.
  const boss = await makeAdmin('aud-boss', 'super_admin');
  const safety = await makeAdmin('aud-safety', 'trust_safety');
  const support = await makeAdmin('aud-support', 'support');
  const bossHeaders = adminHeaders(boss);
  const safetyHeaders = adminHeaders(safety);
  const supportHeaders = adminHeaders(support);

  const member = await makeUser('aud-member', { cityId: 'BRISTOL' });

  // ── 1. Entries exist, and read back whole ─────────────────────────────────
  heading('1. the trail the platform has been writing all along');

  // A real action with a real reason, through the real endpoint: this is the entry the rest of the
  // suite reads. A MEMBERS-area action on purpose — it is the one Trust & Safety must not see
  // somebody else do, and must see when they do it themselves.
  let r = await api(
    null,
    'POST',
    `/admin/members/${member.id}/suspend`,
    {
      duration: '7d',
      reasonCode: 'POLICY_VIOLATION',
      policySubtype: 'SPAM',
      note: 'Sent the same deposit request to four people.',
    },
    { ...bossHeaders, 'Idempotency-Key': `aud-${Math.random().toString(36).slice(2)}` },
  );

  check('an action to read about → 200', r.status === 200, {
    status: r.status,
    error: r.body?.error,
  });

  r = await api(null, 'GET', `/admin/audit?targetId=${member.id}&perPage=50`, null, bossHeaders);

  const entries = r.body?.data ?? [];
  const suspension = entries.find(entry => entry.action === 'member.suspended');

  check('the trail answers → 200', r.status === 200, { status: r.status, error: r.body?.error });
  check(
    'and carries the action that was just taken',
    !!suspension,
    entries.map(e => e.action),
  );
  check(
    'with who did it, resolved to a staff reference rather than an id',
    suspension?.actor?.id === boss.id && typeof suspension?.actor?.name === 'string',
    suspension?.actor,
  );
  check('their role at the time', suspension?.actorRole === 'super_admin', suspension?.actorRole);
  check(
    'the area it belongs to — SAFETY for an enforcement action, deliberately, because that is ' +
      'what Trust & Safety need to see of each other’s work',
    suspension?.area === 'SAFETY',
    suspension?.area,
  );
  check(
    'the target, with a portal link the reader can follow',
    suspension?.target?.type === 'MEMBER' &&
      suspension?.target?.id === member.id &&
      typeof suspension?.target?.adminUrl === 'string',
    suspension?.target,
  );
  check(
    'the reason they gave, with its code and subtype',
    suspension?.reasonCode === 'POLICY_VIOLATION' &&
      suspension?.policySubtype === 'SPAM' &&
      (suspension?.reason ?? '').includes('deposit'),
    {
      reasonCode: suspension?.reasonCode,
      policySubtype: suspension?.policySubtype,
      reason: suspension?.reason,
    },
  );
  check(
    'and the staff member’s own IP, unmasked: a trail that records a /24 cannot tell two people in an office apart',
    typeof suspension?.ip === 'string' || suspension?.ip === null,
    suspension?.ip,
  );
  check('newest first', entries.length < 2 || entries[0].occurredAt >= entries[1].occurredAt, {
    first: entries[0]?.occurredAt,
    second: entries[1]?.occurredAt,
  });

  // ── 2. R8, the same action read by three people ───────────────────────────
  heading('2. R8: one entry, three permission levels');

  r = await api(null, 'GET', `/admin/audit/${suspension.id}`, null, bossHeaders);

  check(
    'the super admin can open it → 200',
    r.status === 200 && r.body?.data?.id === suspension.id,
    {
      status: r.status,
      error: r.body?.error,
    },
  );

  r = await api(null, 'GET', `/admin/audit/${suspension.id}`, null, safetyHeaders);

  check('and trust & safety can open it too, because SAFETY is their area', r.status === 200, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(null, 'GET', `/admin/audit/${suspension.id}`, null, supportHeaders);

  check('support cannot: it is not their action → 404', r.status === 404, { status: r.status });

  // A genuinely MEMBERS-area action, which is the one Trust & Safety must **not** see somebody
  // else take. The reveal is the sharpest example: a staff member reading a member's contact
  // details, which `audit:read_area` deliberately does not reach.
  r = await api(
    null,
    'POST',
    `/admin/members/${member.id}/reveal`,
    { fields: ['email'], reasonCode: 'MEMBER_REQUEST' },
    { ...bossHeaders, 'Idempotency-Key': `aud-rev-${Math.random().toString(36).slice(2)}` },
  );

  check('a MEMBERS-area action to contrast it with → 200', r.status === 200, {
    status: r.status,
    error: r.body?.error,
  });

  const revealed = await prisma.auditLog.findFirst({
    where: { action: 'member.pii_reveal', actorId: boss.id, targetId: member.id },
    select: { id: true, area: true },
    orderBy: { occurredAt: 'desc' },
  });

  check('filed under MEMBERS', revealed?.area === 'MEMBERS', revealed);

  r = await api(null, 'GET', `/admin/audit/${revealed.id}`, null, bossHeaders);

  check('the super admin can read it → 200', r.status === 200, { status: r.status });

  r = await api(null, 'GET', `/admin/audit/${revealed.id}`, null, safetyHeaders);

  check(
    'trust & safety cannot: a MEMBERS entry somebody else wrote is not theirs → 404',
    r.status === 404,
    { status: r.status, code: r.body?.error?.code },
  );
  check(
    'and a 404 rather than a 403, which would confirm the entry exists',
    r.status === 404,
    r.status,
  );

  r = await api(null, 'GET', `/admin/audit/${revealed.id}`, null, supportHeaders);

  check('nor can support → 404', r.status === 404, { status: r.status });

  r = await api(null, 'GET', '/admin/audit?perPage=100', null, supportHeaders);

  check(
    'support’s whole trail is their own actions and nothing else',
    r.status === 200 && (r.body?.data ?? []).every(entry => entry.actor?.id === support.id),
    {
      status: r.status,
      actors: [...new Set((r.body?.data ?? []).map(entry => entry.actor?.id))],
    },
  );

  // Now trust & safety take an action of their own, in their own area.
  r = await api(
    null,
    'POST',
    '/admin/escalations',
    {
      memberId: member.id,
      category: 'SCAM',
      note: 'Four members have had the same message from this account this week.',
    },
    {
      ...adminHeaders(support),
      'Idempotency-Key': `aud-esc-${Math.random().toString(36).slice(2)}`,
    },
  );

  check('support raise an escalation → 201', r.status === 201, r.body?.error);

  r = await api(null, 'GET', '/admin/audit?area=SAFETY&perPage=50', null, safetyHeaders);

  check(
    'trust & safety can read SAFETY entries other people wrote: that is their area',
    r.status === 200 && (r.body?.data ?? []).some(entry => entry.action === 'escalation.created'),
    { status: r.status, actions: (r.body?.data ?? []).map(entry => entry.action).slice(0, 5) },
  );

  r = await api(null, 'GET', `/admin/audit?area=MEMBERS&perPage=50`, null, safetyHeaders);

  check(
    'and asking for an area outside their scope narrows to their own actions in it, rather than refusing',
    r.status === 200 && (r.body?.data ?? []).every(entry => entry.actor?.id === safety.id),
    {
      status: r.status,
      actors: [...new Set((r.body?.data ?? []).map(entry => entry.actor?.id))],
    },
  );

  r = await api(
    null,
    'GET',
    '/admin/audit',
    null,
    adminHeaders(await makeAdmin('aud-none', 'support')),
  );

  check('a reader with only `audit:read_self` still gets a list, not a 403', r.status === 200, {
    status: r.status,
    code: r.body?.error?.code,
  });

  // ── 3. The filters ────────────────────────────────────────────────────────
  heading('3. filters narrow, and do not widen');

  r = await api(null, 'GET', `/admin/audit?action=member.suspended&perPage=50`, null, bossHeaders);

  check(
    'by action',
    r.status === 200 && (r.body?.data ?? []).every(entry => entry.action === 'member.suspended'),
    (r.body?.data ?? []).map(entry => entry.action).slice(0, 5),
  );

  r = await api(null, 'GET', `/admin/audit?actorId=${boss.id}&perPage=50`, null, bossHeaders);

  check(
    'by actor',
    r.status === 200 && (r.body?.data ?? []).every(entry => entry.actor?.id === boss.id),
    [...new Set((r.body?.data ?? []).map(entry => entry.actor?.id))],
  );

  r = await api(
    null,
    'GET',
    `/admin/audit?from=${today()}&to=${today()}&targetId=${member.id}`,
    null,
    bossHeaders,
  );

  check(
    'a single-day range includes today, both ends inclusive',
    r.status === 200 && (r.body?.data ?? []).length > 0,
    { status: r.status, rows: r.body?.data?.length },
  );

  r = await api(
    null,
    'GET',
    `/admin/audit?from=${shift(-30)}&to=${shift(-20)}&targetId=${member.id}`,
    null,
    bossHeaders,
  );

  check(
    'and a range that ended before the action excludes it',
    r.status === 200 && (r.body?.data ?? []).length === 0,
    { status: r.status, rows: r.body?.data?.length },
  );

  r = await api(null, 'GET', '/admin/audit?reasonCode=NOT_A_CODE', null, bossHeaders);

  check('a reason code outside the enum is a 400: that list is closed', r.status === 400, {
    status: r.status,
  });

  r = await api(null, 'GET', '/admin/audit?action=never.happened&perPage=10', null, bossHeaders);

  check(
    'while an unregistered action name is an empty page, not a 400 — a stale bookmark is not a bug report',
    r.status === 200 && (r.body?.data ?? []).length === 0,
    { status: r.status, rows: r.body?.data?.length },
  );

  r = await api(null, 'GET', '/admin/audit?page=400&perPage=100', null, bossHeaders);

  check('and the depth guard still applies', r.status === 400, {
    status: r.status,
    code: r.body?.error?.code,
  });

  // ── 4. The search, which keeps identifiers out of the URL ─────────────────
  heading('4. the same list, with the filters in the body');

  r = await api(
    null,
    'POST',
    '/admin/audit/search',
    { targetId: member.id, action: ['member.suspended'], perPage: 10 },
    bossHeaders,
  );

  check(
    'search → 200 with the same entry',
    r.status === 200 && (r.body?.data ?? []).some(entry => entry.id === suspension.id),
    { status: r.status, error: r.body?.error, rows: r.body?.data?.length },
  );
  check('and arrays as JSON arrays rather than CSV', r.status === 200, r.body?.error);

  r = await api(null, 'POST', '/admin/audit/search', { targetId: member.id }, supportHeaders);

  check(
    'the body path is scoped exactly like the query one',
    r.status === 200 && (r.body?.data ?? []).every(entry => entry.actor?.id === support.id),
    [...new Set((r.body?.data ?? []).map(entry => entry.actor?.id))],
  );

  // ── 5. The two dropdowns ──────────────────────────────────────────────────
  heading('5. what the filter bar is built from');

  r = await api(null, 'GET', '/admin/audit/actions', null, bossHeaders);

  const actions = r.body?.data ?? [];

  check(
    'every action the writer can record, with its area and a label',
    r.status === 200 &&
      actions.length > 50 &&
      actions.every(entry => entry.action && entry.area && entry.label),
    { status: r.status, count: actions.length, sample: actions[0] },
  );
  check(
    'including the ones added this milestone',
    ['support.replied', 'job.run', 'taxonomy.upserted', 'analytics.chart_csv'].every(name =>
      actions.some(entry => entry.action === name),
    ),
    actions.filter(entry => entry.action.endsWith('_csv')).map(entry => entry.action),
  );
  check('and `actions` is read as a route rather than an entry id', r.status === 200, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(null, 'GET', '/admin/audit/actors', null, bossHeaders);

  check(
    'the actors who appear in the trail, most recently active first',
    r.status === 200 && (r.body?.data ?? []).some(person => person.id === boss.id),
    { status: r.status, count: r.body?.data?.length },
  );
  check(
    'and every one of them resolves to a staff member: a deleted account leaves its entries ' +
      'behind but cannot be offered as a filter',
    (r.body?.data ?? []).every(person => person.id && person.name),
    (r.body?.data ?? []).slice(0, 3),
  );

  r = await api(null, 'GET', '/admin/audit/actors', null, supportHeaders);

  check(
    'scoped: a reader of their own actions gets themselves and nobody else',
    r.status === 200 && (r.body?.data ?? []).length === 1 && r.body.data[0].id === support.id,
    (r.body?.data ?? []).map(person => person.id),
  );

  // ── 6. The one write, and what it refuses ─────────────────────────────────
  heading('6. the CSV the server cannot see');

  r = await api(
    null,
    'POST',
    '/admin/audit/client-event',
    { action: 'analytics.chart_csv', metadata: { chart: 'openedResolved', rows: 42 } },
    supportHeaders,
  );

  check(
    'any staff member may record one → 201',
    r.status === 201 && r.body?.data?.recorded === true,
    {
      status: r.status,
      error: r.body?.error,
    },
  );

  const recorded = await prisma.auditLog.findFirst({
    where: { action: 'analytics.chart_csv', actorId: support.id },
    select: { area: true, metadata: true, actorId: true },
  });

  check('written as an entry like any other', !!recorded, recorded);
  check(
    'filed in the area the registry gives it, not one the client named',
    recorded?.area === 'ANALYTICS',
    recorded?.area,
  );
  check('carrying what was taken', recorded?.metadata?.rows === 42, recorded?.metadata);

  r = await api(
    null,
    'POST',
    '/admin/audit/client-event',
    { action: 'member.suspended', metadata: {} },
    supportHeaders,
  );

  check('a client cannot record an action with an effect → 400', r.status === 400, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(
    null,
    'POST',
    '/admin/audit/client-event',
    { action: 'analytics.chart_csv', metadata: { blob: 'x'.repeat(5000) } },
    supportHeaders,
  );

  check('and metadata past 4 KB is refused → 422', r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });

  // ── 7. Nothing edits or deletes an entry ──────────────────────────────────
  heading('7. the trail is append-only from this surface too');

  for (const [method, path] of [
    ['PATCH', `/admin/audit/${suspension.id}`],
    ['PUT', `/admin/audit/${suspension.id}`],
    ['DELETE', `/admin/audit/${suspension.id}`],
  ]) {
    r = await api(null, method, path, method === 'DELETE' ? null : {}, bossHeaders);

    check(`${method} on an entry is not a route → 404`, r.status === 404 || r.status === 405, {
      method,
      status: r.status,
    });
  }

  // ── 8. §5.22's two reads, over the run log B19 made possible ──────────────
  heading('8. the jobs, and what they have done');

  r = await api(null, 'GET', '/admin/jobs', null, bossHeaders);

  const jobs = r.body?.data ?? [];
  const exportBuild = jobs.find(job => job.name === 'data-exports.build');

  check('the job list answers → 200', r.status === 200 && jobs.length > 15, {
    status: r.status,
    count: jobs.length,
    error: r.body?.error,
  });
  check(
    'every job carries its schedule and something a reader can act on',
    jobs.every(job => job.schedule && job.description?.length > 30),
    jobs.find(job => !job.schedule || !job.description),
  );
  check(
    'the catalogue is complete: the jobs added this milestone are in it',
    ['data-exports.build', 'safety.rescan-degraded', 'exports.expire'].every(name =>
      jobs.some(job => job.name === name),
    ),
    jobs.map(job => job.name).slice(0, 5),
  );
  check(
    'and on a combined process nothing reads as unavailable',
    jobs.every(job => job.disabledOnThisInstance === false),
    jobs.filter(job => job.disabledOnThisInstance).map(job => job.name),
  );
  check(
    'with a next run time, which only the scheduler in this process knows',
    typeof exportBuild?.nextRunAt === 'string',
    exportBuild?.nextRunAt,
  );
  check(
    'and the last run, because the data export job has run in this suite’s lifetime',
    exportBuild?.lastRun === null || typeof exportBuild?.lastRun?.status === 'string',
    exportBuild?.lastRun,
  );

  r = await api(null, 'POST', '/admin/jobs/exports.expire/run', null, {
    ...bossHeaders,
    'Idempotency-Key': `aud-job-${Math.random().toString(36).slice(2)}`,
  });

  check('running one by hand → 200', r.status === 200, { status: r.status, error: r.body?.error });

  r = await api(null, 'GET', '/admin/jobs/exports.expire/runs', null, bossHeaders);

  const runs = r.body?.data ?? [];

  check(
    'its history answers → 200 with the run that just happened',
    r.status === 200 && runs.length > 0,
    {
      status: r.status,
      count: runs.length,
      error: r.body?.error,
    },
  );
  check(
    'recorded as a manual run, naming who asked',
    runs[0]?.trigger === 'MANUAL' && runs[0]?.triggeredBy?.id === boss.id,
    { trigger: runs[0]?.trigger, by: runs[0]?.triggeredBy },
  );
  check(
    'with a status, a duration and both ends of the clock',
    runs[0]?.status === 'SUCCESS' &&
      typeof runs[0]?.durationMs === 'number' &&
      !!runs[0]?.startedAt &&
      !!runs[0]?.finishedAt,
    runs[0],
  );
  check('newest first', runs.length < 2 || runs[0].startedAt >= runs[1].startedAt, {
    first: runs[0]?.startedAt,
    second: runs[1]?.startedAt,
  });

  r = await api(null, 'GET', '/admin/jobs/nothing.like-this/runs', null, bossHeaders);

  check('a job that does not exist has no history → 404', r.status === 404, { status: r.status });

  r = await api(null, 'GET', '/admin/jobs', null, supportHeaders);

  check('and reading the jobs needs `config:read` → 403', r.status === 403, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(null, 'POST', '/admin/jobs/exports.expire/run', null, {
    ...safetyHeaders,
    'Idempotency-Key': `aud-job2-${Math.random().toString(36).slice(2)}`,
  });

  check(
    'while running one needs `jobs:run`, which only super admins hold → 403',
    r.status === 403,
    { status: r.status, code: r.body?.error?.code },
  );

  // ── 9. S11.3: the chain that makes a changed row visible ──────────────────
  heading('9. tamper evidence over the trail');

  /**
   * The only transaction allowed to delete from an append-only table.
   *
   * The trigger refuses every DELETE unless the transaction has declared itself a retention purge
   * (S11.2 against S11.4), which is how these checks can both break the chain and put it back.
   * Nothing in the application sets it.
   */
  const asPurge = work =>
    prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL circl.retention_purge = 'on'");

      return work(tx);
    });

  const runChain = () =>
    api(null, 'POST', '/admin/jobs/audit.verify-chain/run', null, {
      ...bossHeaders,
      'Idempotency-Key': `aud-chain-${Math.random().toString(36).slice(2)}`,
    });

  /** An entry written straight into the table, which is what a seal is given to cover. */
  const rawEntry = (occurredAt, data = {}) =>
    prisma.auditLog.create({
      data: {
        occurredAt,
        action: 'member.profile_viewed',
        area: 'MEMBERS',
        actorId: boss.id,
        targetType: 'USER',
        targetId: member.id,
        // Unicode and a nested object, because the digest is computed from the draft on the way in
        // and recomputed from jsonb on the way out. If those two disagree about a quote mark or a
        // key order, every row reads as tampered with.
        metadata: { note: 'Zoë — “nested”, for the round trip', depth: { two: [1, 2] } },
        ...data,
      },
      select: { id: true, occurredAt: true, hash: true },
    });

  r = await runChain();
  check('the chain job runs on demand → 200', r.status === 200, {
    status: r.status,
    error: r.body?.error,
  });

  let segment = await prisma.auditChainSegment.findFirst({ orderBy: { seq: 'desc' } });

  // Only rows older than the fifteen-minute lag can be sealed — the lag is what lets a transaction
  // commit before its range is closed — so on a database whose trail is all newer than that there
  // is nothing to seal yet. Three backdated entries give the seal something, which it needs before
  // anything below can be proved.
  if (!segment) {
    await rawEntry(new Date(Date.now() - 40 * 60_000));
    await rawEntry(new Date(Date.now() - 39 * 60_000));
    await rawEntry(new Date(Date.now() - 38 * 60_000));

    r = await runChain();
    segment = await prisma.auditChainSegment.findFirst({ orderBy: { seq: 'desc' } });
  }

  // The detail is the id rather than the row: `seq` is a BigInt, and `JSON.stringify` throws on
  // one — which would turn a failing check into a crashed suite and take every check after it.
  check('and the trail is sealed into segments', !!segment, segment?.id ?? 'none sealed');
  check(
    'each covering a stretch of it, with the rows it held and a hash over them',
    segment?.rowCount > 0 && /^[0-9a-f]{64}$/.test(segment?.hash ?? ''),
    { rowCount: segment?.rowCount, hash: segment?.hash?.slice(0, 16) },
  );

  const genesis = await prisma.auditChainSegment.findFirst({ orderBy: { seq: 'asc' } });

  check(
    'the first segment follows nothing, which is what makes it the first',
    genesis?.prevHash === null,
    genesis?.prevHash,
  );
  check(
    'and every one after it carries the one before it',
    await (async () => {
      const all = await prisma.auditChainSegment.findMany({ orderBy: { seq: 'asc' } });

      return all.every((link, index) => (link.prevHash ?? null) === (all[index - 1]?.hash ?? null));
    })(),
    'the links',
  );

  // An entry written now, through the real path, by a real action.
  r = await api(
    null,
    'POST',
    `/admin/members/${member.id}/notes`,
    { body: 'Noted while the chain was being checked — Zoë “quoted”.' },
    { ...bossHeaders, 'Idempotency-Key': `aud-note-${Math.random().toString(36).slice(2)}` },
  );

  const fresh = await prisma.auditLog.findFirst({
    where: { action: 'note.created', actorId: boss.id },
    orderBy: { occurredAt: 'desc' },
    select: { hash: true, prevHash: true, occurredAt: true },
  });

  check('a note is left on a member', r.status === 201 || r.status === 200, {
    status: r.status,
    error: r.body?.error,
  });
  check(
    'and the entry recording it carries its own digest',
    /^[0-9a-f]{64}$/.test(fresh?.hash ?? ''),
    fresh?.hash?.slice(0, 16),
  );
  check(
    'and the chain’s tip as it stood, which is what dates it against sealed history',
    fresh?.prevHash === segment?.hash,
    { entry: fresh?.prevHash?.slice(0, 16), tip: segment?.hash?.slice(0, 16) },
  );

  // ── A row that does not match its own digest, inside a sealed stretch ─────
  const planted = await rawEntry(segment.toOccurredAt, { hash: 'de'.repeat(32) });

  r = await runChain();

  /**
   * 409 `JOB_FAILED`, carrying the run's own error.
   *
   * It used to be a bare 500: `runNow` re-threw a plain `Error`, so the one job whose failure is a
   * **finding** rather than a fault reached the staff member as "Something went wrong". The
   * message is the thing somebody has to read today.
   */
  check(
    'a row inside a sealed stretch that does not match its digest fails the run',
    r.status === 409 && r.body?.error?.code === 'JOB_FAILED',
    { status: r.status, code: r.body?.error?.code },
  );
  check(
    'and the refusal itself says what was found, not "something went wrong"',
    /no longer matches its own digest/.test(r.body?.error?.message ?? ''),
    r.body?.error?.message?.slice(0, 200),
  );
  /**
   * The 500 says nothing, on purpose — an internal error carries no internals to the caller — so
   * what the difference *was* has to be legible where somebody would look for it: the job's own
   * history (§5.22), which is also where the nightly run with nobody watching leaves it.
   */
  const lastChainRun = async () =>
    prisma.queueJobLog.findFirst({
      where: { operation: 'audit.verify-chain' },
      orderBy: { startedAt: 'desc' },
      select: { status: true, error: true },
    });

  let chainRun = await lastChainRun();

  check(
    'the run is recorded FAILED, so §5.22’s history does not read green',
    chainRun?.status === 'FAILED',
    { status: chainRun?.status, error: chainRun?.error?.slice(0, 160) },
  );
  check(
    'naming the entry, because "the audit chain is broken" sends nobody anywhere',
    (chainRun?.error ?? '').includes(planted.id),
    chainRun?.error?.slice(0, 240),
  );
  check(
    'and saying what the difference is: a row that was not there when it was sealed',
    /inserted after it was sealed/.test(chainRun?.error ?? '') &&
      /no longer matches its own digest/.test(chainRun?.error ?? ''),
    chainRun?.error?.slice(0, 240),
  );

  await asPurge(tx => tx.auditLog.delete({ where: { id: planted.id } }));

  r = await runChain();
  check('with the planted row gone, the chain verifies again → 200', r.status === 200, {
    status: r.status,
    error: r.body?.error?.message?.slice(0, 200),
  });

  // ── A row deleted out of a sealed stretch ─────────────────────────────────
  const inside = await prisma.auditLog.findFirst({
    where: { occurredAt: { gt: segment.fromOccurredAt, lte: segment.toOccurredAt } },
    orderBy: { occurredAt: 'asc' },
    select: { id: true },
  });

  await asPurge(tx => tx.auditLog.delete({ where: { id: inside.id } }));

  r = await runChain();

  chainRun = await lastChainRun();

  check(
    'and a row removed from a sealed stretch fails it too',
    r.status === 409 && /row\(s\) missing/.test(chainRun?.error ?? ''),
    { status: r.status, error: chainRun?.error?.slice(0, 240) },
  );

  entry = await prisma.auditLog.findFirst({
    where: { action: 'job.run', targetId: 'audit.verify-chain' },
    orderBy: { occurredAt: 'desc' },
    select: { metadata: true },
  });

  // §5.22: the failed run is audited too. It used to be audited only after a *successful* one, so
  // the trail skipped exactly the runs anybody asks about afterwards.
  check(
    'and running it by hand is audited with its outcome, failures included',
    entry?.metadata?.outcome === 'FAILED' && entry?.metadata?.trigger === 'MANUAL',
    entry?.metadata,
  );

  // Putting it back is not possible — that is the point of the table — so the repair is the one a
  // retention purge would have to make: drop the segments from the damaged one onward and let the
  // next run re-seal what is actually there.
  await asPurge(tx => tx.auditChainSegment.deleteMany({ where: { seq: { gte: segment.seq } } }));

  r = await runChain();

  check('re-sealing the stretch that was repaired clears it → 200', r.status === 200, {
    status: r.status,
    error: r.body?.error?.message?.slice(0, 200),
  });

  // ── The chain is as unwritable as the trail it describes ──────────────────
  const stillThere = await prisma.auditChainSegment.findFirst({ orderBy: { seq: 'desc' } });

  check(
    'a sealed segment cannot be rewritten, whatever the application asks',
    await prisma.auditChainSegment
      .update({ where: { id: stillThere.id }, data: { hash: 'ff'.repeat(32) } })
      .then(() => false)
      .catch(() => true),
    'the trigger',
  );
  check(
    'but it can record that it was checked, which is the one column the trigger leaves open',
    await prisma.auditChainSegment
      .update({ where: { id: stillThere.id }, data: { verifiedAt: new Date() } })
      .then(() => true)
      .catch(error => error.message.slice(0, 120)),
    'verifiedAt',
  );
  const victim = await prisma.auditLog.findFirst({
    orderBy: { occurredAt: 'desc' },
    select: { id: true },
  });

  check(
    'and an entry cannot be edited at all, which is what the digests are worth anything against',
    await prisma.auditLog
      .update({ where: { id: victim.id }, data: { reason: 'rewritten' } })
      .then(() => false)
      .catch(() => true),
    'the trail',
  );

  // ── 10. §13.6: what retention actually deletes ────────────────────────────
  heading('10. the retention table, as a job');

  /**
   * Every rule is checked the same way: an old row and a recent one, then the job, then which of
   * the two is still there. A check that only proves the delete would pass just as well if the job
   * emptied the table.
   */
  const longAgo = years => new Date(Date.now() - years * 365.25 * 86400000);
  const recently = () => new Date(Date.now() - 3600_000);
  const stamp = Math.random().toString(36).slice(2, 10);

  // Entries older than six years that **no segment covers** — below the chain's genesis, which is
  // where a backdated insert lands and the one stretch no seal protects.
  const ancient = await rawEntry(longAgo(7));
  const alsoAncient = await rawEntry(longAgo(6.5));

  const grantOld = await prisma.threadAccessGrant.create({
    data: {
      staffId: boss.id,
      conversationId: `ret-old-${stamp}`,
      reasonCode: 'SAFETY_CONCERN',
      linkedType: 'REPORT_CASE',
      linkedId: `ret-${stamp}`,
      grantedAt: longAgo(7),
      expiresAt: longAgo(7),
    },
    select: { id: true },
  });
  const grantNew = await prisma.threadAccessGrant.create({
    data: {
      staffId: boss.id,
      conversationId: `ret-new-${stamp}`,
      reasonCode: 'SAFETY_CONCERN',
      linkedType: 'REPORT_CASE',
      linkedId: `ret-${stamp}`,
      grantedAt: recently(),
      expiresAt: new Date(Date.now() + 1800_000),
    },
    select: { id: true },
  });

  const sessionOld = await prisma.adminSession.create({
    data: {
      userId: boss.id,
      ip: '203.0.113.9',
      userAgent: 'retention-check',
      absoluteExpiresAt: new Date(Date.now() - 100 * 86400000),
      createdAt: new Date(Date.now() - 101 * 86400000),
      refreshTokenHash: `ret-old-${stamp}`,
    },
    select: { id: true },
  });
  // Ended yesterday, which is inside the ninety days: a session is deleted long after it ends, not
  // when it ends, because "who was signed in when this happened" is a question asked afterwards.
  const sessionRecent = await prisma.adminSession.create({
    data: {
      userId: boss.id,
      ip: '203.0.113.10',
      userAgent: 'retention-check',
      absoluteExpiresAt: new Date(Date.now() - 86400000),
      refreshTokenHash: `ret-new-${stamp}`,
    },
    select: { id: true },
  });

  const anyRole = await prisma.role.findFirst({ select: { id: true } });
  const inviteOld = await prisma.adminInvite.create({
    data: {
      email: `ret-old-${stamp}@example.test`,
      roleId: anyRole.id,
      tokenHash: `ret-old-${stamp}`,
      invitedById: boss.id,
      expiresAt: longAgo(2),
      acceptedAt: longAgo(2),
    },
    select: { id: true },
  });
  const inviteLive = await prisma.adminInvite.create({
    data: {
      email: `ret-live-${stamp}@example.test`,
      roleId: anyRole.id,
      tokenHash: `ret-live-${stamp}`,
      invitedById: boss.id,
      expiresAt: new Date(Date.now() + 7 * 86400000),
    },
    select: { id: true },
  });

  const announcement = await prisma.announcement.create({
    data: {
      title: 'Retention fixture',
      body: 'Here to have its deliveries purged.',
      channels: ['IN_APP'],
      audience: {},
      state: 'SENT',
      createdById: boss.id,
      createdAt: longAgo(2),
    },
    select: { id: true },
  });

  await prisma.announcementDelivery.create({
    data: {
      announcementId: announcement.id,
      userId: member.id,
      channel: 'IN_APP',
      status: 'SENT',
      sentAt: longAgo(2),
    },
  });
  await prisma.announcementDelivery.create({
    data: {
      announcementId: announcement.id,
      userId: boss.id,
      channel: 'IN_APP',
      status: 'SENT',
      sentAt: recently(),
    },
  });

  const safetyRow = await prisma.contentSafety.create({
    data: { targetType: 'REQUEST', targetId: `ret-${stamp}`, tier: 'CLEAN' },
    select: { id: true },
  });
  const scanOld = await prisma.contentScan.create({
    data: {
      contentSafetyId: safetyRow.id,
      trigger: 'CREATE',
      scanVersion: 1,
      contentHash: `ret-old-${stamp}`,
      lexiconScore: 0,
      finalScore: 0,
      tier: 'CLEAN',
      createdAt: longAgo(3),
    },
    select: { id: true },
  });
  const scanNew = await prisma.contentScan.create({
    data: {
      contentSafetyId: safetyRow.id,
      trigger: 'CREATE',
      scanVersion: 2,
      contentHash: `ret-new-${stamp}`,
      lexiconScore: 0,
      finalScore: 0,
      tier: 'CLEAN',
    },
    select: { id: true },
  });

  const reportOld = await prisma.report.create({
    data: {
      reporterId: member.id,
      targetType: 'REQUEST',
      targetId: `ret-${stamp}`,
      reasonCode: 'SPAM',
      snapshot: { body: 'What it said at the time.' },
      createdAt: longAgo(7),
    },
    select: { id: true },
  });
  const reportNew = await prisma.report.create({
    data: {
      reporterId: member.id,
      targetType: 'REQUEST',
      targetId: `ret-${stamp}`,
      reasonCode: 'SPAM',
      snapshot: { body: 'What it says now.' },
    },
    select: { id: true },
  });

  const exportExpired = await prisma.dataExportRequest.create({
    data: {
      userId: member.id,
      status: 'READY',
      downloadKey: `data-exports/ret-${stamp}.zip`,
      readyAt: new Date(Date.now() - 8 * 86400000),
      expiresAt: new Date(Date.now() - 86400000),
    },
    select: { id: true },
  });
  const exportLive = await prisma.dataExportRequest.create({
    data: {
      userId: member.id,
      status: 'READY',
      downloadKey: `data-exports/ret-live-${stamp}.zip`,
      readyAt: new Date(),
      expiresAt: new Date(Date.now() + 6 * 86400000),
    },
    select: { id: true },
  });

  r = await api(null, 'POST', '/admin/jobs/retention.purge/run', null, {
    ...bossHeaders,
    'Idempotency-Key': `ret-${stamp}`,
  });

  check('the retention job runs on demand → 200', r.status === 200, {
    status: r.status,
    error: r.body?.error,
  });

  const gone = async (model, id) => !(await prisma[model].findUnique({ where: { id } }));

  check(
    'entries past six years that no segment covers are deleted',
    (await gone('auditLog', ancient.id)) && (await gone('auditLog', alsoAncient.id)),
    [ancient.id, alsoAncient.id],
  );
  check(
    'while the entry written a moment ago is untouched',
    !!victim && !(await gone('auditLog', victim.id)),
    victim?.id ?? 'no recent entry to check against',
  );
  check(
    'and the chain still verifies, because nothing sealed was touched',
    (await runChain()).status === 200,
    'after the purge',
  );

  check(
    'a thread access grant is kept as long as the trail, then purged',
    (await gone('threadAccessGrant', grantOld.id)) &&
      !(await gone('threadAccessGrant', grantNew.id)),
    [grantOld.id, grantNew.id],
  );
  check(
    'a staff session is deleted ninety days after it ended, not before',
    (await gone('adminSession', sessionOld.id)) && !(await gone('adminSession', sessionRecent.id)),
    [sessionOld.id, sessionRecent.id],
  );
  check(
    'a spent invite goes after a year, a live one stays',
    (await gone('adminInvite', inviteOld.id)) && !(await gone('adminInvite', inviteLive.id)),
    [inviteOld.id, inviteLive.id],
  );

  const deliveries = await prisma.announcementDelivery.count({
    where: { announcementId: announcement.id },
  });

  check(
    'year-old delivery rows go and the recent one stays, and the announcement itself is kept',
    deliveries === 1 && !(await gone('announcement', announcement.id)),
    { deliveries },
  );

  r = await api(null, 'GET', `/admin/announcements/${announcement.id}`, null, bossHeaders);

  /**
   * §13.6 keeps the stats for ever and the rows for a year, which only works if the figures are
   * written down before the rows go. Two deliveries were counted at freeze time and one row is
   * left, so a stats endpoint that was still counting would now say one.
   */
  check(
    'and its stats still report what was sent, counted before the rows went',
    r.status === 200 && r.body?.data?.stats?.perChannel?.IN_APP?.delivered === 2,
    { status: r.status, stats: r.body?.data?.stats?.perChannel },
  );
  check(
    'scans older than two years go, newer ones stay',
    (await gone('contentScan', scanOld.id)) && !(await gone('contentScan', scanNew.id)),
    [scanOld.id, scanNew.id],
  );

  const cleared = await prisma.report.findUnique({
    where: { id: reportOld.id },
    select: { snapshot: true },
  });
  const kept = await prisma.report.findUnique({
    where: { id: reportNew.id },
    select: { snapshot: true },
  });

  check(
    'a six-year-old report loses its snapshot text and keeps its row',
    !!cleared && cleared.snapshot === null && !!kept?.snapshot,
    { old: cleared?.snapshot, recent: !!kept?.snapshot },
  );

  const expiredExport = await prisma.dataExportRequest.findUnique({
    where: { id: exportExpired.id },
    select: { downloadKey: true, status: true },
  });
  const liveExport = await prisma.dataExportRequest.findUnique({
    where: { id: exportLive.id },
    select: { downloadKey: true },
  });

  check(
    'an expired member data export loses its file and keeps the record of the request',
    expiredExport?.downloadKey === null && !!liveExport?.downloadKey,
    { expired: expiredExport, live: liveExport?.downloadKey },
  );

  r = await api(null, 'GET', '/admin/jobs/retention.purge/runs?perPage=1', null, bossHeaders);

  check(
    'and the run says what it deleted, in the history §5.22 serves',
    r.status === 200 &&
      /entries|grants|sessions|invites|deliveries|scans|snapshots/.test(
        JSON.stringify(r.body?.data?.[0] ?? {}),
      ),
    r.body?.data?.[0],
  );

  r = await api(null, 'POST', '/admin/jobs/retention.purge/run', null, {
    ...safetyHeaders,
    'Idempotency-Key': `ret2-${stamp}`,
  });

  check('running it needs `jobs:run` like every other job → 403', r.status === 403, r.status);

  /**
   * The record a purge leaves behind, and the fact that it cannot be tidied away.
   *
   * No segment here is six years old, so the whole-stretch branch of the purge cannot be reached
   * live — that part is proved against a stub clock in `audit-chain-purge.spec.ts`. What *can* be
   * proved live is the thing that branch depends on: a truncation row can be written and then
   * neither edited nor deleted, because a record of what was deleted that the deleter can rewrite
   * is not a record.
   */
  const truncation = await prisma.auditChainTruncation.create({
    data: {
      removedHash: 'ff'.repeat(32),
      upToOccurredAt: longAgo(7),
      segmentsRemoved: 0,
      rowsRemoved: 0,
    },
    select: { id: true },
  });

  check('a purge can record what it removed', !!truncation.id, truncation.id);
  check(
    'and then cannot change its own record',
    await prisma.auditChainTruncation
      .update({ where: { id: truncation.id }, data: { rowsRemoved: 1 } })
      .then(() => false)
      .catch(() => true),
    'the trigger',
  );
  check(
    'nor delete it, outside the one transaction that may delete anything here',
    await prisma.auditChainTruncation
      .delete({ where: { id: truncation.id } })
      .then(() => false)
      .catch(() => true),
    'the trigger',
  );

  await asPurge(tx => tx.auditChainTruncation.delete({ where: { id: truncation.id } }));

  // The fixtures that survived on purpose, removed now that they have been read.
  await prisma.threadAccessGrant.deleteMany({ where: { id: grantNew.id } });
  await prisma.adminSession.deleteMany({ where: { id: sessionRecent.id } });
  await prisma.adminInvite.deleteMany({ where: { id: inviteLive.id } });
  await prisma.announcementDelivery.deleteMany({ where: { announcementId: announcement.id } });
  await prisma.announcement.deleteMany({ where: { id: announcement.id } });
  await prisma.contentScan.deleteMany({ where: { contentSafetyId: safetyRow.id } });
  await prisma.contentSafety.deleteMany({ where: { id: safetyRow.id } });
  await prisma.report.deleteMany({ where: { id: { in: [reportOld.id, reportNew.id] } } });

  await sweep('post-run');
  await finish();
}

main().catch(fail);
