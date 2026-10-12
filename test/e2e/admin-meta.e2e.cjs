/* §5.27 Meta: the vocabularies the portal renders, who work can be assigned to, and the command
 * palette.
 *
 * None of these five routes had an end-to-end check. Three of them serve the lists the portal draws
 * its dropdowns from, which is the quiet kind of endpoint: nothing fails when it drifts, the portal
 * simply starts offering a value this API rejects. The other two are new. */
const {
  adminHeaders,
  api,
  check,
  fail,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

(async () => {
  await sweep('pre-run');

  const admin = await makeAdmin('am-admin');
  const headers = adminHeaders(admin);

  console.log('\n── 5.27 Vocabularies ────────────────────────────────────────');

  let res = await api(null, 'GET', '/admin/meta/reason-codes', null, headers);
  check('reason codes answer', res.status === 200, res.body?.error);
  check(
    'with a label beside every code, so the portal holds no copy to drift from',
    (res.body?.data?.reasonCodes ?? []).length > 0 &&
      res.body.data.reasonCodes.every(entry => entry.code && entry.label),
    res.body?.data?.reasonCodes?.slice(0, 2),
  );
  check(
    'and the policy subtypes behind POLICY_VIOLATION',
    (res.body?.data?.policySubtypes ?? []).some(entry => entry.code === 'OFF_PLATFORM_PAYMENT'),
    res.body?.data?.policySubtypes?.map(entry => entry.code),
  );

  res = await api(null, 'GET', '/admin/meta/enums', null, headers);
  check('enums answer', res.status === 200, res.body?.error);

  const enums = res.body?.data ?? {};

  check(
    'every list the portal draws is there and labelled',
    [
      'queueTypes',
      'queueStates',
      'decisions',
      'reportReasons',
      'reportStates',
      'reportTargetTypes',
      'riskCategories',
      'riskLevels',
      'auditAreas',
    ].every(key => (enums[key] ?? []).length > 0 && enums[key].every(e => e.code && e.label)),
    Object.fromEntries(Object.entries(enums).map(([key, list]) => [key, list?.length])),
  );

  /**
   * The decision list is what a reviewer's dropdown is built from, so a value in it that the decide
   * endpoint refuses is a dead option — and one missing from it is a decision nobody can take.
   */
  const queueItem = await prisma.moderationQueueItem.create({
    data: {
      // §5.9: both required since the queue gained a deadline. Non-nullable on purpose — an
      // item that can never be overdue sorts last in a queue ordered by urgency.
      priority: 'NORMAL',
      dueAt: new Date(Date.now() + 24 * 3_600_000),
      type: 'REPORTED_CONTENT',
      targetType: 'UPDATE',
      targetId: 'e2e-meta-decision-probe',
      riskLevel: 'LOW',
    },
  });

  const refusedDecisions = [];

  for (const decision of enums.decisions.map(entry => entry.code)) {
    const probe = await api(
      null,
      'POST',
      `/admin/moderation/queue/${queueItem.id}/decide`,
      { decision, reasonCode: 'OTHER', note: 'e2e decision vocabulary probe' },
      headers,
    );

    // 400 means the value is not one this API knows; anything else means it was understood, which
    // is all this check is about. The item is already decided after the first pass, so later
    // attempts answer 409 — still "understood".
    if (probe.status === 400) refusedDecisions.push([decision, probe.body?.error?.message]);
  }

  check(
    'every decision it offers is one the decide endpoint knows',
    refusedDecisions.length === 0,
    refusedDecisions,
  );

  await prisma.moderationQueueItem.delete({ where: { id: queueItem.id } });

  res = await api(null, 'GET', '/admin/meta/audit-actions', null, headers);
  check('audit actions answer', res.status === 200, res.body?.error);
  check(
    'from the registry the audit writer uses, so the filter cannot offer an action that does not exist',
    (res.body?.data ?? []).length > 0 &&
      res.body.data.every(entry => entry.action && entry.area && entry.label),
    res.body?.data?.slice(0, 2),
  );

  console.log('\n── 5.27 Assignees ───────────────────────────────────────────');

  /**
   * The rule worth testing is not "it returns staff" but **which** staff: assignability is "can
   * act on it", not "can see it". Trust & Safety hold `guard:manage` and `moderation:decide` but
   * not `support:manage`; Support hold `support:manage` and neither of the others. So each of them
   * must appear on exactly the queues they can clear.
   */
  const tsStaff = await makeAdmin('am-ts', 'trust_safety');
  const supportStaff = await makeAdmin('am-support', 'support');

  const assignees = {};

  for (const queue of ['guard', 'moderation', 'support']) {
    const probe = await api(null, 'GET', `/admin/meta/assignees?for=${queue}`, null, headers);

    check(`assignees for ${queue} answer`, probe.status === 200, probe.body?.error);
    assignees[queue] = (probe.body?.data ?? []).map(entry => entry.id);
  }

  check(
    'trust & safety can be given guard work and moderation work',
    assignees.guard.includes(tsStaff.id) && assignees.moderation.includes(tsStaff.id),
    {
      guard: assignees.guard.includes(tsStaff.id),
      moderation: assignees.moderation.includes(tsStaff.id),
    },
  );
  check(
    'but not support work, which they can only read',
    !assignees.support.includes(tsStaff.id),
    assignees.support,
  );
  check(
    'support can be given support work',
    assignees.support.includes(supportStaff.id),
    assignees.support,
  );
  check(
    'and not guard or moderation work',
    !assignees.guard.includes(supportStaff.id) && !assignees.moderation.includes(supportStaff.id),
    { guard: assignees.guard, moderation: assignees.moderation },
  );

  res = await api(null, 'GET', '/admin/meta/assignees?for=guard', null, headers);
  check(
    'every row carries what a dropdown draws',
    (res.body?.data ?? []).every(
      entry => entry.id && entry.name && entry.role && 'avatarUrl' in entry,
    ),
    res.body?.data?.slice(0, 2),
  );

  /**
   * A deactivated account must not appear: the work would be assigned to somebody who cannot sign
   * in to do it, and it would stop reading as unassigned to everybody else.
   */
  await prisma.adminCredential.update({
    where: { userId: tsStaff.id },
    data: { deactivatedAt: new Date() },
  });

  res = await api(null, 'GET', '/admin/meta/assignees?for=guard', null, headers);
  check(
    'a deactivated member of staff is not offered',
    !(res.body?.data ?? []).some(entry => entry.id === tsStaff.id),
    res.body?.data?.map(entry => entry.id),
  );

  await prisma.adminCredential.update({
    where: { userId: tsStaff.id },
    data: { deactivatedAt: null },
  });

  // Trust & Safety reach this without `team:read`, which is the whole reason the route exists.
  res = await api(null, 'GET', '/admin/meta/assignees?for=guard', null, adminHeaders(tsStaff));
  check(
    'and a caller with guard:read can fill the dropdown without team:read',
    res.status === 200,
    res.body?.error,
  );

  res = await api(null, 'GET', '/admin/meta/assignees?for=everything', null, headers);
  check('an unknown queue is refused', res.status === 400, res.body?.error);

  res = await api(null, 'GET', '/admin/meta/assignees', null, headers);
  check('and so is no queue at all', res.status === 400, res.body?.error);

  console.log('\n── 5.27 Command palette ─────────────────────────────────────');

  const member = await makeUser('am-member', { cityId: 'LONDON' });
  const row = await prisma.user.findUnique({
    where: { id: member.id },
    select: { firstName: true, lastName: true, email: true, username: true },
  });

  /**
   * A `POST`, and that is the point of the route rather than an accident: the query is a name, an
   * email address or a username, and a GET writes all three into the access log, the browser
   * history and the `Referer` of whatever is clicked next (§2.6).
   */
  res = await api(null, 'GET', '/admin/search?q=test', null, headers);
  check('there is no GET form, so a name never reaches a URL', res.status === 404, res.status);

  res = await api(null, 'POST', '/admin/search', { q: 'a' }, headers);
  check('one character is refused', res.status === 400, res.body?.error);

  res = await api(null, 'POST', '/admin/search', {}, headers);
  check('and so is no query', res.status === 400, res.body?.error);

  res = await api(null, 'POST', '/admin/search', { q: row.lastName }, headers);
  check('a name finds the member', res.status === 200, res.body?.error);

  const found = (res.body?.data?.members ?? []).find(entry => entry.id === member.id);

  check(
    'with the row a palette draws',
    found?.name && found?.city === 'London' && found?.status,
    found,
  );
  check('and where to go', found?.adminUrl === `/members/${member.id}`, found?.adminUrl);
  check(
    'matched on the name, not pretending to be exact',
    found?.matchedOn === 'name',
    found?.matchedOn,
  );

  res = await api(null, 'POST', '/admin/search', { q: member.id }, headers);
  check(
    'an id is an exact match and says so',
    res.body?.data?.members?.[0]?.id === member.id && res.body.data.members[0].matchedOn === 'id',
    res.body?.data?.members?.[0],
  );

  res = await api(null, 'POST', '/admin/search', { q: row.username }, headers);
  check(
    'a username too',
    res.body?.data?.members?.[0]?.matchedOn === 'username',
    res.body?.data?.members?.[0],
  );

  /**
   * §5.4's rule, applied here: an email query from somebody without `members:pii_reveal` matches
   * nothing. Otherwise the palette becomes a way to confirm which address an account holds, one
   * guess at a time — and it answers honestly empty rather than 403, which would itself confirm it.
   */
  res = await api(null, 'POST', '/admin/search', { q: row.email }, headers);
  check(
    'an email address matches for a caller who may see one',
    res.body?.data?.members?.[0]?.matchedOn === 'email',
    res.body?.data?.members?.[0],
  );

  res = await api(null, 'POST', '/admin/search', { q: row.email }, adminHeaders(tsStaff));
  check(
    'and matches nothing for a caller who may not, without saying why',
    res.status === 200 && (res.body?.data?.members ?? []).length === 0,
    { status: res.status, members: res.body?.data?.members },
  );

  res = await api(null, 'POST', '/admin/search', { q: 'am-' }, headers);
  check(
    'staff and members are different lists, and a staff row is in neither the other',
    (res.body?.data?.members ?? []).every(entry => entry.id !== admin.id) &&
      (res.body?.data?.staff ?? []).some(entry => entry.id === admin.id),
    {
      members: res.body?.data?.members?.map(entry => entry.name),
      staff: res.body?.data?.staff?.map(entry => entry.name),
    },
  );

  /**
   * A section the caller cannot search is **omitted**, not empty — the convention §5.24 set for
   * dashboard widgets. A moderator shown an empty `staff` array would reasonably conclude there is
   * nobody here by that name.
   */
  res = await api(null, 'POST', '/admin/search', { q: 'am-' }, adminHeaders(tsStaff));
  check(
    'a caller without team:read gets no staff key at all',
    !('staff' in (res.body?.data ?? {})) && 'members' in res.body.data,
    Object.keys(res.body?.data ?? {}),
  );
  check(
    'while a caller with every permission gets all three',
    await (async () => {
      const all = await api(null, 'POST', '/admin/search', { q: 'am-' }, headers);

      return ['members', 'staff', 'content'].every(key => key in (all.body?.data ?? {}));
    })(),
    'members, staff, content',
  );

  const content = await prisma.communityRequest.findFirst({
    where: { deletedAt: null },
    select: { id: true, title: true },
  });

  if (content) {
    res = await api(null, 'POST', '/admin/search', { q: content.id }, headers);

    const hit = (res.body?.data?.content ?? [])[0];

    check(
      'a content id finds the content, whatever kind it is',
      hit?.targetId === content.id && hit?.targetType === 'REQUEST',
      res.body?.data?.content,
    );
    check(
      'and leads to its page in the portal',
      hit?.adminUrl === `/content/requests/${content.id}`,
      hit?.adminUrl,
    );
  }

  // Free text is not a content search: that is the member-facing search engine's job, with its own
  // indexes and its own visibility rules. The palette is for pasting an id out of a report.
  res = await api(null, 'POST', '/admin/search', { q: 'housing' }, headers);
  check(
    'free text searches no content, only members and staff',
    (res.body?.data?.content ?? []).length === 0,
    res.body?.data?.content,
  );

  res = await api(null, 'POST', '/admin/search', { q: 'zzz-nothing-matches-zzz' }, headers);
  check(
    'nothing matching is three empty lists, not an error',
    res.status === 200 &&
      ['members', 'staff', 'content'].every(
        key => Array.isArray(res.body.data[key]) && res.body.data[key].length === 0,
      ),
    res.body?.data,
  );

  await sweep('admin-meta');
  await finish();
})().catch(async error => {
  await fail(error);
});
