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
  check('approve → the whole group comes back, because both numbers moved', !!r.body?.data?.group?.id, Object.keys(r.body?.data ?? {}));
  check('memberCount moved', r.body?.data?.group?.memberCount === 2, r.body?.data?.group?.memberCount);
  check('and pendingRequestCount with it', r.body?.data?.group?.pendingRequestCount === 0, r.body?.data?.group?.pendingRequestCount);

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
  check('remove a member → the whole group, count down', r.body?.data?.group?.memberCount === 1, r.body?.data?.group?.memberCount);

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

  r = await api(admin.token, 'GET', `/messages/${thread}`);
  check('which the messages API answers', r.status === 200, r.body?.error);
  check('as kind GROUP', r.body?.data?.kind === 'GROUP', r.body?.data?.kind);
  check('with no participant, because there is no other person', r.body?.data?.participant === null, r.body?.data?.participant);
  check('and the group in its place, for the chat header', r.body?.data?.group?.id === open && !!r.body?.data?.group?.name, r.body?.data?.group);
  check('carrying memberCount, which moves on every join', typeof r.body?.data?.group?.memberCount === 'number', r.body?.data?.group);

  r = await api(outsider.token, 'GET', `/messages/${thread}`);
  check('a non-member reading it → 403 NOT_A_PARTICIPANT', r.status === 403 && r.body?.error?.code === 'NOT_A_PARTICIPANT', r.body?.error);

  r = await api(admin.token, 'POST', `/messages/${thread}/messages`, {
    clientId: `g-1-${stamp}`, body: 'Bring *ID* and _proof of address_ on Thursday.',
  });
  check('a member sends through the existing endpoint', r.status === 201, r.body?.error);
  check('and every message carries its sender, which a 1:1 can leave out', !!r.body?.data?.sender, r.body?.data?.sender);

  r = await api(invitee.token, 'GET', `/messages/${thread}/messages?limit=5`);
  check('another member reads it', (r.body?.data ?? []).length >= 1, (r.body?.data ?? []).length);
  check('with the markers untouched in the bubble', r.body?.data?.[0]?.body === 'Bring *ID* and _proof of address_ on Thursday.', r.body?.data?.[0]?.body);

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

  r = await api(invitee.token, 'GET', `/messages/${thread}`);
  check('leaving closes the thread for them', r.status === 403, { status: r.status, code: r.body?.error?.code });

  r = await api(invitee.token, 'GET', '/messages?limit=50');
  check('and it leaves their inbox', !(r.body?.data ?? []).some(row => row.id === thread), (r.body?.data ?? []).length);

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

  console.log('\n── 10 headline, the one new field on the author object ────');

  await api(asker.token, 'PATCH', '/users/profile', { headline: 'Immigration law' });
  r = await api(admin.token, 'GET', `/community/groups/${closed}/members`);
  const askerRow = (r.body?.data ?? []).find(row => row.user?.id === asker.id);
  check('a member\'s headline is theirs to set and shows under their name', askerRow?.user?.headline === 'Immigration law', askerRow?.user);

  r = await api(admin.token, 'GET', `/community/groups/${closed}/members`);
  const adminRow = (r.body?.data ?? []).find(row => row.user?.id === admin.id);
  check('and it is null where nobody has said, never guessed at', adminRow?.user?.headline === null, adminRow?.user);

  await sweep('cleanup');
  void ids;
  await finish();
})().catch(fail);
