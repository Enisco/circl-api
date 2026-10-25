/**
 * The public website's three forms (`API-WEBSITE-FORMS.md`).
 *
 * Most of this suite is about the third one. A contact message and a suggestion are an insert and
 * an email; "ask us to delete my account" is a public, unauthenticated endpoint that takes an
 * email address — so the things worth testing are the ones it must refuse to do: say whether an
 * address belongs to an account, delete anything, or let one visitor fill a stranger's inbox.
 */
const {
  api,
  check,
  clearRateLimits,
  fail,
  finish,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

/** The forms are per-IP limited at five an hour, and every run here makes more than five. */
const fresh = () => clearRateLimits();

const submissionsFor = email =>
  prisma.websiteSubmission.findMany({
    where: { email },
    orderBy: { createdAt: 'asc' },
  });

(async () => {
  await sweep('website-forms');

  const stamp = Date.now();
  const sender = `e2e-website-${stamp}@example.com`;

  heading('1. Send a message');

  await fresh();
  let r = await api(null, 'POST', '/website/contact-messages', {
    name: 'Amara Okafor',
    email: sender.toUpperCase(),
    topic: 'ACCOUNT',
    message: "I signed up with Apple and can't find how to change my email.",
  });

  check('a message is accepted', r.status === 201, { status: r.status, error: r.body?.error });
  check('and comes back with an id to quote', typeof r.body?.data?.id === 'string', r.body?.data);

  const [message] = await submissionsFor(sender);

  check('it is stored as a CONTACT_MESSAGE', message?.type === 'CONTACT_MESSAGE', message?.type);
  check(
    'the address is lowercased, so a per-email check cannot be fooled by case',
    message?.email === sender,
    message?.email,
  );
  check('the topic and body are kept', message?.topic === 'ACCOUNT' && !!message?.body, {
    topic: message?.topic,
    body: !!message?.body,
  });
  check(
    'and the address it came from is hashed, never stored',
    typeof message?.ipHash === 'string' && message.ipHash.length === 64,
    message?.ipHash?.slice(0, 12),
  );

  await fresh();
  r = await api(null, 'POST', '/website/contact-messages', {
    name: 'Amara Okafor',
    email: sender,
    topic: 'ACCOUNT',
    message: '   too short   ',
  });
  check('a message under ten characters after trimming is refused', r.status === 400, r.status);

  await fresh();
  r = await api(null, 'POST', '/website/contact-messages', {
    name: 'Amara Okafor',
    email: sender,
    topic: 'NOT_A_TOPIC',
    message: 'Long enough to pass the length rule.',
  });
  check('and so is a topic that is not one of the five', r.status === 400, r.status);

  await fresh();
  r = await api(null, 'POST', '/website/contact-messages', {
    name: 'Amara Okafor',
    email: sender,
    topic: 'ACCOUNT',
    message: 'Long enough to pass the length rule.',
    captchaToken: 'not-a-field-yet',
  });
  check(
    'an unknown field is refused rather than ignored, so the two sides cannot drift',
    r.status === 400,
    r.status,
  );

  heading('2. Suggest a feature');

  await fresh();
  r = await api(null, 'POST', '/website/feature-suggestions', {
    title: 'A guide to swapping a foreign driving licence',
    area: 'COMMUNITY',
    details: 'Everyone in my group asks this and the answers are scattered across ten threads.',
  });
  check('a suggestion with no address is accepted', r.status === 201, {
    status: r.status,
    error: r.body?.error,
  });

  const anonymous = await prisma.websiteSubmission.findUnique({
    where: { id: r.body?.data?.id },
  });

  check(
    'the email is null rather than an empty string, which is what the column means',
    anonymous?.email === null,
    anonymous?.email,
  );
  check('the title is kept on its own column', !!anonymous?.title, anonymous?.title);

  await fresh();
  r = await api(null, 'POST', '/website/feature-suggestions', {
    title: 'Hi',
    area: 'COMMUNITY',
    details: 'Everyone in my group asks this and the answers are scattered.',
  });
  check('a two-character title is refused', r.status === 400, r.status);

  heading('3. Ask us to delete your account');

  // A real member, so the lookup has something to find — and a second address that belongs to
  // nobody. The two have to be indistinguishable from outside.
  const member = await makeUser('website-del');

  await fresh();
  const known = await api(null, 'POST', '/website/deletion-requests', {
    name: 'Karim Haddad',
    email: member.email,
    reason: 'OTHER_ACCOUNT',
    details: 'I made a second account by mistake when I switched phones.',
  });

  await fresh();
  const stranger = `e2e-website-nobody-${stamp}@example.com`;
  const unknown = await api(null, 'POST', '/website/deletion-requests', {
    name: 'Nobody At All',
    email: stranger,
    reason: 'PRIVACY',
  });

  check('a request for a real account is accepted', known.status === 202, known.status);
  check('and one for an address nobody uses answers the same', unknown.status === 202, {
    known: known.status,
    unknown: unknown.status,
  });
  check(
    'byte for byte the same body, so the form cannot be used to check who is on Circl',
    JSON.stringify(known.body) === JSON.stringify(unknown.body),
    { known: known.body, unknown: unknown.body },
  );
  check(
    'and neither carries an id, which would be one more thing to compare',
    known.body?.data === null && unknown.body?.data === null,
    { known: known.body?.data, unknown: unknown.body?.data },
  );

  // The lookup happens after the response, so give it a moment before reading the row.
  await new Promise(resolve => setTimeout(resolve, 600));

  const [requested] = await submissionsFor(member.email);
  const [missed] = await submissionsFor(stranger);

  check(
    'the account it matched is recorded on the row, for whoever picks the request up',
    requested?.matchedUserId === member.id,
    { matched: requested?.matchedUserId, expected: member.id },
  );
  check('and the row says when it was checked', !!requested?.checkedAt, requested?.checkedAt);
  check(
    'a request matching nothing is checked too, and matched nothing',
    !!missed?.checkedAt && missed?.matchedUserId === null,
    { checkedAt: missed?.checkedAt, matched: missed?.matchedUserId },
  );

  heading('4. It starts a process and deletes nothing');

  const after = await prisma.user.findUnique({
    where: { id: member.id },
    select: { isAnonymised: true, email: true },
  });

  check('the member still exists and is not anonymised', after?.isAnonymised === false, after);
  check('and their address is untouched', after?.email === member.email, {
    now: after?.email === member.email,
  });

  r = await api(member.token, 'GET', '/users/profile');
  check('they can still use their account', r.status === 200, {
    status: r.status,
    error: r.body?.error,
  });

  heading('5. One address cannot be used to flood somebody');

  // Three a day per address, and the fourth has to look exactly like the first three.
  await fresh();
  const second = await api(null, 'POST', '/website/deletion-requests', {
    name: 'Karim Haddad',
    email: member.email,
    reason: 'NOT_USING',
  });
  await fresh();
  const third = await api(null, 'POST', '/website/deletion-requests', {
    name: 'Karim Haddad',
    email: member.email,
    reason: 'NOT_USING',
  });
  await fresh();
  const fourth = await api(null, 'POST', '/website/deletion-requests', {
    name: 'Karim Haddad',
    email: member.email,
    reason: 'NOT_USING',
  });

  check(
    'the fourth in a day is accepted like the rest — a refusal would be a signal in itself',
    second.status === 202 && third.status === 202 && fourth.status === 202,
    [second.status, third.status, fourth.status],
  );
  check(
    'and the same body again',
    JSON.stringify(fourth.body) === JSON.stringify(known.body),
    fourth.body,
  );

  await new Promise(resolve => setTimeout(resolve, 600));

  const all = await submissionsFor(member.email);
  const throttled = all.filter(row => row.state === 'SPAM');

  check(
    'all four are recorded, because the attempt is worth keeping',
    all.length === 4,
    all.length,
  );
  check(
    'the fourth is marked SPAM, which is what stops it being worked and emailed again',
    throttled.length === 1 && throttled[0].id === all[3].id,
    all.map(row => row.state),
  );
  check(
    'and it was never checked against an account, so nothing was sent',
    throttled[0]?.checkedAt === null,
    throttled[0]?.checkedAt,
  );

  heading('6. No token, and no account needed');

  await fresh();
  r = await api(null, 'POST', '/website/contact-messages', {
    name: 'Anonymous Visitor',
    email: `e2e-website-visitor-${stamp}@example.com`,
    topic: 'GENERAL',
    message: 'Just asking a question without an account.',
  });
  check('every form works with no token at all', r.status === 201, r.status);

  // Five an hour per address. The sixth, without clearing, is the limit doing its job.
  let limited = null;

  for (let attempt = 0; attempt < 8 && limited === null; attempt += 1) {
    const probe = await api(null, 'POST', '/website/contact-messages', {
      name: 'Busy Bot',
      email: `e2e-website-bot-${stamp}@example.com`,
      topic: 'GENERAL',
      message: 'Sending this again and again and again.',
    });

    if (probe.status === 429) limited = attempt;
  }

  check('and the rate limit stops a script', limited !== null, { limitedAfter: limited });

  await sweep('website-forms');
  await prisma.websiteSubmission.deleteMany({
    where: { email: { startsWith: 'e2e-website-' } },
  });
  await prisma.websiteSubmission.deleteMany({ where: { id: anonymous?.id } });

  await finish();
})().catch(fail);
