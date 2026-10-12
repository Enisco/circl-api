/* §6.8 Private messages: the scan that changes nothing a member can see.
 *
 * Every other scan in the platform can hold the thing it looked at. This one cannot, and that is
 * the property most of this suite is about: the message is delivered, readable, un-edited and
 * un-flagged to both people in the conversation, whatever the scan concluded. The conclusion goes
 * to staff, as a queue item, and nowhere else.
 *
 * The scan runs on a worker, so each send is followed by a wait rather than an assertion on the
 * response. The classifier is off (`safety.classifier.enabled`), as everywhere else until it
 * exists, so there is never a threat signal and §6.8.1's default subject always applies — which
 * is what makes the subject assertions below deterministic.
 *
 * The seeded terms used here, with their weights, because the thresholds are the point
 * (`T.high` = 55, `T.critical` = 90):
 *
 *   "go back to your country"      45  HATE              → not watched by this job at all
 *   "immigration raid"             50  DEPORTATION_RISK  → below T.high → a signal, no case
 *   "trafficked"                   65  MODERN_SLAVERY    → safeguarding floor → CRITICAL, sender
 *   "employer keeps my passport"   60  EXPLOITATION      → safeguarding floor → CRITICAL, recipient
 *   "fake documents"               55  SCAM              → HIGH, sender, no safeguarding case
 */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Long enough for the worker to have finished, short enough to run forty of them. */
const SETTLE_MS = 2_500;

const safetyOf = targetId =>
  prisma.contentSafety.findUnique({
    where: { targetType_targetId: { targetType: 'MESSAGE', targetId } },
  });

const itemsFor = targetId =>
  prisma.moderationQueueItem.findMany({ where: { targetType: 'MESSAGE', targetId } });

const auditFor = targetId =>
  prisma.auditLog.findFirst({ where: { action: 'safety.message_escalated', targetId } });

const escalationOn = item => item?.payload?.messageEscalation ?? {};

(async () => {
  await sweep('pre-run');

  /** Opens a DIRECT thread between two fresh members and returns a sender for it. */
  const conversation = async prefix => {
    const sender = await makeUser(`${prefix}-sender`, { cityId: 'BRISTOL' });
    const recipient = await makeUser(`${prefix}-recipient`, { cityId: 'BRISTOL' });
    const res = await api(sender.token, 'POST', '/messages', { recipientUserId: recipient.id });

    check(`${prefix}: a thread is opened`, res.status === 201, res.body?.error);

    const id = res.body?.data?.id;

    return {
      id,
      sender,
      recipient,
      /** Sends, waits for the worker, and hands back the message id. */
      send: async (label, body) => {
        const sent = await api(sender.token, 'POST', `/messages/${id}/messages`, {
          clientId: `${prefix}-${label}`.slice(0, 64),
          body,
        });

        check(`${prefix}: the ${label} message is accepted`, sent.status === 201, sent.body?.error);
        await wait(SETTLE_MS);

        return sent.body?.data?.id;
      },
    };
  };

  console.log('\n── A clean message leaves no trace at all ──────────────────');

  const quiet = await conversation('ms-quiet');
  let message = await quiet.send('clean', 'Hello — are you free to meet on Saturday afternoon?');

  check('nothing was written about it', !(await safetyOf(message)), await safetyOf(message));
  check(
    'and no term hits either',
    (await prisma.riskTermHit.count({ where: { targetType: 'MESSAGE', targetId: message } })) === 0,
  );
  check('and no queue item', (await itemsFor(message)).length === 0);

  // The asymmetry with a post is deliberate: a clean post gets a CLEAN safety row, because its
  // visibility was decided by the scan and the decision is worth keeping. Nothing decided the
  // message's visibility, so there is nothing to keep — and a row per private message is a
  // record of private conversations that serves no one.
  console.log('    (a clean post keeps a CLEAN row; a clean private message keeps nothing)');

  console.log('\n── A category this job does not watch is left alone ────────');

  message = await quiet.send('hate', 'Honestly, people keep telling me go back to your country.');

  check(
    'a HATE term in a private conversation records nothing',
    !(await safetyOf(message)) && (await itemsFor(message)).length === 0,
    await safetyOf(message),
  );
  console.log('    (§6.8: only the safeguarding categories and SCAM/LANDLORD_FRAUD do anything)');

  console.log('\n── A watched term below T.high is a signal, not a case ─────');

  message = await quiet.send('signal', 'There was an immigration raid on the street last night.');

  let safety = await safetyOf(message);

  check('it is recorded', !!safety, safety);
  check(
    'as MEDIUM, under DEPORTATION_RISK, scored below the threshold',
    safety?.tier === 'MEDIUM' && safety?.category === 'DEPORTATION_RISK' && safety?.finalScore < 55,
    safety,
  );
  check(
    'and left VISIBLE: a message is never held, whatever the scan found',
    safety?.visibilityState === 'VISIBLE',
    safety?.visibilityState,
  );
  check(
    'the term hit is filed against the message',
    (await prisma.riskTermHit.count({ where: { targetType: 'MESSAGE', targetId: message } })) === 1,
  );
  check('but no queue item: nothing for a human to do yet', (await itemsFor(message)).length === 0);
  check('and no audit entry', !(await auditFor(message)));

  let read = await api(quiet.recipient.token, 'GET', `/messages/${quiet.id}/messages`);
  const delivered = (read.body?.data ?? []).find(row => row.id === message);

  check('the recipient reads it, unchanged', read.status === 200 && !!delivered, read.body?.error);
  check(
    'with its text intact and nothing added to say it was looked at',
    delivered?.body?.includes('immigration raid') &&
      !('reviewStatus' in (delivered ?? {})) &&
      !('safety' in (delivered ?? {})),
    delivered,
  );

  console.log('\n── A disclosure opens one case about the person disclosing ─');

  const disclosure = await conversation('ms-disclose');
  message = await disclosure.send('slavery', 'I was trafficked here and I do not know what to do.');
  safety = await safetyOf(message);

  check(
    'CRITICAL, under MODERN_SLAVERY, by the safeguarding floor',
    safety?.tier === 'CRITICAL' && safety?.category === 'MODERN_SLAVERY',
    safety,
  );
  check('and still VISIBLE', safety?.visibilityState === 'VISIBLE', safety?.visibilityState);

  let items = await itemsFor(message);
  let guard = items.find(item => item.type === 'GUARD_RISK');

  check('one queue item, and it is a GUARD_RISK', items.length === 1 && !!guard, items);
  check(
    'about the sender, who is the one disclosing (§6.8.1)',
    guard?.subjectUserId === disclosure.sender.id &&
      escalationOn(guard).subjectRole === 'SENDER' &&
      escalationOn(guard).rule === 'DEFAULT',
    { subjectUserId: guard?.subjectUserId, ...escalationOn(guard) },
  );
  check(
    'CRITICAL and URGENT, with the SLA that implies',
    guard?.riskLevel === 'CRITICAL' && escalationOn(guard).priority === 'URGENT',
    { riskLevel: guard?.riskLevel, priority: escalationOn(guard).priority },
  );
  check(
    'carrying a snapshot of the flagged message only',
    escalationOn(guard).snapshot?.body?.includes('trafficked') &&
      !!escalationOn(guard).snapshot?.sentAt &&
      escalationOn(guard).messageId === message,
    escalationOn(guard).snapshot,
  );
  check(
    'and no second item about anyone else: no threat signal, so no sender flag',
    !items.some(item => item.type === 'FLAGGED_CONTENT'),
    items.map(item => item.type),
  );

  let entry = await auditFor(message);

  check('it is audited', !!entry, entry);
  check('by the system, not a person', entry?.actorId === null && entry?.area === 'SAFETY', {
    actorId: entry?.actorId,
    area: entry?.area,
  });
  check(
    'naming the member, the category and the rule',
    entry?.metadata?.subjectId === disclosure.sender.id &&
      entry?.metadata?.category === 'MODERN_SLAVERY' &&
      entry?.metadata?.subjectRole === 'SENDER' &&
      entry?.metadata?.conversationId === disclosure.id,
    entry?.metadata,
  );
  check(
    'and never the message text (§6.8)',
    !JSON.stringify(entry?.metadata ?? {}).includes('trafficked'),
    entry?.metadata,
  );
  check(
    'no Guard thread was opened: §6.8 forbids anything the member can see',
    (await prisma.guardThread.count({ where: { userId: disclosure.sender.id } })) === 0,
  );

  console.log('\n── A situation that escalates twice is still one piece of work');

  const second = await disclosure.send('slavery-2', 'I am forced to work every day of the week.');

  check(
    'the second message is recorded in its own right',
    (await safetyOf(second))?.category === 'MODERN_SLAVERY',
    await safetyOf(second),
  );

  const open = await prisma.moderationQueueItem.findMany({
    where: {
      type: 'GUARD_RISK',
      subjectUserId: disclosure.sender.id,
      state: { in: ['PENDING', 'IN_REVIEW'] },
    },
  });

  check(
    'but the reviewer still has one GUARD_RISK, not two (deduped per conversation)',
    open.length === 1,
    open.map(item => ({ id: item.id, target: item.targetId })),
  );
  check(
    'moved on to the newer message, so the snapshot is the one that escalated last',
    escalationOn(open[0]).messageId === second,
    escalationOn(open[0]).messageId,
  );
  check('and the second message is audited too, so the trail has both', !!(await auditFor(second)));

  console.log('\n── An exploitative message is about the person it was aimed at');

  const exploitation = await conversation('ms-exploit');

  message = await exploitation.send('exploit', 'My employer keeps my passport, so you are fine.');
  items = await itemsFor(message);
  guard = items.find(item => item.type === 'GUARD_RISK');

  const flagged = items.find(item => item.type === 'FLAGGED_CONTENT');

  check(
    'the GUARD_RISK is about the recipient (§6.8.1: an exploitative offer is aimed at them)',
    guard?.subjectUserId === exploitation.recipient.id &&
      escalationOn(guard).subjectRole === 'RECIPIENT',
    { subjectUserId: guard?.subjectUserId, ...escalationOn(guard) },
  );
  check(
    'and a second item flags the sender, which EXPLOITATION always does',
    flagged?.subjectUserId === exploitation.sender.id &&
      escalationOn(flagged).subjectRole === 'SENDER',
    { subjectUserId: flagged?.subjectUserId, ...escalationOn(flagged) },
  );
  check(
    'the reviewer can see which rule picked which member',
    escalationOn(guard).rule === 'DEFAULT' &&
      escalationOn(guard).category === 'EXPLOITATION' &&
      escalationOn(guard).conversationKind === 'DIRECT',
    escalationOn(guard),
  );

  read = await api(exploitation.recipient.token, 'GET', `/messages/${exploitation.id}/messages`);

  check(
    'and the message is delivered all the same — the recipient is not protected by deletion',
    read.status === 200 && (read.body?.data ?? []).some(row => row.id === message),
    read.body?.error,
  );

  console.log('\n── In a group, "the recipient" is nobody in particular ─────');

  let res = await api(quiet.sender.token, 'POST', '/community/groups', {
    name: `E2E message safety ${Date.now()}`,
    description: 'Seeded by message-safety.e2e.cjs',
    cityId: 'BRISTOL',
    joinPolicy: 'OPEN',
  });

  check('a group is created', res.status === 201, res.body?.error);

  const group = res.body?.data?.id;
  const groupThread = await prisma.conversation.findFirst({
    where: { participantKey: `group:${group}` },
    select: { id: true },
  });

  check('with a thread of its own', !!groupThread, groupThread);

  res = await api(quiet.sender.token, 'POST', `/messages/${groupThread.id}/messages`, {
    clientId: `ms-group-${Date.now()}`.slice(0, 64),
    body: 'My employer keeps my passport and it is no problem at all.',
  });

  check('the group message is accepted', res.status === 201, res.body?.error);
  await wait(SETTLE_MS);

  message = res.body?.data?.id;
  items = await itemsFor(message);
  guard = items.find(item => item.type === 'GUARD_RISK');

  check(
    'the GUARD_RISK names no member: a reviewer chooses who the case is about',
    !!guard && guard.subjectUserId === null,
    { id: guard?.id, subjectUserId: guard?.subjectUserId },
  );
  check(
    'and says so, so the reviewer knows why it is unassigned',
    escalationOn(guard).subjectRole === 'GROUP' && escalationOn(guard).conversationKind === 'GROUP',
    escalationOn(guard),
  );
  check(
    'the sender is still flagged in their own right',
    items.some(item => item.type === 'FLAGGED_CONTENT' && item.subjectUserId === quiet.sender.id),
    items.map(item => ({ type: item.type, subjectUserId: item.subjectUserId })),
  );

  console.log('\n── A scam is something the sender did ──────────────────────');

  const scam = await conversation('ms-scam');

  message = await scam.send('scam', 'I can sort you out with fake documents by Friday.');
  safety = await safetyOf(message);
  items = await itemsFor(message);

  check('SCAM, at HIGH', safety?.category === 'SCAM' && safety?.tier === 'HIGH', safety);
  check(
    'one FLAGGED_CONTENT about the sender, and no safeguarding case',
    items.length === 1 &&
      items[0].type === 'FLAGGED_CONTENT' &&
      items[0].subjectUserId === scam.sender.id &&
      items[0].riskLevel === 'HIGH',
    items.map(item => ({ type: item.type, level: item.riskLevel })),
  );
  check(
    'and no safeguarding audit entry: nothing was escalated to Guard',
    !(await auditFor(message)),
  );

  console.log('\n── A Guard thread keeps its own scoring ────────────────────');

  const guarded = await makeUser('ms-guard', { cityId: 'BRISTOL' });

  res = await api(guarded.token, 'POST', '/guard/threads', {
    subject: 'Something I do not want to post',
    message: 'I am frightened of the man I live with and I have nowhere to go.',
    // A GUARD_CATEGORY code (B28). `ACCOMMODATION` is a community category and this endpoint now
    // validates against the right vocabulary, so it would be refused.
    categoryCode: 'SAFETY',
  });

  check('a private Guard thread is opened', res.status === 201, res.body?.error);

  const guardConversation = res.body?.data?.conversationId;

  res = await api(guarded.token, 'POST', `/messages/${guardConversation}/messages`, {
    clientId: `ms-guard-${Date.now()}`.slice(0, 64),
    body: 'I think I was trafficked here and my employer keeps my passport.',
  });

  check('the member writes into it', res.status === 201, res.body?.error);
  await wait(SETTLE_MS);

  message = res.body?.data?.id;

  check(
    'this job does not scan it (§6.8: member↔staff threads are out of scope)',
    !(await safetyOf(message)) && (await itemsFor(message)).length === 0,
    await safetyOf(message),
  );
  check(
    'it is scored instead, which is what a Guard thread needs (§6.8)',
    (await prisma.guardThread.findFirst({ where: { userId: guarded.id } }))?.riskScore > 0 &&
      (await prisma.guardThread.findFirst({ where: { userId: guarded.id } }))?.riskLevel !== 'NONE',
    await prisma.guardThread.findFirst({
      where: { userId: guarded.id },
      select: { riskScore: true, riskLevel: true },
    }),
  );
  check(
    'and no second queue item was opened behind the first',
    (await prisma.moderationQueueItem.count({
      where: { type: 'GUARD_RISK', subjectUserId: guarded.id, targetType: 'MESSAGE' },
    })) === 0,
  );

  await sweep('message-safety');
  await finish();
})().catch(async error => {
  await fail(error);
});
