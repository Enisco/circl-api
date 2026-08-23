/* Drives every validation boundary from the spec's own summary tables through
   the live API, so the check is against the contract rather than against my
   own DTOs. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');

const str = n => 'a'.repeat(n);

(async () => {
  await sweep('pre-run');
  const u = await makeUser('val');

  // [label, method, path, buildBody(value), field, min, max]
  const cases = [
    ['Request.title', 'POST', '/community/requests',
      v => ({ categoryCode: 'JOBS', cityId: 'MANCHESTER', title: v }), 'title', 6, 120],
    ['Request.description', 'POST', '/community/requests',
      v => ({ categoryCode: 'JOBS', cityId: 'MANCHESTER', title: str(20), description: v }), 'description', null, 4000],
    ['Offer.title', 'POST', '/community/offers',
      v => ({ categoryCode: 'JOBS', cityId: 'MANCHESTER', title: v, description: str(50) }), 'title', 6, 120],
    ['Offer.description', 'POST', '/community/offers',
      v => ({ categoryCode: 'JOBS', cityId: 'MANCHESTER', title: str(20), description: v }), 'description', 20, 4000],
    ['Update.content', 'POST', '/community/updates', v => ({ content: v }), 'content', 1, 2000],
    ['Guide.title', 'POST', '/community/guides',
      v => ({ topicCode: 'JOBS', title: v, intro: str(50), steps: [str(50)] }), 'title', 6, 140],
    ['Guide.intro', 'POST', '/community/guides',
      v => ({ topicCode: 'JOBS', title: str(20), intro: v, steps: [str(50)] }), 'intro', 20, 1000],
    ['Group.name', 'POST', '/community/groups',
      v => ({ name: v, description: str(50), cityId: 'MANCHESTER' }), 'name', 3, 60],
    ['Group.description', 'POST', '/community/groups',
      v => ({ name: `G${Date.now()}${Math.random()}`.slice(0, 40), description: v, cityId: 'MANCHESTER' }), 'description', 15, 500],
  ];

  console.log('\n── 1.11 Validation summary, boundary by boundary ────────────');

  for (const [label, method, path, build, field, min, max] of cases) {
    if (min !== null && min > 0) {
      let r = await api(u.token, method, path, build(str(min - 1)));
      check(`${label}: ${min - 1} chars rejected`, r.status === 400 && r.body?.error?.details?.some(d => d.field === field), { status: r.status, details: r.body?.error?.details });

      r = await api(u.token, method, path, build(str(min)));
      check(`${label}: ${min} chars accepted`, r.status === 201, { status: r.status, err: r.body?.error?.message });
    }

    let r = await api(u.token, method, path, build(str(max + 1)));
    check(`${label}: ${max + 1} chars rejected`, r.status === 400 && r.body?.error?.details?.some(d => d.field === field), { status: r.status, details: r.body?.error?.details });

    r = await api(u.token, method, path, build(str(max)));
    check(`${label}: ${max} chars accepted`, r.status === 201, { status: r.status, err: r.body?.error?.message });
  }

  // thankYouAmount 0..100000 pence
  let r = await api(u.token, 'POST', '/community/requests',
    { categoryCode: 'JOBS', cityId: 'MANCHESTER', title: str(20), thankYouAmount: 100001 });
  check('Request.thankYouAmount: over £1000 rejected', r.status === 400, r.status);
  r = await api(u.token, 'POST', '/community/requests',
    { categoryCode: 'JOBS', cityId: 'MANCHESTER', title: str(20), thankYouAmount: 100000 });
  check('Request.thankYouAmount: £1000 accepted', r.status === 201, r.body?.error);
  const reqId = r.body?.data?.id;

  // Response.content 1..2000
  const other = await makeUser('val2');
  r = await api(other.token, 'POST', `/community/requests/${reqId}/responses`, { content: str(2001) });
  check('Response.content: 2001 rejected', r.status === 400, r.status);
  r = await api(other.token, 'POST', `/community/requests/${reqId}/responses`, { content: str(2000) });
  check('Response.content: 2000 accepted', r.status === 201, r.body?.error);

  // Update reply 1..1000
  r = await api(u.token, 'POST', '/community/updates', { content: 'A post to reply to.' });
  const updId = r.body?.data?.id;
  r = await api(other.token, 'POST', `/community/updates/${updId}/replies`, { content: str(1001) });
  check('Update reply.content: 1001 rejected', r.status === 400, r.status);
  r = await api(other.token, 'POST', `/community/updates/${updId}/replies`, { content: str(1000) });
  check('Update reply.content: 1000 accepted', r.status === 201, r.body?.error);

  // Guide.steps: 1..30 entries, 2000 chars each
  r = await api(u.token, 'POST', '/community/guides',
    { topicCode: 'JOBS', title: str(20), intro: str(50), steps: [] });
  check('Guide.steps: empty rejected', r.status === 400, r.status);
  r = await api(u.token, 'POST', '/community/guides',
    { topicCode: 'JOBS', title: str(20), intro: str(50), steps: Array(31).fill(str(10)) });
  check('Guide.steps: 31 entries rejected', r.status === 400, r.status);
  r = await api(u.token, 'POST', '/community/guides',
    { topicCode: 'JOBS', title: str(20), intro: str(50), steps: [str(2001)] });
  check('Guide.steps: a 2001-char step rejected', r.status === 400, r.status);
  r = await api(u.token, 'POST', '/community/guides',
    { topicCode: 'JOBS', title: str(20), intro: str(50), steps: Array(30).fill(str(2000)) });
  check('Guide.steps: 30 entries of 2000 accepted', r.status === 201, r.body?.error?.message);

  // Group post / reply
  r = await api(u.token, 'POST', '/community/groups',
    { name: `Val ${Date.now()}`, description: str(50), cityId: 'MANCHESTER' });
  const groupId = r.body?.data?.id;
  r = await api(u.token, 'POST', `/community/groups/${groupId}/posts`, { content: str(2001) });
  check('Group post.content: 2001 rejected', r.status === 400, r.status);
  r = await api(u.token, 'POST', `/community/groups/${groupId}/posts`, { content: str(2000) });
  check('Group post.content: 2000 accepted', r.status === 201, r.body?.error);
  const postId = r.body?.data?.id;
  r = await api(u.token, 'POST', `/community/groups/${groupId}/posts/${postId}/replies`, { content: str(1001) });
  check('Group post reply.content: 1001 rejected', r.status === 400, r.status);
  r = await api(u.token, 'POST', `/community/groups/${groupId}/posts/${postId}/replies`, { content: str(1000) });
  check('Group post reply.content: 1000 accepted', r.status === 201, r.body?.error);

  // "All string fields are trimmed before validation, and a whitespace-only
  //  value counts as empty" (1.11).
  console.log('\n── 1.11 trimming rule ───────────────────────────────────────');
  r = await api(u.token, 'POST', '/community/updates', { content: '     ' });
  check('whitespace-only content counts as empty', r.status === 400, { status: r.status });
  r = await api(u.token, 'POST', '/community/requests',
    { categoryCode: 'JOBS', cityId: 'MANCHESTER', title: `   ${str(6)}   ` });
  check('padding is trimmed before the length check, not after', r.status === 201, r.body?.error?.message);

  console.log('\n── Cleanup ──────────────────────────────────────────────────');
  await sweep('cleanup');
  await finish();
})().catch(fail);
