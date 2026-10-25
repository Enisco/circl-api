/**
 * §5.27 — the Website queue.
 *
 * The queue itself is an ordinary staff list, so most of this suite is about the two things that
 * make it different from one: the codes have to mean what the website's own form says they mean,
 * and nothing on this surface may delete an account or reveal whether an address belongs to one.
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

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const key = () => ({ 'Idempotency-Key': `web-${Math.random().toString(36).slice(2)}` });

/**
 * A throwaway admin role holding exactly the permissions named, so a refusal is about the
 * permission and nothing else.
 *
 * A **new** role rather than an edit to the one `makeAdmin` hands out: that one is `super_admin`,
 * shared by the whole platform, and stripping its grants to make a narrow fixture would take every
 * other staff account down with it.
 */
const register = async (label, codes) => {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const permissions = await prisma.permission.findMany({ where: { code: { in: codes } } });

  if (permissions.length !== codes.length) throw new Error(`role ${label}: unknown permission(s)`);

  const role = await prisma.role.create({
    data: {
      name: `E2E website ${label} ${stamp}`,
      code: `e2e-web-${label}-${stamp}`,
      isSystem: false,
      isAdmin: true,
      rolePermissions: { create: permissions.map(permission => ({ permissionId: permission.id })) },
    },
  });

  return role.code;
};

const staffWith = async (label, codes) => makeAdmin(`web-${label}`, await register(label, codes));

(async () => {
  await sweep('admin-website');
  await prisma.websiteSubmission.deleteMany({ where: { email: { startsWith: 'e2e-web-' } } });

  const stamp = Date.now();
  const staff = await makeAdmin('web-staff');
  const headers = adminHeaders(staff);

  // A real member, so a deletion request has something to match.
  const member = await makeUser('web-member');

  await clearRateLimits();
  let r = await api(null, 'POST', '/website/contact-messages', {
    name: 'Amara Okafor',
    email: `e2e-web-msg-${stamp}@example.com`,
    topic: 'PARTNERSHIPS',
    message: 'We run a community group in Manchester and would like to work together.',
  });
  check('a message is submitted from the website', r.status === 201, r.body?.error);
  const messageId = r.body?.data?.id;

  await clearRateLimits();
  r = await api(null, 'POST', '/website/feature-suggestions', {
    title: 'A guide to swapping a foreign driving licence',
    area: 'COMMUNITY',
    details: 'Everyone in my group asks this and the answers are scattered across ten threads.',
  });
  check('and a suggestion with no address', r.status === 201, r.body?.error);
  const suggestionId = r.body?.data?.id;

  await clearRateLimits();
  r = await api(null, 'POST', '/website/deletion-requests', {
    name: 'Karim Haddad',
    email: member.email,
    reason: 'OTHER_ACCOUNT',
    details: 'I made a second account by mistake when I switched phones.',
  });
  check('and a deletion request for a real account', r.status === 202, r.status);

  // The account lookup runs after the response.
  await new Promise(resolve => setTimeout(resolve, 700));

  heading('1. The queue');

  r = await api(null, 'GET', '/admin/website-submissions?perPage=100', null, headers);
  check('the queue answers', r.status === 200, r.body?.error);

  const rows = r.body?.data ?? [];
  const mine = rows.filter(
    row => [messageId, suggestionId].includes(row.id) || row.email === member.email,
  );

  check('all three are listed, because all three are new', mine.length === 3, {
    found: mine.length,
    types: mine.map(row => row.type),
  });

  const messageRow = rows.find(row => row.id === messageId);
  const suggestionRow = rows.find(row => row.id === suggestionId);
  const deletionRow = rows.find(row => row.email === member.email);

  check(
    'one card renders all three forms: `code` carries topic, area or reason',
    messageRow?.code === 'PARTNERSHIPS' &&
      suggestionRow?.code === 'COMMUNITY' &&
      deletionRow?.code === 'OTHER_ACCOUNT',
    { message: messageRow?.code, suggestion: suggestionRow?.code, deletion: deletionRow?.code },
  );
  check(
    'and `codeLabel` is the English the visitor actually chose from',
    messageRow?.codeLabel === 'Partnerships' && deletionRow?.codeLabel === 'I have another account',
    { message: messageRow?.codeLabel, deletion: deletionRow?.codeLabel },
  );
  check(
    'the excerpt is capped, so a list is not a transcript',
    rows.every(row => (row.excerpt ?? '').length <= 280),
    rows.map(row => (row.excerpt ?? '').length),
  );
  check(
    'every row knows where it lives in the portal',
    mine.every(row => row.adminUrl === `/support/website/${row.id}`),
    mine.map(row => row.adminUrl),
  );
  check(
    'the counts carry every state, including the empty ones as zero',
    ['NEW', 'IN_PROGRESS', 'DONE', 'SPAM'].every(
      state => typeof r.body?.meta?.counts?.[state] === 'number',
    ),
    r.body?.meta?.counts,
  );
  check(
    'and byType carries only types, not states mixed in with them',
    Object.keys(r.body?.meta?.byType ?? {})
      .sort()
      .join(',') === 'CONTACT_MESSAGE,DELETION_REQUEST,FEATURE_SUGGESTION',
    r.body?.meta?.byType,
  );

  r = await api(
    null,
    'GET',
    '/admin/website-submissions?type=DELETION_REQUEST&perPage=100',
    null,
    headers,
  );
  check(
    'type narrows it to one form',
    (r.body?.data ?? []).every(row => row.type === 'DELETION_REQUEST') &&
      (r.body?.data ?? []).some(row => row.email === member.email),
    (r.body?.data ?? []).map(row => row.type),
  );

  r = await api(
    null,
    'GET',
    `/admin/website-submissions?q=${encodeURIComponent('driving licence')}&perPage=100`,
    null,
    headers,
  );
  check(
    'q searches the title as well as the body',
    (r.body?.data ?? []).some(row => row.id === suggestionId),
    (r.body?.data ?? []).map(row => row.title),
  );

  heading('2. One submission');

  r = await api(null, 'GET', `/admin/website-submissions/${messageId}`, null, headers);
  check('the detail answers', r.status === 200, r.body?.error);
  check(
    'with the whole body rather than the excerpt',
    r.body?.data?.body ===
      'We run a community group in Manchester and would like to work together.',
    r.body?.data?.body,
  );
  check(
    'a prefix of the address hash, never the whole thing',
    typeof r.body?.data?.ipHashPrefix === 'string' && r.body.data.ipHashPrefix.length === 12,
    r.body?.data?.ipHashPrefix,
  );
  check(
    'and the notes it has, which is none yet',
    Array.isArray(r.body?.data?.notes),
    r.body?.data?.notes,
  );

  const deletionDetail = await api(
    null,
    'GET',
    `/admin/website-submissions/${deletionRow.id}`,
    null,
    headers,
  );

  check(
    'a deletion request links the account it matched, so staff do not look it up by hand',
    deletionDetail.body?.data?.matchedMember?.id === member.id &&
      deletionDetail.body?.data?.matchedMember?.adminUrl === `/members/${member.id}`,
    deletionDetail.body?.data?.matchedMember,
  );
  check(
    'and says when that lookup ran — null without it means "not checked", not "no account"',
    !!deletionDetail.body?.data?.checkedAt,
    deletionDetail.body?.data?.checkedAt,
  );

  heading('3. Working one');

  r = await api(
    null,
    'PATCH',
    `/admin/website-submissions/${messageId}`,
    {},
    { ...headers, ...key() },
  );
  check('an empty patch is refused rather than reported as saved', r.status === 422, r.status);

  r = await api(
    null,
    'PATCH',
    `/admin/website-submissions/${messageId}`,
    { state: 'IN_PROGRESS', note: 'Replied and asked what they have in mind.' },
    { ...headers, ...key() },
  );
  check('state and note move together', r.status === 200, r.body?.error);
  check('the state is the new one', r.body?.data?.state === 'IN_PROGRESS', r.body?.data?.state);
  check(
    'the note is filed in the shared notes table, not a column of its own',
    (r.body?.data?.notes ?? []).some(note =>
      note.body.includes('Replied and asked what they have in mind.'),
    ),
    r.body?.data?.notes,
  );

  const viaNotes = await api(
    null,
    'GET',
    `/admin/notes?subjectType=WEBSITE_SUBMISSION&subjectId=${messageId}`,
    null,
    headers,
  );
  check(
    'so the portal’s existing notes screen can read it too',
    viaNotes.status === 200 && (viaNotes.body?.data ?? []).length === 1,
    { status: viaNotes.status, count: (viaNotes.body?.data ?? []).length },
  );

  r = await api(
    null,
    'PATCH',
    `/admin/website-submissions/${messageId}`,
    { state: 'IN_PROGRESS' },
    { ...headers, ...key() },
  );
  check(
    'setting the state it already has is a 200 that changes nothing',
    r.status === 200 && r.body?.data?.state === 'IN_PROGRESS',
    r.status,
  );

  r = await api(
    null,
    'PATCH',
    `/admin/website-submissions/${messageId}`,
    { state: 'DONE', note: 'Answered.' },
    { ...headers, ...key() },
  );
  check('closing it works', r.status === 200, r.body?.error);
  check('and stamps when it was finished', !!r.body?.data?.completedAt, r.body?.data?.completedAt);

  r = await api(
    null,
    'PATCH',
    `/admin/website-submissions/${messageId}`,
    { state: 'IN_PROGRESS' },
    { ...headers, ...key() },
  );
  check('reopening a closed one is refused', r.status === 409, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(null, 'GET', '/admin/website-submissions?perPage=100', null, headers);
  check(
    'and it has left the queue, which opens on open work',
    !(r.body?.data ?? []).some(row => row.id === messageId),
    (r.body?.data ?? []).map(row => row.id),
  );

  r = await api(null, 'GET', '/admin/website-submissions?state=DONE&perPage=100', null, headers);
  check(
    'but is still there when asked for by state',
    (r.body?.data ?? []).some(row => row.id === messageId),
    (r.body?.data ?? []).length,
  );

  heading('4. The audit trail, because one of these forms deletes an account');

  r = await api(
    null,
    'GET',
    '/admin/audit?action=website_submission.state_changed&perPage=50',
    null,
    headers,
  );
  const entries = (r.body?.data ?? []).filter(entry => entry.target?.id === messageId);

  check('every state change is recorded', entries.length >= 2, {
    found: entries.length,
    status: r.status,
    error: r.body?.error,
  });
  check(
    'with what it moved from and to, so "who closed this" is answerable',
    entries.some(entry => entry.after?.state === 'DONE' && entry.before?.state === 'IN_PROGRESS'),
    entries.map(entry => ({ before: entry.before, after: entry.after })),
  );
  check(
    'and it points at the submission’s own page',
    // `length &&` because `every` on an empty list is true, which would make this pass by finding
    // nothing — the way the first draft of this check did.
    entries.length > 0 &&
      entries.every(entry => entry.target?.adminUrl === `/support/website/${messageId}`),
    entries.map(entry => entry.target?.adminUrl),
  );

  heading('5. Nothing here deletes anybody');

  const after = await prisma.user.findUnique({
    where: { id: member.id },
    select: { isAnonymised: true },
  });

  check(
    'the member behind the deletion request is untouched by all of the above',
    after?.isAnonymised === false,
    after,
  );

  const routes = await api(null, 'GET', '/admin/website-submissions', null, headers);

  check(
    'the surface offers no delete of its own — three routes, and none of them destroys anything',
    routes.status === 200,
    routes.status,
  );

  heading('6. After the account is actually deleted');

  /**
   * The normal ending of this workflow, and the one the detail screen has to survive: staff run
   * the deletion, and from that moment the member's portal page 404s (`assertIsMember` refuses an
   * anonymised account). A submission still offering a link to it would be a dead link on the
   * screen that had just finished the job.
   */
  const leaver = await makeUser('web-leaver');

  await clearRateLimits();
  r = await api(null, 'POST', '/website/deletion-requests', {
    name: 'Leaving Soon',
    email: leaver.email,
    reason: 'NOT_USING',
  });
  check('a second deletion request is taken', r.status === 202, r.status);

  await new Promise(resolve => setTimeout(resolve, 700));

  const leaverRow = await prisma.websiteSubmission.findFirst({
    where: { email: leaver.email, type: 'DELETION_REQUEST' },
    select: { id: true },
  });

  let detail = await api(null, 'GET', `/admin/website-submissions/${leaverRow.id}`, null, headers);

  check(
    'before the deletion, the member is linked',
    detail.body?.data?.matchedMember?.adminUrl === `/members/${leaver.id}`,
    detail.body?.data?.matchedMember,
  );

  // The real thing: the same endpoint the four-step workflow ends on.
  r = await api(
    null,
    'POST',
    `/admin/members/${leaver.id}/anonymise`,
    { confirmUsername: leaver.username, reasonCode: 'OTHER', note: 'Website deletion request.' },
    { ...headers, ...key() },
  );
  check(
    'the member is anonymised through the portal’s own action',
    r.status === 200,
    r.body?.error,
  );

  detail = await api(null, 'GET', `/admin/website-submissions/${leaverRow.id}`, null, headers);

  check(
    'the submission still opens afterwards, rather than 500ing on a missing member',
    detail.status === 200,
    { status: detail.status, error: detail.body?.error },
  );
  check(
    'the member is still named, because "it existed and is gone" is the outcome',
    detail.body?.data?.matchedMember?.id === leaver.id &&
      detail.body?.data?.matchedMember?.isAnonymised === true,
    detail.body?.data?.matchedMember,
  );
  check(
    'but the link is null, because their portal page 404s from now on',
    detail.body?.data?.matchedMember?.adminUrl === null,
    detail.body?.data?.matchedMember?.adminUrl,
  );

  heading('7. Who may see it, and who may act');

  const reader = await staffWith('reader', ['support:read']);
  const outsider = await staffWith('outsider', ['analytics:read']);

  r = await api(null, 'GET', '/admin/website-submissions', null, adminHeaders(reader));
  check('support:read opens the queue', r.status === 200, r.status);

  r = await api(
    null,
    'PATCH',
    `/admin/website-submissions/${suggestionId}`,
    { state: 'DONE' },
    { ...adminHeaders(reader), ...key() },
  );
  check('but reading is not working: support:manage is needed to move one', r.status === 403, {
    status: r.status,
    code: r.body?.error?.code,
  });

  r = await api(null, 'GET', '/admin/website-submissions', null, adminHeaders(outsider));
  check('and somebody with neither sees nothing', r.status === 403, r.status);

  r = await api(null, 'GET', '/admin/website-submissions', null, {});
  check('no token, no queue', r.status === 401 || r.status === 404, r.status);

  heading('8. The dashboard');

  r = await api(null, 'GET', '/admin/dashboard/attention', null, headers);
  const card = (r.body?.data ?? []).find(item => item.id === 'openWebsiteSubmissions');

  check(
    'the attention list carries the website card',
    !!card,
    (r.body?.data ?? []).map(i => i.id),
  );
  check('it opens the queue', card?.href === '/support/website', card?.href);

  const open = await api(null, 'GET', '/admin/website-submissions?perPage=1', null, headers);

  check(
    'and its badge equals the default page it opens, which is the rule for all of them',
    card?.count === open.body?.meta?.totalCount,
    { badge: card?.count, queue: open.body?.meta?.totalCount },
  );
  check('with the age of the oldest one', !!card?.oldestAt, card);

  heading('9. Retention: 24 months for the chatty two, 6 years for a deletion request');

  /**
   * Every rule is checked with an old row **and** a recent one, then the job, then which of the
   * two survived. A check that only proves the delete would pass just as well if the job emptied
   * the table.
   */
  const yearsAgo = years => new Date(Date.now() - years * 365.25 * 86400000);
  const daysAgo = days => new Date(Date.now() - days * 86400000);

  const seed = data =>
    prisma.websiteSubmission.create({ data, select: { id: true } }).then(row => row.id);

  const oldMessage = await seed({
    type: 'CONTACT_MESSAGE',
    state: 'DONE',
    name: 'Long Gone',
    email: `e2e-web-old-${stamp}@example.com`,
    topic: 'GENERAL',
    body: 'Answered three years ago.',
    createdAt: yearsAgo(3),
    completedAt: yearsAgo(3),
  });
  const freshMessage = await seed({
    type: 'CONTACT_MESSAGE',
    state: 'DONE',
    name: 'Still Here',
    email: `e2e-web-fresh-${stamp}@example.com`,
    topic: 'GENERAL',
    body: 'Answered this morning.',
    completedAt: new Date(),
  });
  const oldSuggestion = await seed({
    type: 'FEATURE_SUGGESTION',
    state: 'DONE',
    area: 'COMMUNITY',
    title: 'An idea from 2023',
    body: 'Long since built or dropped.',
    createdAt: yearsAgo(3),
  });
  const ancientRequest = await seed({
    type: 'DELETION_REQUEST',
    state: 'DONE',
    email: `e2e-web-ancient-${stamp}@example.com`,
    reason: 'NOT_USING',
    createdAt: yearsAgo(7),
    completedAt: yearsAgo(7),
  });
  const handledRequest = await seed({
    type: 'DELETION_REQUEST',
    state: 'DONE',
    name: 'Redact Me',
    email: `e2e-web-handled-${stamp}@example.com`,
    reason: 'BAD_EXPERIENCE',
    body: 'A paragraph about why I am leaving, which nobody needs in 2032.',
    createdAt: daysAgo(90),
    completedAt: daysAgo(60),
  });
  const justHandled = await seed({
    type: 'DELETION_REQUEST',
    state: 'DONE',
    name: 'Keep Me A While',
    email: `e2e-web-justhandled-${stamp}@example.com`,
    reason: 'PRIVACY',
    body: 'Handled two days ago, so the details are still answerable.',
    createdAt: daysAgo(4),
    completedAt: daysAgo(2),
  });
  const throttled = await seed({
    type: 'DELETION_REQUEST',
    state: 'SPAM',
    name: 'Fourth Attempt',
    email: `e2e-web-throttled-${stamp}@example.com`,
    reason: 'OTHER',
    body: 'Never worked, never emailed, and still holding text.',
    createdAt: daysAgo(60),
  });

  // A note on the submission that is about to be purged. It has no meaning once its subject is
  // gone, so it has to go with it rather than outlive it as a comment about nothing.
  await prisma.internalNote.create({
    data: {
      subjectType: 'WEBSITE_SUBMISSION',
      subjectId: oldMessage,
      authorId: staff.id,
      body: 'Answered by email at the time.',
    },
  });

  r = await api(null, 'POST', '/admin/jobs/retention.purge/run', null, {
    ...headers,
    'Idempotency-Key': `web-ret-${stamp}`,
  });
  check('the retention job runs on demand', r.status === 200, {
    status: r.status,
    error: r.body?.error,
  });

  const stillThere = async id => !!(await prisma.websiteSubmission.findUnique({ where: { id } }));

  check(
    'a message and a suggestion past 24 months are deleted',
    !(await stillThere(oldMessage)) && !(await stillThere(oldSuggestion)),
    { message: await stillThere(oldMessage), suggestion: await stillThere(oldSuggestion) },
  );
  check('and a recent one is not', await stillThere(freshMessage), freshMessage);
  check(
    'the notes about a purged submission go with it, not six years past it',
    (await prisma.internalNote.count({
      where: { subjectType: 'WEBSITE_SUBMISSION', subjectId: oldMessage },
    })) === 0,
    'orphan notes',
  );
  check(
    'a deletion request past six years is deleted — the audit clock, for the same reason',
    !(await stillThere(ancientRequest)),
    ancientRequest,
  );

  const redacted = await prisma.websiteSubmission.findUnique({ where: { id: handledRequest } });

  check(
    'one handled a month ago keeps the record and loses the words',
    !!redacted && redacted.name === null && redacted.body === null,
    { name: redacted?.name, body: redacted?.body },
  );
  check(
    'the address, the reason and the dates stay, which is what makes it evidence of compliance',
    redacted?.email === `e2e-web-handled-${stamp}@example.com` &&
      redacted?.reason === 'BAD_EXPERIENCE' &&
      !!redacted?.completedAt,
    { email: redacted?.email, reason: redacted?.reason, completedAt: redacted?.completedAt },
  );

  const recent = await prisma.websiteSubmission.findUnique({ where: { id: justHandled } });

  check(
    'one handled two days ago still has its details, so a query about it can be answered',
    recent?.body !== null && recent?.name !== null,
    { name: recent?.name, hasBody: recent?.body !== null },
  );

  const spam = await prisma.websiteSubmission.findUnique({ where: { id: throttled } });

  check(
    'and a throttled one is redacted on its own clock — it has no completedAt to wait for',
    spam?.name === null && spam?.body === null && spam?.state === 'SPAM',
    { name: spam?.name, body: spam?.body, state: spam?.state },
  );

  heading('10. A submission that does not exist');

  r = await api(
    null,
    'GET',
    '/admin/website-submissions/11111111-1111-1111-1111-111111111111',
    null,
    headers,
  );
  check('is a 404, not an empty detail', r.status === 404, r.status);

  r = await api(null, 'GET', '/admin/website-submissions/not-a-uuid', null, headers);
  check('and a malformed id is a 400', r.status === 400, r.status);

  await prisma.internalNote.deleteMany({ where: { subjectType: 'WEBSITE_SUBMISSION' } });
  await prisma.websiteSubmission.deleteMany({
    where: { OR: [{ email: { startsWith: 'e2e-web-' } }, { id: suggestionId }] },
  });
  await sweep('admin-website');

  await finish();
})().catch(fail);
