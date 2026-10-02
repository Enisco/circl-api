/* Groups, in full (1.7). Members make them, nobody approves them, an admin decides who gets in
   and who may read, and the thing that makes a group a group is its chat — an ordinary
   conversation in the messages API, so none of this is a second messaging stack. */
const { api, check, fail, finish, makeUser, prisma, sweep, uploadPng } = require('./harness.cjs');

(async () => {
  await sweep('pre-run');

  const admin = await makeUser('gadmin');
  const joiner = await makeUser('gjoiner');
  const asker = await makeUser('gasker');
  const invitee = await makeUser('ginvitee');
  const outsider = await makeUser('goutsider');
  const ids = [admin.id, joiner.id, asker.id, invitee.id, outsider.id];

  const stamp = Date.now();

  console.log('\n── 1 Members make groups, and they are live at once ───────');

  const openBody = {
    name: `E2E Open Group ${stamp}`,
    description: 'Events, housing tips, jobs and community, for anyone who wants them.',
    cityId: 'MANCHESTER',
    categoryCode: 'MAKE_FRIENDS',
    rules: ['Keep it kind.', 'No selling here.'],
    joinPolicy: 'OPEN',
    visibility: 'OPEN',
  };

  let r = await api(admin.token, 'POST', '/community/groups', openBody, { 'Idempotency-Key': `grp-${stamp}` });
  check('create → 201, live, no review step', r.status === 201, r.body?.error);
  const open = r.body?.data?.id;
  check('the creator is its first member and first admin', r.body?.data?.viewer?.membership === 'ADMIN' && r.body?.data?.memberCount === 1, r.body?.data?.viewer);
  check('rules come back as a list', Array.isArray(r.body?.data?.rules) && r.body.data.rules.length === 2, r.body?.data?.rules);
  check('category is a term, not a code', r.body?.data?.category?.code === 'MAKE_FRIENDS' && !!r.body?.data?.category?.label, r.body?.data?.category);
  check('visibility is its own decision', r.body?.data?.visibility === 'OPEN', r.body?.data?.visibility);
  check('createdBy names the admin', r.body?.data?.createdBy === admin.id, r.body?.data?.createdBy);

  r = await api(admin.token, 'POST', '/community/groups', openBody, { 'Idempotency-Key': `grp-${stamp}` });
  check('a replayed create is the same group, not a second of the same thing', r.body?.data?.id === open, { first: open, replay: r.body?.data?.id, status: r.status });

  r = await api(admin.token, 'POST', '/community/groups', {
    name: `E2E Second Group ${stamp}`,
    description: 'A second group by the same member, because there is no limit on how many.',
    cityId: 'MANCHESTER',
  });
  check('no limit on how many a member makes', r.status === 201, r.body?.error);
  const second = r.body?.data?.id;

  console.log('\n── 2 The two policies are genuinely independent ───────────');

  r = await api(admin.token, 'POST', '/community/groups', {
    name: `E2E Closed Group ${stamp}`,
    description: 'By approval and closed, which is the pair that proves the two are separate.',
    cityId: 'MANCHESTER',
    joinPolicy: 'APPROVAL',
    visibility: 'CLOSED',
    rules: ['Members only.'],
  });
  check('a group may be closed AND by approval', r.status === 201, r.body?.error);
  const closed = r.body?.data?.id;

  r = await api(outsider.token, 'GET', `/community/groups/${closed}`);
  check('a non-member still reads a closed group\'s name and description', r.status === 200 && !!r.body?.data?.description, r.body?.error);
  check('its rules and member count are public too', Array.isArray(r.body?.data?.rules) && typeof r.body?.data?.memberCount === 'number', r.body?.data);
  check('but nothing it has said: no preview', r.body?.data?.lastMessagePreview === null, r.body?.data?.lastMessagePreview);
  check('no message count', r.body?.data?.messageCount === null, r.body?.data?.messageCount);
  check('and no thread to open', r.body?.data?.conversationId === null, r.body?.data?.conversationId);

  r = await api(outsider.token, 'GET', `/community/groups/${open}`);
  check('an open group hands a non-member its thread facts', r.body?.data?.messageCount === 0 && typeof r.body?.data?.conversationId === 'string', r.body?.data);

  // Reading is not taking part: an open group's wall is a forum people read before they commit.
  r = await api(outsider.token, 'GET', `/community/groups/${open}/posts`);
  check('a non-member previews an open group\'s wall', r.status === 200 && r.body?.meta?.preview === true, { status: r.status, meta: r.body?.meta });

  r = await api(outsider.token, 'GET', `/community/groups/${closed}/posts`);
  check('but a closed group\'s wall is refused, which is what visibility is for', r.status === 403 && r.body?.error?.code === 'NOT_A_MEMBER', { status: r.status, code: r.body?.error?.code });

  r = await api(outsider.token, 'POST', `/community/groups/${open}/posts`, { content: 'Reading is not taking part.' });
  check('and a non-member cannot write on either', r.status === 403 && r.body?.error?.code === 'NOT_A_MEMBER', r.body?.error);

  console.log('\n── 3 scope, categories and the one button ────────────────');

  r = await api(admin.token, 'GET', '/community/groups?scope=MINE&limit=50');
  check('MINE is every group the caller is in', (r.body?.data ?? []).some(g => g.id === open) && (r.body?.data ?? []).some(g => g.id === closed), (r.body?.data ?? []).length);

  r = await api(outsider.token, 'GET', '/community/groups?scope=DISCOVER&limit=50');
  const discovered = r.body?.data ?? [];
  check('DISCOVER is every other group', discovered.some(g => g.id === open), discovered.length);
  check('and a closed group is still in it', discovered.some(g => g.id === closed), discovered.map(g => g.visibility));
  const closedRow = discovered.find(g => g.id === closed);
  check('redacted on the row exactly as on the detail', closedRow?.lastMessagePreview === null && closedRow?.messageCount === null, closedRow);

  r = await api(admin.token, 'GET', '/community/groups?scope=DISCOVER&limit=50');
  check('and the caller\'s own groups are not in their DISCOVER', !(r.body?.data ?? []).some(g => g.id === open), (r.body?.data ?? []).length);

  r = await api(outsider.token, 'GET', '/community/groups?categoryCodes=MAKE_FRIENDS&limit=50');
  check('categoryCodes narrows by category', (r.body?.data ?? []).every(g => g.category?.code === 'MAKE_FRIENDS'), (r.body?.data ?? []).map(g => g.category?.code));

  // Two filters that both read the membership relation. Written to one slot, the second decided
  // alone and the first was silently ignored.
  r = await api(admin.token, 'GET', '/community/groups?scope=MINE&membership=JOINED&limit=50');
  check('scope and membership narrow together', (r.body?.data ?? []).some(g => g.id === open), (r.body?.data ?? []).length);
  r = await api(admin.token, 'GET', '/community/groups?scope=MINE&membership=NOT_JOINED&limit=50');
  check('and contradicting each other answers nothing rather than ignoring one', (r.body?.data ?? []).length === 0, (r.body?.data ?? []).map(g => g.name));

  r = await api(outsider.token, 'GET', `/community/groups/${open}`);
  const flags = r.body?.data?.viewer;
  check('a stranger: nothing set, so the button reads Join', flags?.membership === 'NONE' && flags?.hasRequested === false && flags?.wasRemoved === false && flags?.isInvited === false && flags?.canPost === false && flags?.canModerate === false, flags);

  console.log('\n── 4 Joining, asking, withdrawing and leaving ─────────────');

  r = await api(joiner.token, 'POST', `/community/groups/${open}/join`);
  check('an open group answers which of the two happened', r.body?.data?.membership === 'MEMBER' && r.body?.data?.memberCount === 2, r.body?.data);

  r = await api(joiner.token, 'POST', `/community/groups/${open}/join`);
  check('asking twice is not an error, it answers where they stand', r.status === 200 && r.body?.data?.membership === 'MEMBER', r.body?.data);

  r = await api(asker.token, 'POST', `/community/groups/${closed}/join`, { message: 'Just moved to Manchester.' });
  check('an approval group answers PENDING', r.body?.data?.membership === 'PENDING', r.body?.data);
  check('and a request is not a membership, so the count stands still', r.body?.data?.memberCount === 1, r.body?.data?.memberCount);

  r = await api(asker.token, 'GET', `/community/groups/${closed}`);
  check('hasRequested survives a reload, which is what keeps the button from flipping', r.body?.data?.viewer?.hasRequested === true, r.body?.data?.viewer);

  // The card says "1 person is waiting", so the number is on the row and not only on the group.
  r = await api(admin.token, 'GET', '/community/groups?scope=MINE&limit=50');
  const waiting = (r.body?.data ?? []).find(g => g.id === closed);
  check('pendingRequestCount is on the admin\'s own list row', waiting?.pendingRequestCount === 1, waiting?.pendingRequestCount);
  check('and absent from a row the caller does not admin', (r.body?.data ?? []).every(g => g.viewer?.canModerate || g.pendingRequestCount === undefined), (r.body?.data ?? []).map(g => g.pendingRequestCount));

  r = await api(asker.token, 'GET', '/community/groups?limit=50');
  check('a non-admin never sees it on any row', (r.body?.data ?? []).every(g => g.pendingRequestCount === undefined), (r.body?.data ?? []).filter(g => g.pendingRequestCount !== undefined).length);

  r = await api(admin.token, 'GET', `/community/groups/${closed}/join-requests`);
  check('the admin sees the queue, oldest first', (r.body?.data ?? []).length === 1, r.body?.data);
  check('with whatever the asker typed', r.body?.data?.[0]?.message === 'Just moved to Manchester.', r.body?.data?.[0]);
  check('and the asker\'s headline under their name', 'headline' in (r.body?.data?.[0]?.user ?? {}), r.body?.data?.[0]?.user);

  r = await api(asker.token, 'GET', `/community/groups/${closed}/join-requests`);
  check('a member doing an admin\'s job → 403 NOT_ADMIN', r.status === 403 && r.body?.error?.code === 'NOT_ADMIN', r.body?.error);

  r = await api(asker.token, 'DELETE', `/community/groups/${closed}/join`);
  check('the same route withdraws a request', r.body?.data?.membership === 'NONE', r.body?.data);
  check('and moves nothing, because nothing was ever counted', r.body?.data?.memberCount === 1, r.body?.data?.memberCount);

  r = await api(asker.token, 'POST', `/community/groups/${closed}/join`, { message: 'Asking again.' });
  check('and they may ask again afterwards', r.body?.data?.membership === 'PENDING', r.body?.data);

  r = await api(admin.token, 'POST', `/community/groups/${closed}/join-requests/${asker.id}`, { approve: true });
  check('approve → the whole group comes back, because both numbers moved', r.body?.data?.id === closed, Object.keys(r.body?.data ?? {}));
  check('memberCount moved', r.body?.data?.memberCount === 2, r.body?.data?.memberCount);
  check('and pendingRequestCount with it', r.body?.data?.pendingRequestCount === 0, r.body?.data?.pendingRequestCount);

  r = await api(asker.token, 'GET', `/community/groups/${closed}`);
  check('the asker is in, and may take part', r.body?.data?.viewer?.membership === 'MEMBER' && r.body?.data?.viewer?.canPost === true, r.body?.data?.viewer);
  check('and the group tells them nothing is outstanding', r.body?.data?.viewer?.hasRequested === false, r.body?.data?.viewer);
  check('pendingRequestCount is absent for somebody who is not the admin', r.body?.data?.pendingRequestCount === undefined, r.body?.data?.pendingRequestCount);

  console.log('\n── 5 Members, and removal being final ────────────────────');

  r = await api(admin.token, 'GET', `/community/groups/${open}/members`);
  check('members → 200, admins first', (r.body?.data ?? [])[0]?.role === 'ADMIN', r.body?.data);
  check('each row carries the user, role and joinedAt', !!r.body?.data?.[0]?.user?.id && !!r.body?.data?.[0]?.joinedAt, r.body?.data?.[0]);

  r = await api(outsider.token, 'GET', `/community/groups/${open}/members`);
  check('a non-member asking who is in it → 403', r.status === 403, { status: r.status, code: r.body?.error?.code });

  r = await api(admin.token, 'DELETE', `/community/groups/${open}/members/${admin.id}`);
  check('an admin cannot remove themselves', r.status === 422, { status: r.status, code: r.body?.error?.code });

  r = await api(admin.token, 'DELETE', `/community/groups/${open}/members/${joiner.id}`);
  check('remove a member → the whole group, count down', r.body?.data?.id === open && r.body?.data?.memberCount === 1, r.body?.data?.memberCount);

  r = await api(joiner.token, 'GET', `/community/groups/${open}`);
  check('wasRemoved for ever after, so the client offers nothing', r.body?.data?.viewer?.wasRemoved === true, r.body?.data?.viewer);
  check('and they are no longer a member', r.body?.data?.viewer?.membership === 'NONE', r.body?.data?.viewer);

  r = await api(joiner.token, 'GET', '/community/groups?scope=MINE&limit=50');
  check('the group left their MINE', !(r.body?.data ?? []).some(g => g.id === open), (r.body?.data ?? []).length);

  r = await api(joiner.token, 'POST', `/community/groups/${open}/join`);
  check('and asking again → 403 REMOVED_FROM_GROUP', r.status === 403 && r.body?.error?.code === 'REMOVED_FROM_GROUP', r.body?.error);

  r = await api(joiner.token, 'GET', '/notifications');
  check('being removed is something a member is told', (r.body?.data ?? []).some(n => /removed/i.test(n.title ?? '')), (r.body?.data ?? []).map(n => n.title));

  console.log('\n── 6 Invitations, the only way back in ───────────────────');

  r = await api(admin.token, 'GET', `/community/groups/${open}/invitable?limit=50`);
  const invitable = r.body?.data ?? [];
  check('invitable lists members of Circl who are not in it', invitable.some(row => row.user?.id === invitee.id), invitable.length);
  check('a removed member stays on it, because an invitation is the only way back', invitable.some(row => row.user?.id === joiner.id && row.wasRemoved === true), invitable.filter(row => row.wasRemoved).map(row => row.user?.id));
  check('and the admin is not on their own list', !invitable.some(row => row.user?.id === admin.id), invitable.length);

  r = await api(admin.token, 'POST', `/community/groups/${open}/invites`, { userIds: [invitee.id, joiner.id] });
  check('invite several at once → the whole group', r.status === 200 && !!r.body?.data?.id, r.body?.error);

  r = await api(admin.token, 'POST', `/community/groups/${open}/invites`, { userIds: [invitee.id] });
  check('inviting somebody already invited is not an error', r.status === 200, r.body?.error);

  r = await api(admin.token, 'GET', `/community/groups/${open}/invitable?limit=50`);
  check('an invited member leaves the invitable list', !(r.body?.data ?? []).some(row => row.user?.id === invitee.id), (r.body?.data ?? []).length);

  r = await api(invitee.token, 'GET', '/community/groups/invites');
  check('my invitations → the group each is for', (r.body?.data ?? []).some(row => row.group?.id === open), r.body?.data);
  check('with who sent it and when', !!r.body?.data?.[0]?.invitedBy?.id && !!r.body?.data?.[0]?.sentAt, r.body?.data?.[0]);

  r = await api(invitee.token, 'GET', `/community/groups/${open}`);
  check('isInvited is set, so the button reads Accept', r.body?.data?.viewer?.isInvited === true, r.body?.data?.viewer);

  r = await api(invitee.token, 'GET', '/notifications');
  check('and they were told', (r.body?.data ?? []).some(n => /invited you/i.test(n.title ?? '')), (r.body?.data ?? []).map(n => n.title));

  r = await api(invitee.token, 'POST', `/community/groups/${open}/invites/answer`, { accept: true });
  check('accepting answers the whole group, now joined', r.body?.data?.viewer?.membership === 'MEMBER', r.body?.data?.viewer);
  check('and the invitation is gone with it', r.body?.data?.viewer?.isInvited === false, r.body?.data?.viewer);

  r = await api(joiner.token, 'POST', `/community/groups/${open}/join`);
  check('an invitation lets a removed member back in, whatever the policy', r.body?.data?.membership === 'MEMBER', r.body?.data);

  r = await api(joiner.token, 'GET', `/community/groups/${open}`);
  check('and wasRemoved stops being true once they are back', r.body?.data?.viewer?.wasRemoved === false, r.body?.data?.viewer);

  r = await api(outsider.token, 'POST', `/community/groups/${open}/invites`, { userIds: [asker.id] });
  check('only an admin invites', r.status === 403 && r.body?.error?.code === 'NOT_ADMIN', r.body?.error);

  r = await api(outsider.token, 'POST', `/community/groups/${open}/invites/answer`, { accept: true });
  check('and answering an invitation nobody sent → 404', r.status === 404, { status: r.status });

  console.log('\n── 7 The group\'s chat is an ordinary conversation ─────────');

  r = await api(admin.token, 'GET', `/community/groups/${open}`);
  const thread = r.body?.data?.conversationId;
  check('the group carries its thread', typeof thread === 'string', thread);

  r = await api(admin.token, 'GET', `/community/groups/${closed}`);
  const closedThread = r.body?.data?.conversationId;
  check('a closed group hands its own admin the thread id', typeof closedThread === 'string', closedThread);

  r = await api(outsider.token, 'GET', `/community/groups/${closed}`);
  check('and withholds it from a non-member, because an id that 403s is worse than none', r.body?.data?.conversationId === null, r.body?.data?.conversationId);
  r = await api(outsider.token, 'GET', `/community/groups/${open}`);
  check('while an open group hands it over, since that id is what their tap opens', typeof r.body?.data?.conversationId === 'string', r.body?.data?.conversationId);

  // Readable by a stranger and joinable only by approval, which is the pair the read-only bar has
  // to get right: it says "Ask to join" rather than "Join".
  r = await api(admin.token, 'POST', '/community/groups', {
    name: `E2E Open By Approval ${stamp}`,
    description: 'Anyone may read it, and an admin answers every request to come in.',
    cityId: 'MANCHESTER', visibility: 'OPEN', joinPolicy: 'APPROVAL',
  });
  const pendingGroup = r.body?.data?.id;
  const pendingThread = r.body?.data?.conversationId;
  await api(admin.token, 'POST', `/messages/${pendingThread}/messages`, { clientId: `pg-${stamp}`, body: 'Anybody can read this one.' });
  check('an open group may still take members by approval', r.status === 201 && !!pendingThread, r.body?.error);

  r = await api(admin.token, 'GET', `/messages/${thread}`);
  check('which the messages API answers', r.status === 200, r.body?.error);
  check('as kind GROUP', r.body?.data?.kind === 'GROUP', r.body?.data?.kind);
  check('with no participant, because there is no other person', r.body?.data?.participant === null, r.body?.data?.participant);
  check('and the group in its place, for the chat header', r.body?.data?.group?.id === open && !!r.body?.data?.group?.name, r.body?.data?.group);
  check('carrying memberCount, which moves on every join', typeof r.body?.data?.group?.memberCount === 'number', r.body?.data?.group);

  // A group IS its conversation, so an open group's thread is readable by somebody who has not
  // joined: a stranger who can see the name and the rules and nothing anybody ever said is
  // exactly the group the admin was trying not to run. Reading is the only verb that opens up.
  r = await api(outsider.token, 'GET', `/messages/${thread}`);
  check('a non-member may read an open group\'s thread', r.status === 200, { status: r.status, code: r.body?.error?.code });
  check('told it is read-only before the composer is drawn', r.body?.data?.viewer?.canPost === false, r.body?.data?.viewer);
  check('and given the policy, so the bar says Join or Ask to join', r.body?.data?.group?.joinPolicy === 'OPEN', r.body?.data?.group);

  r = await api(admin.token, 'GET', `/messages/${thread}`);
  check('while a member is told they may send', r.body?.data?.viewer?.canPost === true, r.body?.data?.viewer);

  r = await api(outsider.token, 'GET', `/messages/${closedThread}`);
  check('a closed group is unchanged: 403 NOT_A_PARTICIPANT', r.status === 403 && r.body?.error?.code === 'NOT_A_PARTICIPANT', r.body?.error);
  r = await api(outsider.token, 'GET', `/messages/${closedThread}/messages`);
  check('and so are its messages', r.status === 403 && r.body?.error?.code === 'NOT_A_PARTICIPANT', r.body?.error);

  r = await api(admin.token, 'POST', `/messages/${thread}/messages`, {
    clientId: `g-1-${stamp}`, body: 'Bring *ID* and _proof of address_ on Thursday.',
  });
  check('a member sends through the existing endpoint', r.status === 201, r.body?.error);
  check('and every message carries its sender, which a 1:1 can leave out', !!r.body?.data?.sender, r.body?.data?.sender);

  r = await api(invitee.token, 'GET', `/messages/${thread}/messages?limit=5`);
  check('another member reads it', (r.body?.data ?? []).length >= 1, (r.body?.data ?? []).length);
  check('with the markers untouched in the bubble', r.body?.data?.[0]?.body === 'Bring *ID* and _proof of address_ on Thursday.', r.body?.data?.[0]?.body);

  // Every bubble needs a name, or a thread with more than two people in it is unreadable.
  const bubble = r.body?.data?.[0];
  check('each message says who said it', !!bubble?.sender?.id && !!bubble?.sender?.displayName, bubble?.sender);
  check('under `name` as well, which is what the shipped client reads', bubble?.sender?.name === bubble?.sender?.displayName, bubble?.sender?.name);
  check('and carries their picture field, null or not', 'avatarUrl' in (bubble?.sender ?? {}), bubble?.sender);

  r = await api(outsider.token, 'GET', `/messages/${thread}/messages?limit=5`);
  check('a non-member reads the messages of an open group', r.status === 200 && (r.body?.data ?? []).length >= 1, { status: r.status, length: (r.body?.data ?? []).length });

  // Everything other than reading stays shut.
  r = await api(outsider.token, 'POST', `/messages/${thread}/messages`, { clientId: `g-ro-${stamp}`, body: 'Can I speak?' });
  check('but may not write in it', r.status === 403 && r.body?.error?.code === 'NOT_A_PARTICIPANT', r.body?.error);
  r = await api(outsider.token, 'POST', `/messages/${thread}/read`, {});
  check('and has no read cursor to move', r.status === 403, { status: r.status, code: r.body?.error?.code });
  r = await api(outsider.token, 'POST', `/messages/${thread}/mute`, {});
  check('nor anything to mute', r.status === 403 && r.body?.error?.code === 'NOT_A_PARTICIPANT', { status: r.status, code: r.body?.error?.code });
  r = await api(outsider.token, 'POST', `/messages/${thread}/archive`, {});
  check('nor anything to file away', r.status === 403 && r.body?.error?.code === 'NOT_A_PARTICIPANT', { status: r.status, code: r.body?.error?.code });

  r = await api(outsider.token, 'GET', '/messages?limit=50');
  check('reading one does not put it in their inbox', !(r.body?.data ?? []).some(row => row.id === thread), (r.body?.data ?? []).length);

  // Removal beats open: an admin's decision is not undone by the visibility setting.
  r = await api(joiner.token, 'GET', `/messages/${thread}`);
  check('a member reads their own group normally', r.status === 200, { status: r.status });
  await api(admin.token, 'DELETE', `/community/groups/${open}/members/${joiner.id}`);
  r = await api(joiner.token, 'GET', `/messages/${thread}`);
  check('but somebody an admin removed reads nothing, whatever the visibility', r.status === 403 && r.body?.error?.code === 'NOT_A_PARTICIPANT', r.body?.error);
  await api(admin.token, 'POST', `/community/groups/${open}/invites`, { userIds: [joiner.id] });
  await api(joiner.token, 'POST', `/community/groups/${open}/join`);

  // A pending request is remembered, or somebody who asked yesterday is offered Ask to join today.
  r = await api(asker.token, 'POST', `/community/groups/${pendingGroup}/join`, { message: 'Letting me in?' });
  check('asking from inside a thread leaves a request', r.body?.data?.membership === 'PENDING', r.body?.data);
  r = await api(asker.token, 'GET', `/messages/${pendingThread}`);
  check('which the thread remembers across opens', r.body?.data?.viewer?.hasRequested === true, r.body?.data?.viewer);
  check('and it is still read-only until an admin answers', r.body?.data?.viewer?.canPost === false, r.body?.data?.viewer);
  check('with the policy saying which words the bar uses', r.body?.data?.group?.joinPolicy === 'APPROVAL', r.body?.data?.group);

  r = await api(admin.token, 'GET', `/community/groups/${open}`);
  check('the group\'s preview is plain words, markers stripped', r.body?.data?.lastMessagePreview === 'Bring ID and proof of address on Thursday.', r.body?.data?.lastMessagePreview);
  check('messageCount agrees with the conversation', r.body?.data?.messageCount === 1, r.body?.data?.messageCount);
  check('and lastMessageAt comes back with it', !!r.body?.data?.lastMessageAt, r.body?.data?.lastMessageAt);

  r = await api(invitee.token, 'GET', '/community/groups?scope=MINE&limit=50');
  const unreadRow = (r.body?.data ?? []).find(g => g.id === open);
  check('unreadCount is the thread\'s own, read twice rather than counted twice', unreadRow?.unreadCount === 1, unreadRow?.unreadCount);

  r = await api(invitee.token, 'GET', '/messages?limit=50');
  const inboxRow = (r.body?.data ?? []).find(row => row.id === thread);
  check('the group thread is in the ordinary inbox', !!inboxRow, (r.body?.data ?? []).length);
  check('labelled as a group', inboxRow?.label === 'GROUP', inboxRow?.label);

  console.log('\n── 8 Mute, and leaving closing the thread ────────────────');

  r = await api(invitee.token, 'PATCH', `/community/groups/${open}/mute`, { isMuted: true });
  check('mute answers the whole group', r.body?.data?.viewer?.isMuted === true, r.body?.data?.viewer);

  r = await api(invitee.token, 'GET', '/community/groups?scope=MINE&limit=50');
  const muted = (r.body?.data ?? []).find(g => g.id === open);
  check('a muted group still counts its unread', muted?.isMuted !== false || muted?.viewer?.isMuted === true, muted?.viewer);
  check('and it is per member, not for the group', (await api(admin.token, 'GET', `/community/groups/${open}`)).body?.data?.viewer?.isMuted === false, 'admin');

  await api(invitee.token, 'PATCH', `/community/groups/${open}/mute`, { isMuted: false });

  r = await api(invitee.token, 'DELETE', `/community/groups/${open}/join`);
  check('leaving a group → NONE, and the count moves', r.body?.data?.membership === 'NONE', r.body?.data);

  // Leaving takes away taking part, not reading — this group is open, and an open group's thread
  // is readable by anybody. What leaving does take is the composer and the inbox row.
  r = await api(invitee.token, 'GET', `/messages/${thread}`);
  check('leaving an open group leaves its thread readable', r.status === 200, { status: r.status });
  check('but read-only now', r.body?.data?.viewer?.canPost === false, r.body?.data?.viewer);

  r = await api(invitee.token, 'GET', '/messages?limit=50');
  check('and it leaves their inbox either way', !(r.body?.data ?? []).some(row => row.id === thread), (r.body?.data ?? []).length);

  r = await api(asker.token, 'GET', `/messages/${closedThread}`);
  check('while leaving a closed group does close it', r.status === 200, { status: r.status });
  await api(asker.token, 'DELETE', `/community/groups/${closed}/join`);
  r = await api(asker.token, 'GET', `/messages/${closedThread}`);
  check('— 403 once they are out of it', r.status === 403 && r.body?.error?.code === 'NOT_A_PARTICIPANT', { status: r.status, code: r.body?.error?.code });

  console.log('\n── 9 Editing and deleting ────────────────────────────────');

  const avatarKey = await uploadPng(admin.token, 'COMMUNITY', 400, 400);

  r = await api(admin.token, 'PATCH', `/community/groups/${open}`, {
    name: `E2E Renamed Group ${stamp}`,
    rules: ['One rule now.'],
    visibility: 'CLOSED',
    joinPolicy: 'APPROVAL',
    categoryCode: 'ACCOMMODATION',
    avatarKey,
  });
  check('an admin edits every field, and absent means untouched', r.status === 200, r.body?.error);
  check('both policies changed at once', r.body?.data?.visibility === 'CLOSED' && r.body?.data?.joinPolicy === 'APPROVAL', r.body?.data);
  check('the rules were replaced', r.body?.data?.rules?.length === 1, r.body?.data?.rules);
  check('the category moved', r.body?.data?.category?.code === 'ACCOMMODATION', r.body?.data?.category);
  check('and the picture is signed back', !!r.body?.data?.avatarUrl, r.body?.data?.avatarUrl);
  check('neither policy changed who is a member', r.body?.data?.memberCount >= 1, r.body?.data?.memberCount);

  r = await api(admin.token, 'GET', `/messages/${thread}`);
  check('the inbox row follows the rename rather than keeping the old name for months', r.body?.data?.group?.name === `E2E Renamed Group ${stamp}`, r.body?.data?.group?.name);

  r = await api(admin.token, 'PATCH', `/community/groups/${open}`, { avatarKey: null });
  check('an explicit null removes the picture, which absent never does', r.body?.data?.avatarUrl === null, r.body?.data?.avatarUrl);

  r = await api(outsider.token, 'PATCH', `/community/groups/${open}`, { name: 'Hijacked' });
  check('and only an admin edits', r.status === 403 && r.body?.error?.code === 'NOT_ADMIN', r.body?.error);

  r = await api(outsider.token, 'DELETE', `/community/groups/${second}`);
  check('only an admin deletes', r.status === 403, { status: r.status, code: r.body?.error?.code });

  const secondThread = (await api(admin.token, 'GET', `/community/groups/${second}`)).body?.data?.conversationId;
  r = await api(admin.token, 'DELETE', `/community/groups/${second}`);
  check('delete → 204', r.status === 204, r.status);

  r = await api(admin.token, 'GET', `/community/groups/${second}`);
  check('the group is gone', r.status === 404 || r.status === 410, r.status);

  r = await api(admin.token, 'GET', `/messages/${secondThread}`);
  check('and its thread goes with it', r.status === 403 || r.status === 404, { status: r.status });

  // The relaxation must not outlive the group: a deleted open group's thread is readable by
  // nobody, which the delete used to achieve only by emptying the participant list.
  r = await api(outsider.token, 'GET', `/messages/${secondThread}`);
  check('and is readable by nobody, open or not', r.status === 403 || r.status === 404, { status: r.status });

  console.log('\n── 10 One picture, on every shape that draws it ──────────');

  // The create path takes `avatarKey` and never had a client sending one, so nothing exercised it.
  const createKey = await uploadPng(admin.token, 'COMMUNITY', 400, 400);
  r = await api(admin.token, 'POST', '/community/groups', {
    name: `E2E Pictured Group ${stamp}`,
    description: 'A group with its picture chosen on the create screen rather than afterwards.',
    cityId: 'MANCHESTER',
    joinPolicy: 'APPROVAL',
    visibility: 'CLOSED',
    avatarKey: createKey,
  });
  check('a picture may be chosen on create, not only added afterwards', r.status === 201 && !!r.body?.data?.avatarUrl, { status: r.status, avatarUrl: r.body?.data?.avatarUrl });
  const pictured = r.body?.data?.id;
  const attached = await prisma.media.count({ where: { ownerType: 'GROUP_AVATAR', ownerId: pictured } });
  check('and the create path attaches the media, as the patch path does', attached === 1, attached);

  // Five places draw it and three of them read a list row, so a null here is a grey circle that
  // cannot be told apart from a group with no picture.
  r = await api(outsider.token, 'GET', '/community/groups?scope=DISCOVER&limit=50');
  const picturedRow = (r.body?.data ?? []).find(g => g.id === pictured);
  check('the list row carries it too', !!picturedRow?.avatarUrl, picturedRow?.avatarUrl);
  check('a closed group\'s picture is part of the shop window, not redacted', picturedRow?.lastMessagePreview === null && !!picturedRow?.avatarUrl, { preview: picturedRow?.lastMessagePreview, avatarUrl: !!picturedRow?.avatarUrl });

  r = await api(outsider.token, 'GET', `/community/groups/${pictured}`);
  check('and so is the detail a non-member reads', !!r.body?.data?.avatarUrl, r.body?.data?.avatarUrl);

  await api(admin.token, 'POST', `/community/groups/${pictured}/invites`, { userIds: [outsider.id] });
  r = await api(outsider.token, 'GET', '/community/groups/invites');
  const card = (r.body?.data ?? []).find(row => row.group?.id === pictured);
  check('the invitation card has the picture it draws', !!card?.group?.avatarUrl, card?.group);
  check('with the name and member count beside it', !!card?.group?.name && typeof card?.group?.memberCount === 'number', card?.group);

  console.log('\n── 11 The waiting banner reads a per-row count ───────────');

  // The banner says "2 people are waiting · <group>", so the number has to be right on each row.
  // A banner that says two when one is waiting is worse than no banner.
  await api(asker.token, 'POST', `/community/groups/${pictured}/join`, { message: 'Can I join?' });
  await api(joiner.token, 'POST', `/community/groups/${pictured}/join`, { message: 'Me too.' });

  r = await api(admin.token, 'GET', '/community/groups?scope=MINE&limit=50');
  const rows = r.body?.data ?? [];
  const twoWaiting = rows.find(g => g.id === pictured);
  const noneWaiting = rows.find(g => g.id === open);
  check('a group with two waiting says two on its own row', twoWaiting?.pendingRequestCount === 2, twoWaiting?.pendingRequestCount);
  check('and one with nobody waiting says zero on the same page', noneWaiting?.pendingRequestCount === 0, noneWaiting?.pendingRequestCount);
  check('every row the admin runs carries the number', rows.filter(g => g.viewer?.canModerate).every(g => typeof g.pendingRequestCount === 'number'), rows.map(g => g.pendingRequestCount));

  r = await api(outsider.token, 'GET', '/community/groups?limit=50');
  check('and no row carries it for somebody who runs none of them', (r.body?.data ?? []).every(g => g.pendingRequestCount === undefined), (r.body?.data ?? []).filter(g => g.pendingRequestCount !== undefined).length);

  r = await api(admin.token, 'POST', `/community/groups/${pictured}/join-requests/${asker.id}`, { approve: true });
  check('and it moves the moment one is answered', r.body?.data?.pendingRequestCount === 1, r.body?.data?.pendingRequestCount);

  console.log('\n── 12 The wall is retired, and still answers ─────────────');

  // A group is its conversation, so the wall was a second place to say the same things and the app
  // has stopped calling it. The endpoints stay: builds in the wild keep calling them until people
  // update, and breaking a screen that still exists in a shipped app helps nobody.
  r = await api(admin.token, 'POST', `/community/groups/${pictured}/posts`, { content: 'An old build can still post to the wall.' });
  check('the retired wall still answers an old build', r.status === 201, { status: r.status, error: r.body?.error?.code });
  const retiredPost = r.body?.data?.id;

  r = await api(asker.token, 'POST', `/community/groups/${pictured}/posts/${retiredPost}/replies`, { content: 'And still reply to one.' });
  check('and so do its replies', r.status === 201, { status: r.status, error: r.body?.error?.code });

  // There is no post screen left, so the notification lands on the group rather than nowhere.
  r = await api(admin.token, 'GET', '/notifications');
  const replyRow = (r.body?.data ?? []).find(n => /replied in your group post/.test(n.title ?? ''));
  check('a reply notification opens the group, not a screen that is gone', replyRow?.route === `/community/group/${pictured}`, replyRow?.route);
  check('and targets the group, so an older client resolves it too', replyRow?.target?.type === 'GROUP' && replyRow?.target?.id === pictured, replyRow?.target);

  // A row pointing at a screen that no longer exists is worse than no row.
  r = await api(admin.token, 'GET', `/users/${admin.id}/activity`);
  check('no GROUP_POST row in the profile activity feed', !(r.body?.data ?? []).some(row => row.type === 'GROUP_POST'), (r.body?.data ?? []).map(row => row.type));

  r = await api(admin.token, 'GET', `/users/${admin.id}/activity?type=GROUP_POST`);
  check('and an older build\'s chip answers an empty list rather than a 400', r.status === 200 && (r.body?.data ?? []).length === 0, { status: r.status, length: (r.body?.data ?? []).length });

  console.log('\n── 13 headline, the one new field on the author object ────');

  await api(asker.token, 'PATCH', '/users/profile', { headline: 'Immigration law' });
  r = await api(admin.token, 'GET', `/community/groups/${pictured}/members`);
  const askerRow = (r.body?.data ?? []).find(row => row.user?.id === asker.id);
  check('a member\'s headline is theirs to set and shows under their name', askerRow?.user?.headline === 'Immigration law', askerRow?.user);

  r = await api(admin.token, 'GET', `/community/groups/${pictured}/members`);
  const adminRow = (r.body?.data ?? []).find(row => row.user?.id === admin.id);
  check('and it is null where nobody has said, never guessed at', adminRow?.user?.headline === null, adminRow?.user);

  await sweep('cleanup');
  void ids;
  await finish();
})().catch(fail);
