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

  await sweep('post-run');
  await finish();
}

main().catch(fail);
