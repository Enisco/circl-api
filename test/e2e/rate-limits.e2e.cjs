const { api, check, fail, finish, makeUser, sweep } = require('./harness.cjs');
(async () => {
  await sweep('pre-run');
  const heavy = await makeUser('rlh');
  const light = await makeUser('rll');

  // Exhaust one member's report allowance.
  const r0 = await api(heavy.token, 'POST', '/community/requests', {
    categoryCode: 'JOBS', title: 'A target for the report limit check', cityId: 'MANCHESTER',
  });
  const targetId = r0.body?.data?.id;

  let blocked = false;
  for (let i = 0; i < 12; i++) {
    const r = await api(light.token, 'POST', '/moderation/reports', {
      targetType: 'REQUEST', targetId, reasonCode: 'SPAM',
    });
    if (r.status === 429) { blocked = true; break; }
  }
  check('one member exhausts their own report allowance', blocked === true);

  // A different member on the same IP must be unaffected.
  const other = await makeUser('rlo');
  const r = await api(other.token, 'POST', '/moderation/reports', {
    targetType: 'REQUEST', targetId, reasonCode: 'SPAM',
  });
  check('a DIFFERENT member on the same IP is unaffected', r.status === 202, { status: r.status, err: r.body?.error?.code });

  await sweep('cleanup');
  await finish();
})().catch(fail);
