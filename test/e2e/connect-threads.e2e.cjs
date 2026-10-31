/**
 * One conversation per person in Connect, not one per profile (`BACKEND-TODO.md` 1.3), plus the
 * two things the app asked for beside it: a tag on the message and a way to find a thread without
 * creating one (3.2).
 *
 * A thread's identity is the pair **plus the subject**, which is right for a marketplace item — a
 * question about one product has nothing to do with a question about another — and wrong for
 * Connect, where the profile is where a conversation started rather than what it is about. A
 * member can leave Connect and come back, and the new profile is a new id: under the old rule the
 * next message opened a second conversation and stranded the reply in the first.
 */
const {
  api,
  check,
  connectCreate,
  dobFor,
  fail,
  finish,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

const heading = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

const openThread = (token, kind, id) => api(token, 'POST', '/messages', { context: { kind, id } });

(async () => {
  await sweep('connect-threads');

  const writer = await makeUser('ctwriter', { bio: 'New to Manchester, learning Yoruba.' });
  const subject = await makeUser('ctsubject', { bio: 'Happy to show people around Moss Side.' });

  const joinConnect = async (user, body) =>
    api(user.token, 'PUT', '/connect/me', await connectCreate(user.token, body));

  let r = await joinConnect(writer, {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Somebody to practise Yoruba with over coffee, once a week.',
    dateOfBirth: dobFor(29),
    dmPolicy: 'OPEN',
    isVisible: true,
  });

  check('the writer is on Connect', r.status === 200, r.body?.error);

  r = await joinConnect(subject, {
    typeCode: 'LANGUAGE_EXCHANGE',
    lookingFor: 'Teaching Yoruba, learning Spanish. Weekends are easiest.',
    dateOfBirth: dobFor(34),
    dmPolicy: 'OPEN',
    isVisible: true,
  });

  const firstProfileId = r.body?.data?.id;

  check('and so is the person being written to', !!firstProfileId, r.body?.error);

  heading('1. The first message, from their Connect profile');

  r = await openThread(writer.token, 'CONNECT_PROFILE', firstProfileId);

  const threadId = r.body?.data?.id;

  check(
    'opens a thread with no recipientUserId, derived from the profile',
    r.status === 201 && !!threadId,
    { status: r.status, error: r.body?.error },
  );

  r = await api(writer.token, 'POST', `/messages/${threadId}/messages`, {
    clientId: `ct-${Date.now()}-1`,
    body: 'Saw your profile — are you still looking for someone to practise with?',
    tag: { kind: 'CONNECT_PROFILE', id: firstProfileId },
  });

  check('the message sends with a tag on it', r.status === 201, r.body?.error);
  check(
    'and the tag comes back on the message, saying where it was written from',
    r.body?.data?.tag?.kind === 'CONNECT_PROFILE' && r.body?.data?.tag?.id === firstProfileId,
    r.body?.data?.tag,
  );

  r = await api(writer.token, 'GET', `/messages/${threadId}/messages`);

  check(
    'it is still there on a read of the thread',
    (r.body?.data ?? []).some(message => message.tag?.id === firstProfileId),
    (r.body?.data ?? []).map(message => message.tag),
  );
  check(
    'and a message sent without one carries tag: null rather than nothing',
    (
      await api(writer.token, 'POST', `/messages/${threadId}/messages`, {
        clientId: `ct-${Date.now()}-2`,
        body: 'No rush at all.',
      })
    ).body?.data?.tag === null,
  );

  heading('2. Sending both the profile and the recipient');

  r = await api(writer.token, 'POST', '/messages', {
    context: { kind: 'CONNECT_PROFILE', id: firstProfileId },
    recipientUserId: subject.id,
  });

  check(
    'is accepted, and returns the same thread — only a mismatch is refused',
    r.status === 200 && r.body?.data?.id === threadId,
    { status: r.status, id: r.body?.data?.id, error: r.body?.error },
  );

  const stranger = await makeUser('ctstranger');

  r = await api(writer.token, 'POST', '/messages', {
    context: { kind: 'CONNECT_PROFILE', id: firstProfileId },
    recipientUserId: stranger.id,
  });

  check('and a recipient who does not own the profile still is', r.status === 422, {
    status: r.status,
    code: r.body?.error?.code,
  });

  heading('3. They leave Connect and come back with a new profile');

  r = await api(subject.token, 'DELETE', '/connect/me');

  check('the old profile is gone', r.status === 204, r.body?.error);

  // No `dateOfBirth`: it is set once and belongs to the member rather than to Connect, so
  // rejoining does not resend it (DOB_LOCKED).
  r = await joinConnect(subject, {
    typeCode: 'FRIENDSHIP',
    lookingFor: 'Anyone nearby for a walk at the weekend.',
    dmPolicy: 'OPEN',
    isVisible: true,
  });

  const secondProfileId = r.body?.data?.id;

  check(
    'and the new one is a different record',
    !!secondProfileId && secondProfileId !== firstProfileId,
    { first: firstProfileId, second: secondProfileId, status: r.status, error: r.body?.error },
  );

  r = await openThread(writer.token, 'CONNECT_PROFILE', secondProfileId);

  check(
    'writing from it lands in the conversation they already had',
    r.status === 200 && r.body?.data?.id === threadId,
    { status: r.status, id: r.body?.data?.id, expected: threadId },
  );

  const threads = await prisma.conversation.count({
    where: {
      contextType: 'CONNECT_PROFILE',
      participants: { some: { userId: writer.id } },
    },
  });

  check('so there is one Connect thread between them, not two', threads === 1, { threads });

  heading('4. Every other subject still keeps its own thread');

  r = await api(subject.token, 'POST', '/commerce/stores', {
    name: 'Ada Fresh Produce',
    type: 'LOCAL',
    description: 'Yams, plantain and fresh peppers, brought in twice a week.',
    area: 'Longsight',
    heritageTags: ['WEST_AFRICAN'],
  });

  const storeId = r.body?.data?.id;

  const itemOf = async name =>
    (
      await api(subject.token, 'POST', `/commerce/stores/${storeId}/items`, {
        name,
        price: 900,
        unitCode: 'EACH',
        categoryCode: 'FOOD_GROCERIES',
        description: `${name}, in on Thursday.`,
      })
    ).body?.data?.id;

  const yam = await itemOf('Puna yam');
  const plantain = await itemOf('Plantain, ripe');

  const yamThread = (await openThread(writer.token, 'ITEM', yam)).body?.data?.id;
  const plantainThread = (await openThread(writer.token, 'ITEM', plantain)).body?.data?.id;

  check(
    'two items are two conversations, as they were before',
    !!yamThread && !!plantainThread && yamThread !== plantainThread,
    { yamThread, plantainThread },
  );

  r = await openThread(writer.token, 'ITEM', yam);

  check(
    'and asking twice about one item returns the first thread with a 200',
    r.status === 200 && r.body?.data?.id === yamThread,
    { status: r.status, id: r.body?.data?.id },
  );

  heading('5. Finding a thread without opening one');

  r = await api(writer.token, 'GET', `/messages/find?contextType=ITEM&contextId=${yam}`);

  check(
    'the thread about an item is findable by its subject',
    r.status === 200 && r.body?.data?.id === yamThread,
    {
      status: r.status,
      id: r.body?.data?.id,
    },
  );

  r = await api(writer.token, 'GET', `/messages/find?contextType=COMMERCE_ITEM&contextId=${yam}`);

  check('under either spelling of the kind', r.status === 200 && r.body?.data?.id === yamThread, {
    status: r.status,
  });

  const quiet = await itemOf('Scotch bonnet, 500g');

  r = await api(writer.token, 'GET', `/messages/find?contextType=ITEM&contextId=${quiet}`);

  check('404 where there is no thread, and nothing is created', r.status === 404, {
    status: r.status,
  });

  const created = await prisma.conversation.count({ where: { contextId: quiet } });

  check('nothing at all', created === 0, { created });

  r = await api(stranger.token, 'GET', `/messages/find?contextType=ITEM&contextId=${yam}`);

  check('and somebody else’s thread is a 404 rather than a disclosure', r.status === 404, {
    status: r.status,
  });

  heading('6. A thread marked done comes back when somebody writes in it');

  await api(subject.token, 'POST', `/messages/${yamThread}/archive`, { isArchived: true });

  let inbox = await api(subject.token, 'GET', '/messages?archived=true');

  check(
    'it is in the archive',
    (inbox.body?.data ?? []).some(row => row.id === yamThread),
    (inbox.body?.data ?? []).map(row => row.id),
  );

  await api(writer.token, 'POST', `/messages/${yamThread}/messages`, {
    clientId: `ct-${Date.now()}-3`,
    body: 'Are these still in?',
  });

  inbox = await api(subject.token, 'GET', '/messages');

  check(
    'and a new message brings it back to the inbox rather than leaving it filed away unread',
    (inbox.body?.data ?? []).some(row => row.id === yamThread),
    (inbox.body?.data ?? []).map(row => ({ id: row.id, unread: row.unreadCount })),
  );

  await sweep('connect-threads');
  await finish();
})().catch(fail);
