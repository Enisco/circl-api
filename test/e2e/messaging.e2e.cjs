/* Section 5 end-to-end check, including a real WebSocket round-trip. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');
const { io } = require('socket.io-client');

const WS = 'http://localhost:4000/ws/chat';

/** Opens a socket and resolves once it is connected, or rejects on refusal. */
const connect = (token, buffer = ['unread.total']) =>
  new Promise((resolve, reject) => {
    const socket = io(WS, { auth: { token }, transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error('socket timeout')), 8000);

    socket.buffered = {};
    for (const event of buffer) {
      socket.on(event, payload => { socket.buffered[event] = payload; });
    }

    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', err => { clearTimeout(timer); reject(err); });
    socket.on('error', err => { clearTimeout(timer); reject(new Error(JSON.stringify(err))); });
  });

/** Waits for one named event, or resolves null after the timeout. */
const waitFor = (socket, event, ms = 4000) =>
  new Promise(resolve => {
    const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
    const handler = payload => { clearTimeout(timer); socket.off(event, handler); resolve(payload); };

    socket.on(event, handler);
  });

(async () => {
  await sweep('pre-run');

  const ada = await makeUser('ada', { openInbox: true });
  const tunde = await makeUser('tunde', { openInbox: true });
  const mei = await makeUser('mei', { openInbox: false });

  console.log('\n── 5.3.5 Starting a thread ──────────────────────────────────');

  let r = await api(ada.token, 'POST', '/messages', { recipientUserId: ada.id });
  check('cannot message yourself → 422', r.status === 422 && r.body?.error?.code === 'CANNOT_MESSAGE_YOURSELF', r.body?.error);

  r = await api(ada.token, 'POST', '/messages', { recipientUserId: mei.id });
  check('closed inbox, no connection → 403', r.status === 403, r.body?.error);

  r = await api(ada.token, 'POST', '/messages', { recipientUserId: tunde.id });
  check('open inbox → 201', r.status === 201, r.body?.error);
  const conversationId = r.body?.data?.id;
  check('kind DIRECT with no context', r.body?.data?.kind === 'DIRECT' && r.body?.data?.context === null, r.body?.data?.kind);

  r = await api(ada.token, 'POST', '/messages', { recipientUserId: tunde.id });
  check('the uniqueness key stops a second thread for the same pair', r.body?.data?.id === conversationId, r.body?.data?.id);

  console.log('\n── 5.0 One thread per (pair, context) ───────────────────────');

  // A booking between the same two people is a SEPARATE thread, which is correct: a dispute about a job should not bury a friendly conversation.
  const listing = await prisma.professionalListing.create({
    data: {
      userId: tunde.id, professionTitle: 'Immigration Lawyer', experienceLevel: 'EXPERT',
      about: 'I specialise in UK immigration law and have done for nine years now.',
      cityId: 'MANCHESTER', consentAccepted: true,
      categories: { create: [{ code: 'IMMIGRATION', isPrimary: true }] },
      services: { create: [{ name: 'Initial Consultation', price: 6500 }] },
    },
    include: { services: true },
  });
  r = await api(ada.token, 'POST', '/bookings', { listingId: listing.id, serviceId: listing.services[0].id });
  const bookingThread = r.body?.data?.conversationId;
  check('a booking opens its own thread with the same pair', bookingThread && bookingThread !== conversationId, { bookingThread, conversationId });

  r = await api(ada.token, 'GET', '/messages');
  check('both threads in one inbox', r.body?.data?.length === 2, r.body?.data?.length);
  check('the booking thread carries a context with a route', r.body?.data?.some(c => c.context?.type === 'BOOKING' && c.context?.route?.startsWith('/bookings/')), r.body?.data?.map(c => c.context?.type));
  check('the booking thread is labelled', r.body?.data?.find(c => c.context?.type === 'BOOKING')?.label === 'ABOUT_LISTING', r.body?.data?.map(c => c.label));

  console.log('\n── 5.3.4 Sending over REST ──────────────────────────────────');

  r = await api(ada.token, 'POST', `/messages/${conversationId}/messages`, {
    clientId: 'cid-1', body: 'Hello! Saw you are also from Lagos.',
  });
  check('send → 201', r.status === 201, r.body?.error);
  const messageId = r.body?.data?.id;
  check('server stamped sentAt (D26)', typeof r.body?.data?.sentAt === 'string');
  check('clientId echoed for the optimistic bubble', r.body?.data?.clientId === 'cid-1');
  check('status SENT', r.body?.data?.status === 'SENT');

  r = await api(ada.token, 'POST', `/messages/${conversationId}/messages`, {
    clientId: 'cid-1', body: 'Hello! Saw you are also from Lagos.',
  });
  check('replaying a clientId returns the original, not a duplicate', r.body?.data?.id === messageId, r.body?.data?.id);

  r = await api(ada.token, 'POST', `/messages/${conversationId}/messages`, { clientId: 'cid-empty', body: '   ' });
  check('empty text → 422 naming the field', r.status === 422 && r.body?.error?.details?.[0]?.field === 'body', r.body?.error);

  r = await api(ada.token, 'POST', `/messages/${conversationId}/messages`, { clientId: 'cid-sys', kind: 'SYSTEM', body: 'I am the app' });
  check('members cannot forge a SYSTEM message → 422', r.status === 422, r.body?.error);

  r = await api(mei.token, 'POST', `/messages/${conversationId}/messages`, { clientId: 'cid-x', body: 'Let me in' });
  check('non-participant → 403 NOT_A_PARTICIPANT', r.status === 403 && r.body?.error?.code === 'NOT_A_PARTICIPANT', r.body?.error);

  console.log('\n── 5.4 Unread counts & receipts ─────────────────────────────');

  r = await api(tunde.token, 'GET', '/messages/unread');
  check('recipient has an unread', r.body?.data?.total >= 1, r.body?.data);
  check('unread broken down by conversation', r.body?.data?.byConversation?.[conversationId] === 1, r.body?.data?.byConversation);

  r = await api(ada.token, 'GET', '/messages/unread');
  check('the sender is not unread on their own message', (r.body?.data?.byConversation?.[conversationId] ?? 0) === 0, r.body?.data);

  r = await api(tunde.token, 'GET', '/messages');
  check('inbox meta carries unreadTotal for the header badge', r.body?.meta?.unreadTotal >= 1, r.body?.meta);
  check('and unreadThreads', typeof r.body?.meta?.unreadThreads === 'number');

  r = await api(tunde.token, 'POST', `/messages/${conversationId}/read`, { lastReadMessageId: messageId });
  check('mark read → 200, count cleared', r.status === 200 && r.body?.data?.unreadCount === 0, r.body?.error);

  const afterRead = await prisma.message.findUnique({ where: { id: messageId } });
  check('message promoted to READ once every recipient read it', afterRead?.status === 'READ', afterRead?.status);

  console.log('\n── 5.3.3 History ────────────────────────────────────────────');

  for (let i = 0; i < 5; i++) {
    await api(tunde.token, 'POST', `/messages/${conversationId}/messages`, { clientId: `t-${i}`, body: `Reply ${i}` });
  }

  r = await api(ada.token, 'GET', `/messages/${conversationId}/messages?limit=3`);
  check('history → 200, newest first', r.status === 200 && r.body?.data?.[0]?.body === 'Reply 4', r.body?.data?.map(m => m.body));
  check('hasMore signalled', r.body?.meta?.hasMore === true, r.body?.meta);

  const oldest = r.body?.meta?.oldestId;
  r = await api(ada.token, 'GET', `/messages/${conversationId}/messages?limit=3&before=${oldest}`);
  check('before= pages backwards without repeating', !r.body?.data?.some(m => m.id === oldest), r.body?.data?.map(m => m.body));

  r = await api(ada.token, 'GET', `/messages/${conversationId}/messages?limit=10&after=${messageId}`);
  check('after= reads forwards, which is what sync needs', r.body?.data?.length === 5 && r.body.data[0].body === 'Reply 0', r.body?.data?.map(m => m.body));

  console.log('\n── 5.3.6 Tombstones, mute, archive ──────────────────────────');

  r = await api(tunde.token, 'POST', `/messages/${conversationId}/messages`, { clientId: 'del-1', body: 'Sent this by mistake' });
  const deletableId = r.body?.data?.id;
  r = await api(ada.token, 'DELETE', `/messages/${conversationId}/messages/${deletableId}`);
  check('only the sender can delete → 403', r.status === 403, r.body?.error);
  r = await api(tunde.token, 'DELETE', `/messages/${conversationId}/messages/${deletableId}`);
  check('sender deletes → 200', r.status === 200, r.body?.error);
  check('tombstoned: deletedAt set, body emptied', r.body?.data?.deletedAt !== null && r.body?.data?.body === '', r.body?.data);

  r = await api(ada.token, 'GET', `/messages/${conversationId}/messages?limit=20`);
  check('the tombstone stays in the thread, so nothing renumbers', r.body?.data?.some(m => m.id === deletableId && m.deletedAt !== null), r.body?.data?.length);

  r = await api(ada.token, 'POST', `/messages/${conversationId}/mute`, {});
  check('mute → 200', r.body?.data?.isMuted === true, r.body?.error);
  await api(tunde.token, 'POST', `/messages/${conversationId}/messages`, { clientId: 'muted-1', body: 'Still counts' });
  r = await api(ada.token, 'GET', '/messages/unread');
  check('a muted thread STILL increments unread (mute silences the push, not the count)', r.body?.data?.byConversation?.[conversationId] >= 1, r.body?.data);
  await api(ada.token, 'DELETE', `/messages/${conversationId}/mute`);

  r = await api(ada.token, 'POST', `/messages/${conversationId}/archive`);
  check('archive → 200', r.body?.data?.isArchived === true, r.body?.error);
  r = await api(ada.token, 'GET', '/messages');
  check('archived leaves the inbox', !r.body?.data?.some(c => c.id === conversationId), r.body?.data?.length);
  r = await api(ada.token, 'GET', '/messages?includeArchived=true');
  check('and comes back with includeArchived', r.body?.data?.some(c => c.id === conversationId));
  await api(ada.token, 'DELETE', `/messages/${conversationId}/archive`);

  console.log('\n── 5.7 Blocking ─────────────────────────────────────────────');

  await api(tunde.token, 'POST', '/moderation/blocks', { userId: ada.id });
  r = await api(ada.token, 'POST', `/messages/${conversationId}/messages`, { clientId: 'blk-1', body: 'Hello?' });
  check('blocked pair cannot send → 403 CONVERSATION_BLOCKED', r.status === 403 && r.body?.error?.code === 'CONVERSATION_BLOCKED', r.body?.error);
  r = await api(ada.token, 'GET', '/messages');
  check('the thread is hidden from the inbox while blocked', !r.body?.data?.some(c => c.id === conversationId), r.body?.data?.length);
  await api(tunde.token, 'DELETE', `/moderation/blocks/${ada.id}`);

  console.log('\n── 5.2 WebSocket ────────────────────────────────────────────');

  let rejected = false;
  await connect('not-a-real-token').catch(() => { rejected = true; });
  check('an invalid token is refused, not silently dropped', rejected === true);

  const adaSocket = await connect(ada.token);
  const tundeSocket = await connect(tunde.token);
  check('both members connect', adaSocket.connected && tundeSocket.connected);

  await new Promise(res => setTimeout(res, 300));
  const initialUnread = adaSocket.buffered['unread.total'];
  check('unread.total is pushed on connect', initialUnread !== undefined && typeof initialUnread.total === 'number', initialUnread);

  const incoming = waitFor(tundeSocket, 'message.new');
  const ack = waitFor(adaSocket, 'message.ack');
  adaSocket.emit('message.send', { conversationId, clientId: 'ws-1', body: 'Sent over the socket' });

  const ackPayload = await ack;
  check('sender gets message.ack echoing clientId', ackPayload?.clientId === 'ws-1' && !!ackPayload?.message?.id, ackPayload);
  const incomingPayload = await incoming;
  check('recipient gets message.new', incomingPayload?.message?.body === 'Sent over the socket', incomingPayload?.message?.body);

  const status = await waitFor(adaSocket, 'message.status', 3000);
  check('DELIVERED because the recipient has a live socket', status?.status === 'DELIVERED', status);

  const typing = waitFor(tundeSocket, 'typing');
  adaSocket.emit('typing.start', { conversationId });
  const typingPayload = await typing;
  check('typing relayed to the other party', typingPayload?.isTyping === true && typingPayload?.userId === ada.id, typingPayload);

  const typingStopped = await waitFor(tundeSocket, 'typing', 7000);
  check('typing expires server-side without a stop event', typingStopped?.isTyping === false, typingStopped);

  const readEvent = waitFor(adaSocket, 'message.read');
  tundeSocket.emit('message.read', { conversationId, lastReadMessageId: ackPayload.message.id });
  const readPayload = await readEvent;
  check('read receipt relayed to the sender', readPayload?.userId === tunde.id, readPayload);

  // The tunnel case: disconnect, miss messages, reconnect and sync.
  tundeSocket.disconnect();
  await new Promise(res => setTimeout(res, 300));
  await api(ada.token, 'POST', `/messages/${conversationId}/messages`, { clientId: 'missed-1', body: 'Sent while you were underground' });

  const tundeAgain = await connect(tunde.token);
  const replayed = waitFor(tundeAgain, 'message.new', 5000);
  tundeAgain.emit('sync', { cursors: [{ conversationId, lastMessageId: ackPayload.message.id }] });
  const replayedPayload = await replayed;
  check('sync replays what was missed while disconnected', replayedPayload?.message?.body === 'Sent while you were underground', replayedPayload?.message?.body);

  adaSocket.disconnect();
  tundeAgain.disconnect();

  console.log('\n── 3.6 Connect safety notice ────────────────────────────────');

  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  await prisma.conversation.update({ where: { id: conv.id }, data: { kind: 'CONNECT' } });
  await prisma.conversationParticipant.updateMany({
    where: { conversationId }, data: { hasSentMessage: false },
  });
  r = await api(ada.token, 'GET', `/messages/${conversationId}`);
  check('safetyNoticeRequired true until both have written', r.body?.data?.safetyNoticeRequired === true, r.body?.data?.safetyNoticeRequired);
  await prisma.conversationParticipant.updateMany({
    where: { conversationId }, data: { hasSentMessage: true },
  });
  r = await api(ada.token, 'GET', `/messages/${conversationId}`);
  check('and false once both have', r.body?.data?.safetyNoticeRequired === false);

  console.log('\n── 5.2.3 conversation.updated ───────────────────────────────');
  {
    const socket = await connect(ada.token);
    const muted = waitFor(socket, 'conversation.updated');

    await api(ada.token, 'POST', `/messages/${conversationId}/mute`, {});
    const evt = await muted;

    check('muting pushes conversation.updated', evt !== null, evt);
    check('it carries the whole conversation row',
      typeof evt?.conversation?.id === 'string' && evt?.conversation?.isMuted === true,
      evt?.conversation);

    const archived = waitFor(socket, 'conversation.updated');

    await api(ada.token, 'POST', `/messages/${conversationId}/archive`, {});
    check('archiving pushes it too', (await archived) !== null);

    await api(ada.token, 'DELETE', `/messages/${conversationId}/archive`);
    await api(ada.token, 'DELETE', `/messages/${conversationId}/mute`);
    socket.close();
  }

  console.log('\n── 5.2 The REST fallback still delivers ─────────────────────');
  {
    // A message sent over REST has to be echoed over the socket anyway (5.2). Without that, a
    // recipient who is connected sees no bubble and the sender's tick never reaches DELIVERED.
    const sender = await connect(ada.token);
    const recipient = await connect(tunde.token);
    await new Promise(res => setTimeout(res, 400));

    const arriving = waitFor(recipient, 'message.new', 5000);
    const badge = waitFor(recipient, 'unread.total', 5000);
    const delivered = waitFor(sender, 'message.status', 5000);

    await api(ada.token, 'POST', `/messages/${conversationId}/messages`,
      { clientId: 'rest-fanout-1', body: 'Sent over REST while you were watching' });

    check('a REST send reaches a connected recipient over the socket',
      (await arriving)?.message?.body === 'Sent over REST while you were watching');
    check('and refreshes their account-wide badge', (await badge) !== null);
    check('and the sender is told DELIVERED, not left on one tick',
      (await delivered)?.status === 'DELIVERED');

    sender.disconnect();
    recipient.disconnect();
  }

  console.log('\n── 5.5 Media in messages ────────────────────────────────────');
  {
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
    const put = async (mimeType, extra = {}) => {
      const mint = await api(ada.token, 'POST', '/media/uploads', {
        purpose: 'MESSAGE',
        files: [{ mimeType, byteSize: bytes.length, ...extra }],
      });
      const slot = mint.body?.data?.[0];
      if (slot?.uploadUrl) {
        await fetch(slot.uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: bytes });
      }
      return slot?.key ?? null;
    };

    const imageKey = await put('image/png');
    check('a message key sits under circl/messages/{userId}/',
      imageKey?.startsWith(`circl/messages/${ada.id}/`), imageKey);

    r = await api(ada.token, 'POST', `/messages/${conversationId}/messages`,
      { clientId: 'md-img', kind: 'IMAGE', attachmentKeys: [imageKey] });
    check('an IMAGE message sends', r.status === 201, { s: r.status, e: r.body?.error });
    check('and its attachment reads back as a signed url, never a key',
      typeof r.body?.data?.attachments?.[0]?.url === 'string'
      && !('key' in (r.body?.data?.attachments?.[0] ?? {})),
      r.body?.data?.attachments?.[0]);

    // Only the recording device knows these, and it knows them before the bytes leave (5.5).
    const audioKey = await put('audio/m4a', { durationMs: 14000, waveform: [0.2, 0.5, 0.8, 0.4] });
    r = await api(ada.token, 'POST', `/messages/${conversationId}/messages`,
      { clientId: 'md-aud', kind: 'AUDIO', attachmentKeys: [audioKey] });
    check('an AUDIO message sends', r.status === 201, { s: r.status, e: r.body?.error });
    check('the voice note carries the duration the recorder measured',
      r.body?.data?.attachments?.[0]?.durationMs === 14000, r.body?.data?.attachments?.[0]);
    check('and the stored waveform, so both people see the same shape',
      (r.body?.data?.attachments?.[0]?.waveform ?? []).length === 4,
      r.body?.data?.attachments?.[0]?.waveform);

    r = await api(ada.token, 'POST', `/messages/${conversationId}/messages`,
      { clientId: 'md-mismatch', kind: 'AUDIO', attachmentKeys: [await put('image/png')] });
    check('kind and attachment type must agree → 422', r.status === 422, r.status);

    r = await api(ada.token, 'POST', `/messages/${conversationId}/messages`,
      { clientId: 'md-none', kind: 'IMAGE', attachmentKeys: [] });
    check('a media kind with nothing attached → 422', r.status === 422, r.status);

    r = await api(ada.token, 'POST', `/messages/${conversationId}/messages`,
      { clientId: 'md-cap', kind: 'IMAGE', attachmentKeys: [await put('image/png')], body: 'x'.repeat(1001) });
    check('a caption is capped shorter than a message → 422 (5.9)', r.status === 422, r.status);

    // 0.4: a shape violation is 400, a well-formed but invalid one is 422.
    r = await api(ada.token, 'POST', `/messages/${conversationId}/messages`,
      { clientId: 'md-long', body: 'y'.repeat(4001) });
    check('a body over 4000 chars → 400 (5.9)', r.status === 400, r.status);
  }

  console.log('\n── 5.3.1 ordering, filters and search ───────────────────────');
  r = await api(ada.token, 'GET', '/messages?q=tunde');
  check('q matches on a participant name (D31)',
    (r.body?.data ?? []).length > 0, r.body?.data?.length);
  r = await api(ada.token, 'GET', '/messages?q=zzzznotathing');
  check('and returns nothing when nothing matches', (r.body?.data ?? []).length === 0,
    r.body?.data?.length);

  await prisma.conversation.update({ where: { id: conversationId }, data: { isPinned: true } });
  const newer = await makeUser('pinfoil', { openInbox: true });
  const newerThread = (await api(ada.token, 'POST', '/messages', { recipientUserId: newer.id })).body?.data?.id;
  await api(ada.token, 'POST', `/messages/${newerThread}/messages`, { clientId: 'pin-1', body: 'newer' });
  r = await api(ada.token, 'GET', '/messages');
  check('pinned sorts first even when another thread is newer, because the support thread must be first for everyone',
    r.body?.data?.[0]?.id === conversationId,
    r.body?.data?.map(x => ({ pinned: x.isPinned, id: x.id })));
  await prisma.conversation.update({ where: { id: conversationId }, data: { isPinned: false } });

  r = await api(ada.token, 'GET', '/messages');
  check('every row carries the label chip the list renders',
    (r.body?.data ?? []).every(row => 'label' in row), r.body?.data?.map(x => x.label));

  console.log('\n── 5.3.6 the unsend window ──────────────────────────────────');
  {
    const late = await api(ada.token, 'POST', `/messages/${conversationId}/messages`,
      { clientId: 'late-1', body: 'too old to unsend' });
    await prisma.message.update({
      where: { id: late.body.data.id },
      data: { sentAt: new Date(Date.now() - 16 * 60 * 1000) },
    });
    r = await api(ada.token, 'DELETE', `/messages/${conversationId}/messages/${late.body.data.id}`);
    check('a message older than 15 minutes can no longer be unsent',
      r.status === 403 || r.status === 422, { s: r.status, code: r.body?.error?.code });
  }

  console.log('\n── 5.2.3 presence ───────────────────────────────────────────');
  {
    const watcher = await connect(ada.token);
    await new Promise(res => setTimeout(res, 300));

    const online = waitFor(watcher, 'presence', 5000);
    const other = await connect(tunde.token);
    check('a participant coming online broadcasts presence',
      (await online)?.isOnline === true, 'no presence event');

    const offline = waitFor(watcher, 'presence', 5000);
    other.disconnect();
    const gone = await offline;
    check('and going offline carries lastSeenAt for the "last seen" line',
      gone?.isOnline === false && !!gone?.lastSeenAt, gone);

    watcher.disconnect();
  }

  console.log('\n── 5.4 the Circl team thread ────────────────────────────────');
  {
    // A thread that is SUPPORT before anything is sent, rather than one flipped after the fact:
    // the rule is about what markRead promotes, so the kind has to be right at read time.
    const helper = await makeUser('supportee', { openInbox: true });
    const supportId = (await api(ada.token, 'POST', '/messages', { recipientUserId: helper.id })).body?.data?.id;
    await prisma.conversation.update({ where: { id: supportId }, data: { kind: 'SUPPORT' } });

    const sent = await api(ada.token, 'POST', `/messages/${supportId}/messages`,
      { clientId: 'sup-1', body: 'Is anyone there?' });
    await api(helper.token, 'POST', `/messages/${supportId}/read`,
      { lastReadMessageId: sent.body.data.id });

    r = await api(ada.token, 'GET', `/messages/${supportId}/messages`);
    check('read receipts are not shown on a support thread: "seen" from an organisation is a promise nobody made',
      !(r.body?.data ?? []).filter(m => m.isMine).map(m => m.status).includes('READ'),
      (r.body?.data ?? []).filter(m => m.isMine).map(m => m.status));

    r = await api(helper.token, 'GET', '/messages');
    check('but reading it still clears their unread count',
      (r.body?.data ?? []).find(c => c.id === supportId)?.unreadCount === 0,
      (r.body?.data ?? []).find(c => c.id === supportId)?.unreadCount);

    // D28: and the other half of the same idea.
    const watcher = await connect(helper.token);
    const sender = await connect(ada.token);
    await new Promise(res => setTimeout(res, 400));
    const typing = waitFor(watcher, 'typing', 2500);
    sender.emit('typing.start', { conversationId: supportId });
    check('and no typing events either, because an organisation typing is not the same signal (D28)',
      (await typing) === null, 'a typing event escaped a support thread');
    watcher.disconnect();
    sender.disconnect();
  }

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await sweep('cleanup');

  await finish();
})().catch(fail);
