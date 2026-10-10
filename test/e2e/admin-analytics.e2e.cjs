/* The dashboard and the Overview tab.
 *
 * Analytics is where a portal quietly lies. A number can be wrong in four ways that all look
 * plausible: the filter was ignored, the buckets were built with the wrong week boundary, a cached
 * payload came from somebody with different permissions, or a count of three people was shown to
 * somebody who then knew who they were. So the checks here are mostly about those four, plus the
 * rule that makes an attention badge worth having — the count equals the page it opens. */
const {
  adminHeaders,
  api,
  check,
  clearRateLimits,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

const Redis = require('ioredis');

/** The view is refreshed on a schedule, so a suite that creates members has to ask for it. */
async function refreshView(headers) {
  const res = await api(null, 'POST', '/admin/jobs/analytics.refresh-member-dimensions/run',
    null, headers);

  return res.status;
}

async function clearAnalyticsCache() {
  const redis = new Redis(process.env.REDIS_URL);

  try {
    const keys = await redis.keys('analytics:*');

    if (keys.length) await redis.del(...keys);
  } finally {
    await redis.quit();
  }
}

const today = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const shift = (days) => {
  const d = new Date(Date.parse(`${today()}T00:00:00Z`) + days * 86400000);

  return d.toISOString().slice(0, 10);
};

(async () => {
  await sweep('admin-analytics');
  await clearRateLimits();
  await clearAnalyticsCache();

  const admin = await makeAdmin('an-admin');
  const headers = adminHeaders(admin);
  const safety = await makeAdmin('an-safety', 'trust_safety');
  const safetyHeaders = adminHeaders(safety);
  const support = await makeAdmin('an-support', 'support');
  const supportHeaders = adminHeaders(support);

  console.log('\n— The member dimensions view (§8.2) —');

  check('the refresh job runs on demand', (await refreshView(headers)) === 200, 'no');

  const rows = await prisma.$queryRaw`SELECT COUNT(*)::int c FROM mv_member_dimensions`;

  check('the view has rows', rows[0].c > 0, rows[0].c);

  const staffInView = await prisma.$queryRaw`
    SELECT COUNT(*)::int c FROM mv_member_dimensions WHERE user_id = ${admin.id}::text`;

  check('and no staff account in it — staff are not members', staffInView[0].c === 0, staffInView[0].c);

  const ghost = await makeUser('an-ghost');

  await prisma.user.update({
    where: { id: ghost.id },
    data: { isAnonymised: true, anonymisedAt: new Date() },
  });
  await refreshView(headers);

  const ghostInView = await prisma.$queryRaw`
    SELECT COUNT(*)::int c FROM mv_member_dimensions WHERE user_id = ${ghost.id}::text`;

  check('nor an anonymised one', ghostInView[0].c === 0, ghostInView[0].c);

  console.log('\n— Dashboard KPIs —');

  let res = await api(null, 'GET', '/admin/dashboard/kpis', null, headers);
  check('kpis answer', res.status === 200, res.body?.error);

  const cards = res.body?.data?.cards ?? {};

  check('a super admin gets the member cards',
    !!cards.totalMembers && !!cards.newSignups && !!cards.dau && !!cards.mau && !!cards.stickiness,
    Object.keys(cards));
  check('and the operational ones their permissions allow',
    !!cards.openReports && !!cards.openGuardCases && !!cards.openRequests, Object.keys(cards));
  check('every card is a kpi with a unit',
    Object.values(cards).every(card => card.kind === 'kpi' && !!card.unit), cards.totalMembers);
  check('stickiness is a ratio, not a count', cards.stickiness?.unit === 'ratio', cards.stickiness);

  // The suppression floor counts members. A stickiness of 0.3 is "less than 10" and a daily
  // average of 9.1 is an average over the whole population — reading the floor as a magnitude test
  // meant neither could ever show a value, which is a category error rather than privacy.
  check('a ratio is not withheld for being small', typeof cards.stickiness?.value === 'number',
    cards.stickiness);
  check('nor is an average daily count', typeof cards.dau?.value === 'number', cards.dau);
  check('nor a headline member total — the population floor judges that, not its magnitude',
    typeof cards.totalMembers?.value === 'number', cards.totalMembers);
  check('but a sparkline point still is: each one is a single day\u2019s handful of people',
    (cards.newSignups?.sparkline ?? []).some(point => point.suppressed === true)
      || (cards.newSignups?.sparkline ?? []).every(point => (point.v ?? 0) === 0
        || (point.v ?? 0) >= 10),
    (cards.newSignups?.sparkline ?? []).filter(point => (point.v ?? 0) > 0 && (point.v ?? 0) < 10));

  res = await api(null, 'GET', '/admin/dashboard/kpis', null, supportHeaders);
  check('support has no analytics permission, so the member cards are omitted — not nulled',
    res.status === 200 && !('totalMembers' in (res.body?.data?.cards ?? {})),
    Object.keys(res.body?.data?.cards ?? {}));
  check('and they do get the one their role is responsible for',
    'openReports' in (res.body?.data?.cards ?? {}), Object.keys(res.body?.data?.cards ?? {}));

  res = await api(null, 'GET', '/admin/dashboard/kpis', null, safetyHeaders);
  check('trust & safety get guard cases', 'openGuardCases' in (res.body?.data?.cards ?? {}),
    Object.keys(res.body?.data?.cards ?? {}));

  res = await api(null, 'GET', '/admin/dashboard/kpis?heritage=WEST_AFRICAN', null, headers);
  check('the dashboard refuses a filter it does not apply, by name',
    res.status === 400 && JSON.stringify(res.body).includes('heritage'), res.body?.error);

  console.log('\n— Attention —');

  res = await api(null, 'GET', '/admin/dashboard/attention', null, headers);
  check('attention answers', res.status === 200 && Array.isArray(res.body?.data), res.body?.error);

  const items = res.body?.data ?? [];

  check('no item has a count of zero', items.every(item => item.count > 0), items);
  check('every href is a portal-relative path',
    items.every(item => typeof item.href === 'string' && item.href.startsWith('/')), items);
  check('severity leads the sort',
    items.every((item, index) =>
      index === 0
        || ['critical', 'high', 'normal'].indexOf(items[index - 1].severity)
           <= ['critical', 'high', 'normal'].indexOf(item.severity)),
    items.map(item => item.severity));
  check('and count breaks the tie, descending',
    items.every((item, index) =>
      index === 0
        || items[index - 1].severity !== item.severity
        || items[index - 1].count >= item.count),
    items.map(item => [item.severity, item.count]));

  // The rule that makes a badge worth having: it equals the page it opens.
  const anonItem = items.find(item => item.id === 'pendingAnonymousPosts');

  if (anonItem) {
    const queued = await prisma.moderationQueueItem.count({
      where: { type: 'ANONYMOUS_POST', state: { in: ['PENDING', 'IN_REVIEW'] } },
    });

    check('the anonymous-posts badge equals the queue it links to', anonItem.count === queued,
      { badge: anonItem.count, queue: queued });
    check('and carries the age of the oldest one', !!anonItem.oldestAt, anonItem);
  } else {
    check('the anonymous-posts badge is absent because the queue is empty', true, 'omitted');
  }

  res = await api(null, 'GET', '/admin/dashboard/attention', null, supportHeaders);
  check('support see no Guard item — that is a different job',
    !(res.body?.data ?? []).some(item => item.id === 'criticalGuardCases'),
    (res.body?.data ?? []).map(item => item.id));

  console.log('\n— Staff activity —');

  res = await api(null, 'GET', '/admin/dashboard/staff-activity', null, headers);
  check('the last twenty entries come back',
    res.status === 200 && (res.body?.data ?? []).length <= 20, res.body?.data?.length);
  check('newest first', (res.body?.data ?? []).every((row, i, all) =>
    i === 0 || all[i - 1].occurredAt >= row.occurredAt), 'out of order');

  res = await api(null, 'GET', '/admin/dashboard/staff-activity', null, supportHeaders);
  check('audit:read_self sees only its own, which here is nothing',
    res.status === 200 && (res.body?.data ?? []).every(row => row.actor?.id === support.id),
    (res.body?.data ?? []).map(row => row.action));

  console.log('\n— Analytics: the Overview tab —');

  res = await api(null, 'GET', '/admin/analytics/overview', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check('with every chart of the tab',
    ['kpis', 'signups', 'activeMembers', 'activityBySection', 'topCities', 'cityMap']
      .every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}));
  check('and no chart came back as an error',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {})
      .filter(([, chart]) => chart.kind === 'error'));
  check('the range is echoed with its timezone',
    res.body?.data?.range?.timezone === 'Europe/London' && !!res.body?.data?.range?.from,
    res.body?.data?.range);
  check('the default range is thirty days',
    res.body?.data?.range?.from === shift(-29) && res.body?.data?.range?.to === today(),
    res.body?.data?.range);
  check('and the granularity is day at thirty days',
    res.body?.data?.range?.granularity === 'day', res.body?.data?.range);

  const overview = res.body.data.charts;

  check('activityBySection stacks the four sections',
    overview.activityBySection?.series?.map(s => s.key).join() === 'COMMUNITY,PROFESSIONALS,CONNECT,COMMERCE',
    overview.activityBySection?.series?.map(s => s.key));
  check('a series has one point per bucket',
    overview.signups?.series?.[0]?.points?.length === 30,
    overview.signups?.series?.[0]?.points?.length);
  check('every point is a London date',
    overview.signups?.series?.[0]?.points?.every(p => /^\d{4}-\d{2}-\d{2}$/.test(p.t)),
    overview.signups?.series?.[0]?.points?.[0]);
  check('topCities shares sum to one over the unsuppressed items',
    (overview.topCities?.items ?? []).every(item => item.share === null
      || (item.share >= 0 && item.share <= 1)),
    overview.topCities?.items);
  check('cityMap points carry coordinates',
    (overview.cityMap?.points ?? []).every(p => typeof p.lat === 'number'),
    overview.cityMap?.points?.[0]);

  // Two numbers for one city on one page. The map used to count every member while the breakdown
  // counted those who had signed up by the end of the range.
  const mapByCity = new Map((overview.cityMap?.points ?? []).map(p => [p.cityId, p.value]));
  const disagreeing = (overview.topCities?.items ?? []).filter(
    item => mapByCity.has(item.key) && item.value !== null
      && mapByCity.get(item.key) !== item.value,
  );

  check('and agree with the breakdown, city for city', disagreeing.length === 0, disagreeing);

  res = await api(null, 'GET', `/admin/analytics/overview?from=${shift(-200)}&to=${today()}`, null, headers);
  check('a 201-day range picks week granularity on its own',
    res.body?.data?.range?.granularity === 'week', res.body?.data?.range);
  check('and the buckets start on Mondays',
    (res.body?.data?.charts?.signups?.series?.[0]?.points ?? [])
      .slice(1)
      .every(p => new Date(`${p.t}T00:00:00Z`).getUTCDay() === 1),
    (res.body?.data?.charts?.signups?.series?.[0]?.points ?? []).slice(0, 4).map(p => p.t));

  res = await api(null, 'GET',
    `/admin/analytics/overview?from=${shift(-800)}&to=${today()}&granularity=day`, null, headers);
  check('a day range over 366 days is refused',
    res.status === 400 && res.body?.error?.code === 'FILTER_RANGE_TOO_LARGE', res.body?.error);

  console.log('\n— compare —');

  res = await api(null, 'GET', '/admin/analytics/overview?compare=true&charts=signups', null, headers);
  check('compare adds the previous period to the range',
    !!res.body?.data?.range?.previousFrom && !!res.body?.data?.range?.previousTo,
    res.body?.data?.range);
  check('and a previous series of the same length',
    res.body?.data?.charts?.signups?.series?.[0]?.previous?.length
      === res.body?.data?.charts?.signups?.series?.[0]?.points?.length,
    {
      now: res.body?.data?.charts?.signups?.series?.[0]?.points?.length,
      was: res.body?.data?.charts?.signups?.series?.[0]?.previous?.length,
    });

  console.log('\n— The charts selector —');

  res = await api(null, 'GET', '/admin/analytics/overview?charts=topCities', null, headers);
  check('charts= narrows the response to one',
    Object.keys(res.body?.data?.charts ?? {}).join() === 'topCities',
    Object.keys(res.body?.data?.charts ?? {}));

  res = await api(null, 'GET', '/admin/analytics/overview?charts=notAChart', null, headers);
  check('an unknown chart id is a 400, never silence',
    res.status === 400 && JSON.stringify(res.body).includes('notAChart'), res.body?.error);

  res = await api(null, 'GET', '/admin/analytics/notATab', null, headers);
  check('an unknown tab is a 400', res.status === 400, res.body?.error);

  // Whichever tabs are still unbuilt must say so rather than returning an empty one, which the
  // portal cannot tell apart from "no data in this range".
  const unbuilt = [];

  for (const tab of ['professionals', 'connect', 'commerce', 'deals', 'search', 'trust-safety',
    'support', 'staff']) {
    const probe = await api(null, 'GET', `/admin/analytics/${tab}`, null, headers);

    if (probe.status === 400 && probe.body?.error?.code === 'NOT_AVAILABLE_YET') unbuilt.push(tab);
    else if (probe.status !== 200) console.log(`    ${tab} answered ${probe.status}`);
  }

  check('every tab either answers or says it has not shipped', unbuilt.length > 0, unbuilt);

  console.log('\n— Permissions —');

  res = await api(null, 'GET', '/admin/analytics/overview', null, safetyHeaders);
  check('trust & safety hold analytics:safety, not analytics:read — Overview is refused',
    res.status === 403, res.status);

  res = await api(null, 'GET', '/admin/analytics/overview', null, supportHeaders);
  check('and support have neither', res.status === 403, res.status);

  console.log('\n— Filters reach the charts —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/overview?cityIds=LONDON&charts=topCities',
    null, headers);
  check('a city filter narrows the breakdown to that city',
    (res.body?.data?.charts?.topCities?.items ?? []).every(item => item.key === 'LONDON'),
    res.body?.data?.charts?.topCities?.items);
  check('and the response says which filters it applied',
    (res.body?.meta?.filtersApplied ?? []).includes('cityIds'), res.body?.meta);

  res = await api(null, 'GET', '/admin/analytics/overview?cityIds=ATLANTIS', null, headers);
  check('an unknown city is refused here too',
    res.status === 400 && res.body?.error?.code === 'UNKNOWN_CITY', res.body?.error);

  console.log('\n— Suppression (§2.7) —');

  // A heritage tag nothing else uses, so the population is exactly these three.
  const tiny = [];

  for (let i = 0; i < 3; i += 1) {
    tiny.push(await makeUser(`an-tiny-${i}`, { cityId: 'LONDON', heritageTag: 'SOUTH_ASIAN' }));
  }

  await prisma.$executeRawUnsafe(
    `UPDATE user_profile SET heritage_tag = NULL WHERE heritage_tag = 'SOUTH_ASIAN' AND user_id NOT IN (${tiny.map(u => `'${u.id}'`).join(',')})`,
  );
  await refreshView(headers);
  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/overview?heritage=SOUTH_ASIAN', null, headers);
  check('a population under ten suppresses the whole response',
    res.body?.meta?.populationSuppressed === true, res.body?.meta);
  check('every member number is withheld rather than zeroed',
    res.body?.data?.charts?.kpis?.items?.totalMembers?.value === null
      && res.body.data.charts.kpis.items.totalMembers.suppressed === true,
    res.body?.data?.charts?.kpis?.items?.totalMembers);
  check('and so is every point of every series',
    (res.body?.data?.charts?.signups?.series?.[0]?.points ?? [])
      .every(point => point.v === null && point.suppressed === true),
    res.body?.data?.charts?.signups?.series?.[0]?.points?.slice(0, 2));
  check('including the breakdown total',
    res.body?.data?.charts?.topCities?.total === null, res.body?.data?.charts?.topCities);

  res = await api(null, 'GET', '/admin/analytics/overview', null, headers);
  check('and the unfiltered response is not suppressed',
    res.body?.meta?.populationSuppressed === undefined
      && res.body?.data?.charts?.kpis?.items?.totalMembers?.value > 0,
    res.body?.data?.charts?.kpis?.items?.totalMembers);

  // The floor is "when member-attribute filters narrow the population below 10". A date range is
  // not a member-attribute filter, so a quiet week must not blank the dashboard.
  res = await api(null, 'GET',
    `/admin/analytics/overview?from=${shift(-1)}&to=${today()}&charts=kpis`, null, headers);
  check('a narrow date range alone never triggers the population floor',
    res.body?.meta?.populationSuppressed === undefined
      && res.body?.data?.charts?.kpis?.items?.totalMembers?.value > 0,
    res.body?.meta);

  console.log('\n— Caching (§8.4) —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/overview?charts=topCities', null, headers);
  check('the first request is a miss', res.body?.meta?.cache?.hit === false, res.body?.meta?.cache);

  res = await api(null, 'GET', '/admin/analytics/overview?charts=topCities', null, headers);
  check('the second is a hit', res.body?.meta?.cache?.hit === true, res.body?.meta?.cache);
  check('with a TTL that reflects a range including today',
    res.body?.meta?.cache?.ttlSeconds === 300, res.body?.meta?.cache);

  res = await api(null, 'GET',
    `/admin/analytics/overview?charts=topCities&from=${shift(-60)}&to=${shift(-31)}`, null, headers);
  check('a historical range is cached for longer', res.body?.meta?.cache?.ttlSeconds === 3600,
    res.body?.meta?.cache);

  // Array order must not create a second cache entry.
  await clearAnalyticsCache();
  await api(null, 'GET', '/admin/analytics/overview?cityIds=LONDON,MANCHESTER&charts=topCities',
    null, headers);
  res = await api(null, 'GET', '/admin/analytics/overview?cityIds=MANCHESTER,LONDON&charts=topCities',
    null, headers);
  check('filter arrays are normalised, so the order of two cities is one cache entry',
    res.body?.meta?.cache?.hit === true, res.body?.meta?.cache);

  console.log('\n— Analytics: Growth & Retention —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/growth', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check('with all eleven charts',
    ['signups', 'cumulativeMembers', 'activeMembers', 'stickiness', 'retentionCohorts',
      'retentionDn', 'onboardingFunnel', 'signupMethods', 'platforms', 'appVersionAdoption',
      'newReturningReactivated'].every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}));
  check('and none of them failed',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {})
      .filter(([, chart]) => chart.kind === 'error').map(([id, c]) => [id, c.code]));

  const growth = res.body.data.charts;

  // The membership curve is a balance, not a running total of sign-ups: people leave. Built from
  // three sums that have to agree about who counts, or it drifts below zero — which it did.
  const curve = growth.cumulativeMembers?.series?.[0]?.points ?? [];

  check('the membership curve never goes negative',
    curve.every(point => point.v === null || point.v >= 0),
    curve.filter(point => (point.v ?? 0) < 0));
  check('and ends at roughly the live member count',
    Math.abs((curve[curve.length - 1]?.v ?? 0)
      - (await prisma.user.count({
        where: { isStaff: false, deletedAt: null, isAnonymised: false },
      }))) <= 1,
    curve[curve.length - 1]);

  check('activeMembers carries the three windows',
    growth.activeMembers?.series?.map(s => s.key).join() === 'dau,wau,mau',
    growth.activeMembers?.series?.map(s => s.key));
  check('and a weekly window is never smaller than the daily one inside it',
    growth.activeMembers?.series?.[0]?.points?.every((point, index) => {
      const wau = growth.activeMembers.series[1].points[index].v;

      return point.v === null || wau === null || wau >= point.v;
    }),
    'dau exceeded wau');
  check('nor a monthly one smaller than the weekly',
    growth.activeMembers?.series?.[1]?.points?.every((point, index) => {
      const mau = growth.activeMembers.series[2].points[index].v;

      return point.v === null || mau === null || mau >= point.v;
    }),
    'wau exceeded mau');

  check('stickiness is a ratio series, on its own chart',
    growth.stickiness?.unit === 'ratio' && growth.stickiness?.series?.length === 1,
    growth.stickiness?.unit);
  check('and every point is a fraction or withheld',
    (growth.stickiness?.series?.[0]?.points ?? [])
      .every(point => point.v === null || (point.v >= 0 && point.v <= 1)),
    growth.stickiness?.series?.[0]?.points?.slice(0, 3));

  check('the cohort grid is monthly and bounded',
    growth.retentionCohorts?.period === 'month'
      && (growth.retentionCohorts?.cohorts ?? []).length <= 18,
    growth.retentionCohorts?.cohorts?.length);
  check('every cohort is a YYYY-MM with a retention row',
    (growth.retentionCohorts?.cohorts ?? [])
      .every(c => /^\d{4}-\d{2}$/.test(c.cohort) && Array.isArray(c.retention)),
    growth.retentionCohorts?.cohorts?.[0]);
  // The grid is as wide as the furthest month anybody reached. Sized by the *count* of months a
  // cohort was active in, a cohort active in months 0 and 5 and nowhere between lost its month-5
  // figure off the end of its own row.
  check('the grid is wide enough for the oldest cohort\u2019s age',
    (growth.retentionCohorts?.cohorts ?? []).length === 0
      || growth.retentionCohorts.cohorts[0].retention.length
         >= growth.retentionCohorts.cohorts[growth.retentionCohorts.cohorts.length - 1]
            .retention.length,
    (growth.retentionCohorts?.cohorts ?? []).map(c => [c.cohort, c.retention.length]));
  check('and every row is the same width',
    new Set((growth.retentionCohorts?.cohorts ?? []).map(c => c.retention.length)).size <= 1,
    (growth.retentionCohorts?.cohorts ?? []).map(c => c.retention.length));

  check('a cohort under ten is withheld whole — size and every cell',
    (growth.retentionCohorts?.cohorts ?? [])
      .every(c => c.size !== null || c.retention.every(cell => cell === null)),
    growth.retentionCohorts?.cohorts?.find(c => c.size === null));

  check('retentionDn is the three figures plus a trend',
    ['d1', 'd7', 'd30', 'trend'].every(id => id in (growth.retentionDn?.items ?? {})),
    Object.keys(growth.retentionDn?.items ?? {}));
  check('each Dn is a ratio, or null where the cohort is too small to say',
    ['d1', 'd7', 'd30'].every(id => {
      const value = growth.retentionDn.items[id].value;

      return value === null || (value >= 0 && value <= 1);
    }),
    ['d1', 'd7', 'd30'].map(id => growth.retentionDn.items[id].value));

  check('the onboarding funnel has its five steps in order',
    growth.onboardingFunnel?.steps?.map(s => s.key).join()
      === 'registered,profile,arrival,interests,firstAction',
    growth.onboardingFunnel?.steps?.map(s => s.key));
  check('and no step exceeds the one before it',
    growth.onboardingFunnel?.steps?.every((step, index, all) =>
      index === 0 || step.value === null || all[index - 1].value === null
        || step.value <= all[index - 1].value),
    growth.onboardingFunnel?.steps?.map(s => s.value));

  check('newReturningReactivated stacks the three',
    growth.newReturningReactivated?.series?.map(s => s.key).join() === 'new,returning,reactivated',
    growth.newReturningReactivated?.series?.map(s => s.key));

  check('appVersionAdoption caps at six bands plus other',
    (growth.appVersionAdoption?.series ?? []).length <= 7,
    growth.appVersionAdoption?.series?.map(s => s.key));

  res = await api(null, 'GET',
    '/admin/analytics/growth?charts=cumulativeMembers&cityIds=LONDON', null, headers);
  check('a filtered membership curve accumulates the population and never subtracts',
    (res.body?.data?.charts?.cumulativeMembers?.series?.[0]?.points ?? [])
      .every((point, index, all) => index === 0 || point.v === null
        || all[index - 1].v === null || point.v >= all[index - 1].v),
    'filtered curve fell');

  console.log('\n— Analytics: Demographics —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/demographics', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check('with all nine charts',
    ['gender', 'ageBands', 'genderByAge', 'countries', 'heritage', 'journeyStages', 'interests',
      'languages', 'cityByJourneyStage'].every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}));
  check('and none of them failed',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {})
      .filter(([, chart]) => chart.kind === 'error').map(([id, c]) => [id, c.code]));

  const demo = res.body.data.charts;

  check('every breakdown shares one total — the population', [
    demo.gender, demo.ageBands, demo.countries, demo.heritage, demo.journeyStages,
  ].every(chart => chart.total === demo.gender.total), {
    gender: demo.gender?.total, countries: demo.countries?.total, heritage: demo.heritage?.total,
  });

  // A group nobody is in is information. A bar chart that silently drops it reads as though the
  // option does not exist.
  check('a journey stage with no members is kept, at zero',
    demo.journeyStages?.items?.some(item => item.value === 0), demo.journeyStages?.items);
  check('and the stages keep the taxonomy\u2019s own order — this is a funnel',
    demo.journeyStages?.items?.[0]?.key === 'PLANNING', demo.journeyStages?.items?.map(i => i.key));
  check('age bands are ordered youngest first, with the unknown last',
    demo.ageBands?.items?.map(item => item.key).join()
      === 'AGE_18_24,AGE_25_34,AGE_35_44,AGE_45_PLUS,UNKNOWN',
    demo.ageBands?.items?.map(item => item.key));
  check('"not set" is a labelled group, not a gap',
    demo.heritage?.items?.some(item => item.key === 'UNKNOWN' && item.label === 'Not set'),
    demo.heritage?.items?.find(item => item.key === 'UNKNOWN'));
  check('countries are named from ICU, not from a code',
    demo.countries?.items?.some(item => item.key === 'NG' && item.label === 'Nigeria'),
    demo.countries?.items?.[0]);
  check('and capped at fifteen with the rest as `other`',
    demo.countries?.items?.length <= 15, demo.countries?.items?.length);

  // Multi-valued: a member with four interests is in four groups, so the shares must be over the
  // member count. Divided by the sum of the groups they would add to four hundred per cent.
  const interestShares = (demo.interests?.items ?? [])
    .map(item => item.share)
    .filter(share => share !== null);

  check('an interest share is a fraction of members, never above one',
    interestShares.every(share => share >= 0 && share <= 1), interestShares.slice(0, 3));
  check('and the shares may sum above one, because a member holds several',
    interestShares.reduce((sum, share) => sum + share, 0) > 1,
    interestShares.reduce((sum, share) => sum + share, 0));
  check('capped at twenty', (demo.interests?.items ?? []).length <= 20,
    demo.interests?.items?.length);

  check('genderByAge is bands by genders, with every declared cell present',
    demo.genderByAge?.rows?.length === demo.genderByAge?.cells?.length
      && demo.genderByAge.cells.every(row => row.length === demo.genderByAge.cols.length),
    { rows: demo.genderByAge?.rows?.length, cols: demo.genderByAge?.cols?.length });
  check('and withheld cells are listed by coordinate for the portal to shade',
    (demo.genderByAge?.suppressed ?? []).every(([r, c]) => demo.genderByAge.cells[r][c] === null),
    demo.genderByAge?.suppressed);
  check('a zero cell is shown — zero identifies nobody',
    demo.genderByAge?.cells?.flat().includes(0), demo.genderByAge?.cells?.[0]);

  check('cityByJourneyStage is capped at fifteen cities',
    (demo.cityByJourneyStage?.rows ?? []).length <= 15,
    demo.cityByJourneyStage?.rows?.length);
  check('and names them rather than showing their ids',
    (demo.cityByJourneyStage?.rows ?? []).every(row => row.label !== row.key)
      || (demo.cityByJourneyStage?.rows ?? []).length === 0,
    demo.cityByJourneyStage?.rows);

  res = await api(null, 'GET',
    `/admin/analytics/demographics?population=signups&from=${shift(-2)}&to=${today()}&charts=gender`,
    null, headers);
  check('population=signups narrows to those who joined in the range',
    res.status === 200 && res.body?.data?.charts?.gender?.total < demo.gender.total,
    { signups: res.body?.data?.charts?.gender?.total, all: demo.gender?.total });

  res = await api(null, 'GET', '/admin/analytics/demographics?population=everyone', null, headers);
  check('an unknown population mode is refused', res.status === 400, res.body?.error);

  res = await api(null, 'GET', '/admin/analytics/demographics?charts=heritage&heritage=SOUTH_ASIAN',
    null, headers);
  check('and the tab honours the shared filter too',
    res.body?.meta?.populationSuppressed === true, res.body?.meta);

  console.log('\n— Analytics: Community —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/community', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check('with all ten charts',
    ['created', 'requestsByCategory', 'requestOutcomes', 'responseTimes', 'unansweredByCity',
      'visibilityMix', 'topGuides', 'guideDeflection', 'groups', 'engagement']
      .every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}));
  check('and none of them failed',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {})
      .filter(([, chart]) => chart.kind === 'error').map(([id, c]) => [id, c.code]));

  // A content tab's `cityIds` narrows the content's city, not the author's — and a reader
  // comparing two tabs has no other way to know which.
  check('the response says what cityIds means on a content tab',
    typeof res.body?.meta?.filterSemantics?.cityIds === 'string', res.body?.meta?.filterSemantics);

  const comm = res.body.data.charts;

  check('created stacks requests, offers and posts',
    comm.created?.series?.map(s => s.key).join() === 'requests,offers,posts',
    comm.created?.series?.map(s => s.key));
  check('and counts things, not members', comm.created?.unit === 'count', comm.created?.unit);

  check('request outcomes keep their order, with EXPIRED folded in as the fourth',
    comm.requestOutcomes?.items?.map(i => i.key).join()
      === 'HELPED,SOLVED_ELSEWHERE,NO_LONGER_NEEDED,EXPIRED',
    comm.requestOutcomes?.items?.map(i => i.key));

  check('responseTimes is two medians and a trend, in minutes',
    ['medianFirstResponse', 'medianResolution', 'trend']
      .every(id => id in (comm.responseTimes?.items ?? {}))
      && comm.responseTimes.items.medianFirstResponse.unit === 'minutes',
    Object.keys(comm.responseTimes?.items ?? {}));
  check('and a bucket with no resolved request is null, not zero minutes',
    (comm.responseTimes?.items?.trend?.series?.[1]?.points ?? [])
      .every(point => point.v === null || point.v > 0),
    comm.responseTimes?.items?.trend?.series?.[1]?.points?.slice(0, 3));

  check('visibilityMix keeps the three visibilities in order',
    comm.visibilityMix?.items?.map(i => i.key).join() === 'PUBLIC,ANONYMOUS,PRIVATE_TO_CIRCL',
    comm.visibilityMix?.items?.map(i => i.key));

  check('topGuides is a table with named columns',
    comm.topGuides?.kind === 'table'
      && comm.topGuides.columns.some(c => c.key === 'uniqueReaders'),
    comm.topGuides?.columns?.map(c => c.key));
  check('and at most twenty rows', (comm.topGuides?.rows ?? []).length <= 20,
    comm.topGuides?.rows?.length);

  check('guideDeflection is a gauge plus a trend',
    comm.guideDeflection?.items?.rate?.kind === 'gauge'
      && comm.guideDeflection?.items?.trend?.kind === 'timeseries',
    Object.keys(comm.guideDeflection?.items ?? {}));
  check('and the rate is a percentage or null where nobody was shown a guide',
    comm.guideDeflection?.items?.rate?.value === null
      || (comm.guideDeflection.items.rate.value >= 0
          && comm.guideDeflection.items.rate.value <= 100),
    comm.guideDeflection?.items?.rate);

  check('groups is growth plus the most active table',
    comm.groups?.items?.growth?.series?.map(s => s.key).join()
      === 'groupsCreated,membershipsJoined'
      && comm.groups?.items?.mostActive?.kind === 'table',
    Object.keys(comm.groups?.items ?? {}));

  check('engagement is two ratios',
    comm.engagement?.unit === 'ratio'
      && comm.engagement.series.map(s => s.key).join() === 'repliesPerPost,reactionsPerPost',
    comm.engagement?.series?.map(s => s.key));
  check('and a bucket with no posts is null rather than a zero rate',
    (comm.engagement?.series?.[0]?.points ?? []).every(point => point.v === null || point.v >= 0),
    comm.engagement?.series?.[0]?.points?.slice(0, 3));

  res = await api(null, 'GET',
    '/admin/analytics/community?charts=requestsByCategory&categories=HOUSING', null, headers);
  check('a category filter narrows the breakdown',
    (res.body?.data?.charts?.requestsByCategory?.items ?? [])
      .every(item => item.key === 'HOUSING'),
    res.body?.data?.charts?.requestsByCategory?.items);

  res = await api(null, 'GET',
    '/admin/analytics/community?charts=visibilityMix&visibility=PUBLIC', null, headers);
  check('and a visibility filter does too',
    (res.body?.data?.charts?.visibilityMix?.items ?? [])
      .every(item => item.key !== 'PUBLIC' ? (item.value ?? 0) === 0 : true),
    res.body?.data?.charts?.visibilityMix?.items);

  res = await api(null, 'GET', '/admin/analytics/community?visibility=SECRET', null, headers);
  check('an unknown visibility is refused', res.status === 400, res.body?.error);

  // Every declared tab filter has to reach at least one chart. `requestStatuses` was accepted and
  // applied to nothing, so the reader got a chart answering a different question under the heading
  // they had chosen — which is worse than a filter the endpoint refuses outright.
  const unfiltered = await api(null, 'GET',
    '/admin/analytics/community?charts=requestsByCategory', null, headers);
  const narrowed = {
    categories: await api(null, 'GET',
      '/admin/analytics/community?charts=requestsByCategory&categories=HOUSING', null, headers),
    requestStatuses: await api(null, 'GET',
      '/admin/analytics/community?charts=requestsByCategory&requestStatuses=RESOLVED',
      null, headers),
    visibility: await api(null, 'GET',
      '/admin/analytics/community?charts=requestsByCategory&visibility=ANONYMOUS', null, headers),
    cityIds: await api(null, 'GET',
      '/admin/analytics/community?charts=requestsByCategory&cityIds=LONDON', null, headers),
  };
  const baseline = unfiltered.body?.data?.charts?.requestsByCategory?.total;
  const ignored = Object.entries(narrowed)
    .filter(([, probe]) => probe.body?.data?.charts?.requestsByCategory?.total === baseline)
    .map(([name]) => name);

  check('every tab filter reaches the charts rather than being silently ignored',
    ignored.length === 0,
    { baseline, ignored, totals: Object.fromEntries(Object.entries(narrowed)
      .map(([k, v]) => [k, v.body?.data?.charts?.requestsByCategory?.total])) });

  console.log('\n— The guard stack —');

  res = await api(null, 'GET', '/admin/analytics/overview', null, {});
  check('no token, no analytics', res.status === 401 || res.status === 404, res.status);

  res = await api(null, 'GET', '/admin/dashboard/charts?notAField=1', null, headers);
  check('an unknown query field is refused by name',
    res.status === 400 && JSON.stringify(res.body).includes('notAField'), res.body?.error);

  await sweep('admin-analytics');
  await refreshView(headers);
  await finish();
})().catch(async error => {
  console.error(error);
  process.exit(1);
});
