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
  forgetCacheKeys,
  makeAdmin,
  makeUser,
  prisma,
  sweep,
} = require('./harness.cjs');

const Redis = require('ioredis');

/** The view is refreshed on a schedule, so a suite that creates members has to ask for it. */
async function refreshView(headers) {
  const res = await api(
    null,
    'POST',
    '/admin/jobs/analytics.refresh-member-dimensions/run',
    null,
    headers,
  );

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

const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const shift = days => {
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

  check(
    'and no staff account in it — staff are not members',
    staffInView[0].c === 0,
    staffInView[0].c,
  );

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

  check(
    'a super admin gets the member cards',
    !!cards.totalMembers && !!cards.newSignups && !!cards.dau && !!cards.mau && !!cards.stickiness,
    Object.keys(cards),
  );
  check(
    'and the operational ones their permissions allow',
    !!cards.openReports && !!cards.openGuardCases && !!cards.openRequests,
    Object.keys(cards),
  );
  check(
    'every card is a kpi with a unit',
    Object.values(cards).every(card => card.kind === 'kpi' && !!card.unit),
    cards.totalMembers,
  );
  check('stickiness is a ratio, not a count', cards.stickiness?.unit === 'ratio', cards.stickiness);

  // The suppression floor counts members. A stickiness of 0.3 is "less than 10" and a daily
  // average of 9.1 is an average over the whole population — reading the floor as a magnitude test
  // meant neither could ever show a value, which is a category error rather than privacy.
  check(
    'a ratio is not withheld for being small',
    typeof cards.stickiness?.value === 'number',
    cards.stickiness,
  );
  check('nor is an average daily count', typeof cards.dau?.value === 'number', cards.dau);
  check(
    'nor a headline member total — the population floor judges that, not its magnitude',
    typeof cards.totalMembers?.value === 'number',
    cards.totalMembers,
  );
  check(
    'but a sparkline point still is: each one is a single day\u2019s handful of people',
    (cards.newSignups?.sparkline ?? []).some(point => point.suppressed === true) ||
      (cards.newSignups?.sparkline ?? []).every(
        point => (point.v ?? 0) === 0 || (point.v ?? 0) >= 10,
      ),
    (cards.newSignups?.sparkline ?? []).filter(point => (point.v ?? 0) > 0 && (point.v ?? 0) < 10),
  );

  res = await api(null, 'GET', '/admin/dashboard/kpis', null, supportHeaders);
  check(
    'support has no analytics permission, so the member cards are omitted — not nulled',
    res.status === 200 && !('totalMembers' in (res.body?.data?.cards ?? {})),
    Object.keys(res.body?.data?.cards ?? {}),
  );
  check(
    'and they do get the one their role is responsible for',
    'openReports' in (res.body?.data?.cards ?? {}),
    Object.keys(res.body?.data?.cards ?? {}),
  );

  res = await api(null, 'GET', '/admin/dashboard/kpis', null, safetyHeaders);
  check(
    'trust & safety get guard cases',
    'openGuardCases' in (res.body?.data?.cards ?? {}),
    Object.keys(res.body?.data?.cards ?? {}),
  );

  res = await api(null, 'GET', '/admin/dashboard/kpis?heritage=WEST_AFRICAN', null, headers);
  check(
    'the dashboard refuses a filter it does not apply, by name',
    res.status === 400 && JSON.stringify(res.body).includes('heritage'),
    res.body?.error,
  );

  console.log('\n— Attention —');

  res = await api(null, 'GET', '/admin/dashboard/attention', null, headers);
  check('attention answers', res.status === 200 && Array.isArray(res.body?.data), res.body?.error);

  const items = res.body?.data ?? [];

  check(
    'no item has a count of zero',
    items.every(item => item.count > 0),
    items,
  );
  check(
    'every href is a portal-relative path',
    items.every(item => typeof item.href === 'string' && item.href.startsWith('/')),
    items,
  );
  check(
    'severity leads the sort',
    items.every(
      (item, index) =>
        index === 0 ||
        ['critical', 'high', 'normal'].indexOf(items[index - 1].severity) <=
          ['critical', 'high', 'normal'].indexOf(item.severity),
    ),
    items.map(item => item.severity),
  );
  check(
    'and count breaks the tie, descending',
    items.every(
      (item, index) =>
        index === 0 ||
        items[index - 1].severity !== item.severity ||
        items[index - 1].count >= item.count,
    ),
    items.map(item => [item.severity, item.count]),
  );

  // The rule that makes a badge worth having: it equals the page it opens.
  const anonItem = items.find(item => item.id === 'pendingAnonymousPosts');

  if (anonItem) {
    const queued = await prisma.moderationQueueItem.count({
      where: { type: 'ANONYMOUS_POST', state: { in: ['PENDING', 'IN_REVIEW'] } },
    });

    check('the anonymous-posts badge equals the queue it links to', anonItem.count === queued, {
      badge: anonItem.count,
      queue: queued,
    });
    check('and carries the age of the oldest one', !!anonItem.oldestAt, anonItem);
  } else {
    check('the anonymous-posts badge is absent because the queue is empty', true, 'omitted');
  }

  res = await api(null, 'GET', '/admin/dashboard/attention', null, supportHeaders);
  check(
    'support see no Guard item — that is a different job',
    !(res.body?.data ?? []).some(item => item.id === 'criticalGuardCases'),
    (res.body?.data ?? []).map(item => item.id),
  );

  console.log('\n— Staff activity —');

  res = await api(null, 'GET', '/admin/dashboard/staff-activity', null, headers);
  check(
    'the last twenty entries come back',
    res.status === 200 && (res.body?.data ?? []).length <= 20,
    res.body?.data?.length,
  );
  check(
    'newest first',
    (res.body?.data ?? []).every(
      (row, i, all) => i === 0 || all[i - 1].occurredAt >= row.occurredAt,
    ),
    'out of order',
  );

  res = await api(null, 'GET', '/admin/dashboard/staff-activity', null, supportHeaders);
  check(
    'audit:read_self sees only its own, which here is nothing',
    res.status === 200 && (res.body?.data ?? []).every(row => row.actor?.id === support.id),
    (res.body?.data ?? []).map(row => row.action),
  );

  console.log('\n— Analytics: the Overview tab —');

  res = await api(null, 'GET', '/admin/analytics/overview', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check(
    'with every chart of the tab',
    ['kpis', 'signups', 'activeMembers', 'activityBySection', 'topCities', 'cityMap'].every(
      id => id in (res.body?.data?.charts ?? {}),
    ),
    Object.keys(res.body?.data?.charts ?? {}),
  );
  check(
    'and no chart came back as an error',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {}).filter(([, chart]) => chart.kind === 'error'),
  );
  check(
    'the range is echoed with its timezone',
    res.body?.data?.range?.timezone === 'Europe/London' && !!res.body?.data?.range?.from,
    res.body?.data?.range,
  );
  check(
    'the default range is thirty days',
    res.body?.data?.range?.from === shift(-29) && res.body?.data?.range?.to === today(),
    res.body?.data?.range,
  );
  check(
    'and the granularity is day at thirty days',
    res.body?.data?.range?.granularity === 'day',
    res.body?.data?.range,
  );

  const overview = res.body.data.charts;

  check(
    'activityBySection stacks the four sections',
    overview.activityBySection?.series?.map(s => s.key).join() ===
      'COMMUNITY,PROFESSIONALS,CONNECT,COMMERCE',
    overview.activityBySection?.series?.map(s => s.key),
  );
  check(
    'a series has one point per bucket',
    overview.signups?.series?.[0]?.points?.length === 30,
    overview.signups?.series?.[0]?.points?.length,
  );
  check(
    'every point is a London date',
    overview.signups?.series?.[0]?.points?.every(p => /^\d{4}-\d{2}-\d{2}$/.test(p.t)),
    overview.signups?.series?.[0]?.points?.[0],
  );
  check(
    'topCities shares sum to one over the unsuppressed items',
    (overview.topCities?.items ?? []).every(
      item => item.share === null || (item.share >= 0 && item.share <= 1),
    ),
    overview.topCities?.items,
  );
  check(
    'cityMap points carry coordinates',
    (overview.cityMap?.points ?? []).every(p => typeof p.lat === 'number'),
    overview.cityMap?.points?.[0],
  );

  // Two numbers for one city on one page. The map used to count every member while the breakdown
  // counted those who had signed up by the end of the range.
  const mapByCity = new Map((overview.cityMap?.points ?? []).map(p => [p.cityId, p.value]));
  const disagreeing = (overview.topCities?.items ?? []).filter(
    item =>
      mapByCity.has(item.key) && item.value !== null && mapByCity.get(item.key) !== item.value,
  );

  check('and agree with the breakdown, city for city', disagreeing.length === 0, disagreeing);

  res = await api(
    null,
    'GET',
    `/admin/analytics/overview?from=${shift(-200)}&to=${today()}`,
    null,
    headers,
  );
  check(
    'a 201-day range picks week granularity on its own',
    res.body?.data?.range?.granularity === 'week',
    res.body?.data?.range,
  );
  check(
    'and the buckets start on Mondays',
    (res.body?.data?.charts?.signups?.series?.[0]?.points ?? [])
      .slice(1)
      .every(p => new Date(`${p.t}T00:00:00Z`).getUTCDay() === 1),
    (res.body?.data?.charts?.signups?.series?.[0]?.points ?? []).slice(0, 4).map(p => p.t),
  );

  res = await api(
    null,
    'GET',
    `/admin/analytics/overview?from=${shift(-800)}&to=${today()}&granularity=day`,
    null,
    headers,
  );
  check(
    'a day range over 366 days is refused',
    res.status === 400 && res.body?.error?.code === 'FILTER_RANGE_TOO_LARGE',
    res.body?.error,
  );

  console.log('\n— compare —');

  res = await api(
    null,
    'GET',
    '/admin/analytics/overview?compare=true&charts=signups',
    null,
    headers,
  );
  check(
    'compare adds the previous period to the range',
    !!res.body?.data?.range?.previousFrom && !!res.body?.data?.range?.previousTo,
    res.body?.data?.range,
  );
  check(
    'and a previous series of the same length',
    res.body?.data?.charts?.signups?.series?.[0]?.previous?.length ===
      res.body?.data?.charts?.signups?.series?.[0]?.points?.length,
    {
      now: res.body?.data?.charts?.signups?.series?.[0]?.points?.length,
      was: res.body?.data?.charts?.signups?.series?.[0]?.previous?.length,
    },
  );

  console.log('\n— The charts selector —');

  res = await api(null, 'GET', '/admin/analytics/overview?charts=topCities', null, headers);
  check(
    'charts= narrows the response to one',
    Object.keys(res.body?.data?.charts ?? {}).join() === 'topCities',
    Object.keys(res.body?.data?.charts ?? {}),
  );

  res = await api(null, 'GET', '/admin/analytics/overview?charts=notAChart', null, headers);
  check(
    'an unknown chart id is a 400, never silence',
    res.status === 400 && JSON.stringify(res.body).includes('notAChart'),
    res.body?.error,
  );

  res = await api(null, 'GET', '/admin/analytics/notATab', null, headers);
  check('an unknown tab is a 400', res.status === 400, res.body?.error);

  /**
   * All eleven tabs §5.25 defines now answer. The check used to assert the opposite — that the
   * unbuilt ones said `NOT_AVAILABLE_YET` rather than returning an empty tab — and is kept
   * pointing the other way so that a tab silently disappearing is a failure.
   *
   * A tab that cannot fill every panel still answers 200 and says so per chart: Support reads
   * `support_threads`, which the support milestone has not built, so four of its five charts are
   * `{ kind: 'error', code: 'NOT_AVAILABLE_YET' }` inside a 200.
   */
  const answered = [];

  for (const tab of [
    'overview',
    'growth',
    'demographics',
    'community',
    'professionals',
    'connect',
    'commerce',
    'deals',
    'search',
    'trust-safety',
    'support',
  ]) {
    const probe = await api(null, 'GET', `/admin/analytics/${tab}`, null, headers);

    if (probe.status === 200) answered.push(tab);
    else console.log(`    ${tab} answered ${probe.status} ${probe.body?.error?.code ?? ''}`);
  }

  check('every tab §5.25 defines answers', answered.length === 11, answered);

  console.log('\n— Permissions —');

  res = await api(null, 'GET', '/admin/analytics/overview', null, safetyHeaders);
  check(
    'trust & safety hold analytics:safety, not analytics:read — Overview is refused',
    res.status === 403,
    res.status,
  );

  res = await api(null, 'GET', '/admin/analytics/overview', null, supportHeaders);
  check('and support have neither', res.status === 403, res.status);

  console.log('\n— Filters reach the charts —');

  await clearAnalyticsCache();

  res = await api(
    null,
    'GET',
    '/admin/analytics/overview?cityIds=LONDON&charts=topCities',
    null,
    headers,
  );
  check(
    'a city filter narrows the breakdown to that city',
    (res.body?.data?.charts?.topCities?.items ?? []).every(item => item.key === 'LONDON'),
    res.body?.data?.charts?.topCities?.items,
  );
  check(
    'and the response says which filters it applied',
    (res.body?.meta?.filtersApplied ?? []).includes('cityIds'),
    res.body?.meta,
  );

  res = await api(null, 'GET', '/admin/analytics/overview?cityIds=ATLANTIS', null, headers);
  check(
    'an unknown city is refused here too',
    res.status === 400 && res.body?.error?.code === 'UNKNOWN_CITY',
    res.body?.error,
  );

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
  check(
    'a population under ten suppresses the whole response',
    res.body?.meta?.populationSuppressed === true,
    res.body?.meta,
  );
  check(
    'every member number is withheld rather than zeroed',
    res.body?.data?.charts?.kpis?.items?.totalMembers?.value === null &&
      res.body.data.charts.kpis.items.totalMembers.suppressed === true,
    res.body?.data?.charts?.kpis?.items?.totalMembers,
  );
  check(
    'and so is every point of every series',
    (res.body?.data?.charts?.signups?.series?.[0]?.points ?? []).every(
      point => point.v === null && point.suppressed === true,
    ),
    res.body?.data?.charts?.signups?.series?.[0]?.points?.slice(0, 2),
  );
  check(
    'including the breakdown total',
    res.body?.data?.charts?.topCities?.total === null,
    res.body?.data?.charts?.topCities,
  );

  res = await api(null, 'GET', '/admin/analytics/overview', null, headers);
  check(
    'and the unfiltered response is not suppressed',
    res.body?.meta?.populationSuppressed === undefined &&
      res.body?.data?.charts?.kpis?.items?.totalMembers?.value > 0,
    res.body?.data?.charts?.kpis?.items?.totalMembers,
  );

  // The floor is "when member-attribute filters narrow the population below 10". A date range is
  // not a member-attribute filter, so a quiet week must not blank the dashboard.
  res = await api(
    null,
    'GET',
    `/admin/analytics/overview?from=${shift(-1)}&to=${today()}&charts=kpis`,
    null,
    headers,
  );
  check(
    'a narrow date range alone never triggers the population floor',
    res.body?.meta?.populationSuppressed === undefined &&
      res.body?.data?.charts?.kpis?.items?.totalMembers?.value > 0,
    res.body?.meta,
  );

  console.log('\n— Caching (§8.4) —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/overview?charts=topCities', null, headers);
  check('the first request is a miss', res.body?.meta?.cache?.hit === false, res.body?.meta?.cache);

  res = await api(null, 'GET', '/admin/analytics/overview?charts=topCities', null, headers);
  check('the second is a hit', res.body?.meta?.cache?.hit === true, res.body?.meta?.cache);
  check(
    'with a TTL that reflects a range including today',
    res.body?.meta?.cache?.ttlSeconds === 300,
    res.body?.meta?.cache,
  );

  res = await api(
    null,
    'GET',
    `/admin/analytics/overview?charts=topCities&from=${shift(-60)}&to=${shift(-31)}`,
    null,
    headers,
  );
  check(
    'a historical range is cached for longer',
    res.body?.meta?.cache?.ttlSeconds === 3600,
    res.body?.meta?.cache,
  );

  // Array order must not create a second cache entry.
  await clearAnalyticsCache();
  await api(
    null,
    'GET',
    '/admin/analytics/overview?cityIds=LONDON,MANCHESTER&charts=topCities',
    null,
    headers,
  );
  res = await api(
    null,
    'GET',
    '/admin/analytics/overview?cityIds=MANCHESTER,LONDON&charts=topCities',
    null,
    headers,
  );
  check(
    'filter arrays are normalised, so the order of two cities is one cache entry',
    res.body?.meta?.cache?.hit === true,
    res.body?.meta?.cache,
  );

  console.log('\n— Analytics: Growth & Retention —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/growth', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check(
    'with all eleven charts',
    [
      'signups',
      'cumulativeMembers',
      'activeMembers',
      'stickiness',
      'retentionCohorts',
      'retentionDn',
      'onboardingFunnel',
      'signupMethods',
      'platforms',
      'appVersionAdoption',
      'newReturningReactivated',
    ].every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}),
  );
  check(
    'and none of them failed',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {})
      .filter(([, chart]) => chart.kind === 'error')
      .map(([id, c]) => [id, c.code]),
  );

  const growth = res.body.data.charts;

  // The membership curve is a balance, not a running total of sign-ups: people leave. Built from
  // three sums that have to agree about who counts, or it drifts below zero — which it did.
  const curve = growth.cumulativeMembers?.series?.[0]?.points ?? [];

  check(
    'the membership curve never goes negative',
    curve.every(point => point.v === null || point.v >= 0),
    curve.filter(point => (point.v ?? 0) < 0),
  );
  check(
    'and ends at roughly the live member count',
    Math.abs(
      (curve[curve.length - 1]?.v ?? 0) -
        (await prisma.user.count({
          where: { isStaff: false, deletedAt: null, isAnonymised: false },
        })),
    ) <= 1,
    curve[curve.length - 1],
  );

  check(
    'activeMembers carries the three windows',
    growth.activeMembers?.series?.map(s => s.key).join() === 'dau,wau,mau',
    growth.activeMembers?.series?.map(s => s.key),
  );
  check(
    'and a weekly window is never smaller than the daily one inside it',
    growth.activeMembers?.series?.[0]?.points?.every((point, index) => {
      const wau = growth.activeMembers.series[1].points[index].v;

      return point.v === null || wau === null || wau >= point.v;
    }),
    'dau exceeded wau',
  );
  check(
    'nor a monthly one smaller than the weekly',
    growth.activeMembers?.series?.[1]?.points?.every((point, index) => {
      const mau = growth.activeMembers.series[2].points[index].v;

      return point.v === null || mau === null || mau >= point.v;
    }),
    'wau exceeded mau',
  );

  check(
    'stickiness is a ratio series, on its own chart',
    growth.stickiness?.unit === 'ratio' && growth.stickiness?.series?.length === 1,
    growth.stickiness?.unit,
  );
  check(
    'and every point is a fraction or withheld',
    (growth.stickiness?.series?.[0]?.points ?? []).every(
      point => point.v === null || (point.v >= 0 && point.v <= 1),
    ),
    growth.stickiness?.series?.[0]?.points?.slice(0, 3),
  );

  check(
    'the cohort grid is monthly and bounded',
    growth.retentionCohorts?.period === 'month' &&
      (growth.retentionCohorts?.cohorts ?? []).length <= 18,
    growth.retentionCohorts?.cohorts?.length,
  );
  check(
    'every cohort is a YYYY-MM with a retention row',
    (growth.retentionCohorts?.cohorts ?? []).every(
      c => /^\d{4}-\d{2}$/.test(c.cohort) && Array.isArray(c.retention),
    ),
    growth.retentionCohorts?.cohorts?.[0],
  );
  // The grid is as wide as the furthest month anybody reached. Sized by the *count* of months a
  // cohort was active in, a cohort active in months 0 and 5 and nowhere between lost its month-5
  // figure off the end of its own row.
  check(
    'the grid is wide enough for the oldest cohort\u2019s age',
    (growth.retentionCohorts?.cohorts ?? []).length === 0 ||
      growth.retentionCohorts.cohorts[0].retention.length >=
        growth.retentionCohorts.cohorts[growth.retentionCohorts.cohorts.length - 1].retention
          .length,
    (growth.retentionCohorts?.cohorts ?? []).map(c => [c.cohort, c.retention.length]),
  );
  check(
    'and every row is the same width',
    new Set((growth.retentionCohorts?.cohorts ?? []).map(c => c.retention.length)).size <= 1,
    (growth.retentionCohorts?.cohorts ?? []).map(c => c.retention.length),
  );

  check(
    'a cohort under ten is withheld whole — size and every cell',
    (growth.retentionCohorts?.cohorts ?? []).every(
      c => c.size !== null || c.retention.every(cell => cell === null),
    ),
    growth.retentionCohorts?.cohorts?.find(c => c.size === null),
  );

  check(
    'retentionDn is the three figures plus a trend',
    ['d1', 'd7', 'd30', 'trend'].every(id => id in (growth.retentionDn?.items ?? {})),
    Object.keys(growth.retentionDn?.items ?? {}),
  );
  check(
    'each Dn is a ratio, or null where the cohort is too small to say',
    ['d1', 'd7', 'd30'].every(id => {
      const value = growth.retentionDn.items[id].value;

      return value === null || (value >= 0 && value <= 1);
    }),
    ['d1', 'd7', 'd30'].map(id => growth.retentionDn.items[id].value),
  );

  check(
    'the onboarding funnel has its five steps in order',
    growth.onboardingFunnel?.steps?.map(s => s.key).join() ===
      'registered,profile,arrival,interests,firstAction',
    growth.onboardingFunnel?.steps?.map(s => s.key),
  );
  check(
    'and no step exceeds the one before it',
    growth.onboardingFunnel?.steps?.every(
      (step, index, all) =>
        index === 0 ||
        step.value === null ||
        all[index - 1].value === null ||
        step.value <= all[index - 1].value,
    ),
    growth.onboardingFunnel?.steps?.map(s => s.value),
  );

  check(
    'newReturningReactivated stacks the three',
    growth.newReturningReactivated?.series?.map(s => s.key).join() === 'new,returning,reactivated',
    growth.newReturningReactivated?.series?.map(s => s.key),
  );

  check(
    'appVersionAdoption caps at six bands plus other',
    (growth.appVersionAdoption?.series ?? []).length <= 7,
    growth.appVersionAdoption?.series?.map(s => s.key),
  );

  res = await api(
    null,
    'GET',
    '/admin/analytics/growth?charts=cumulativeMembers&cityIds=LONDON',
    null,
    headers,
  );
  check(
    'a filtered membership curve accumulates the population and never subtracts',
    (res.body?.data?.charts?.cumulativeMembers?.series?.[0]?.points ?? []).every(
      (point, index, all) =>
        index === 0 || point.v === null || all[index - 1].v === null || point.v >= all[index - 1].v,
    ),
    'filtered curve fell',
  );

  console.log('\n— Analytics: Demographics —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/demographics', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check(
    'with all nine charts',
    [
      'gender',
      'ageBands',
      'genderByAge',
      'countries',
      'heritage',
      'journeyStages',
      'interests',
      'languages',
      'cityByJourneyStage',
    ].every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}),
  );
  check(
    'and none of them failed',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {})
      .filter(([, chart]) => chart.kind === 'error')
      .map(([id, c]) => [id, c.code]),
  );

  const demo = res.body.data.charts;

  check(
    'every breakdown shares one total — the population',
    [demo.gender, demo.ageBands, demo.countries, demo.heritage, demo.journeyStages].every(
      chart => chart.total === demo.gender.total,
    ),
    {
      gender: demo.gender?.total,
      countries: demo.countries?.total,
      heritage: demo.heritage?.total,
    },
  );

  // A group nobody is in is information. A bar chart that silently drops it reads as though the
  // option does not exist.
  check(
    'a journey stage with no members is kept, at zero',
    demo.journeyStages?.items?.some(item => item.value === 0),
    demo.journeyStages?.items,
  );
  check(
    'and the stages keep the taxonomy\u2019s own order — this is a funnel',
    demo.journeyStages?.items?.[0]?.key === 'PLANNING',
    demo.journeyStages?.items?.map(i => i.key),
  );
  check(
    'age bands are ordered youngest first, with the unknown last',
    demo.ageBands?.items?.map(item => item.key).join() ===
      'AGE_18_24,AGE_25_34,AGE_35_44,AGE_45_PLUS,UNKNOWN',
    demo.ageBands?.items?.map(item => item.key),
  );
  check(
    '"not set" is a labelled group, not a gap',
    demo.heritage?.items?.some(item => item.key === 'UNKNOWN' && item.label === 'Not set'),
    demo.heritage?.items?.find(item => item.key === 'UNKNOWN'),
  );
  check(
    'countries are named from ICU, not from a code',
    demo.countries?.items?.some(item => item.key === 'NG' && item.label === 'Nigeria'),
    demo.countries?.items?.[0],
  );
  check(
    'and capped at fifteen with the rest as `other`',
    demo.countries?.items?.length <= 15,
    demo.countries?.items?.length,
  );

  // Multi-valued: a member with four interests is in four groups, so the shares must be over the
  // member count. Divided by the sum of the groups they would add to four hundred per cent.
  const interestShares = (demo.interests?.items ?? [])
    .map(item => item.share)
    .filter(share => share !== null);

  check(
    'an interest share is a fraction of members, never above one',
    interestShares.every(share => share >= 0 && share <= 1),
    interestShares.slice(0, 3),
  );
  check(
    'and the shares may sum above one, because a member holds several',
    interestShares.reduce((sum, share) => sum + share, 0) > 1,
    interestShares.reduce((sum, share) => sum + share, 0),
  );
  check(
    'capped at twenty',
    (demo.interests?.items ?? []).length <= 20,
    demo.interests?.items?.length,
  );

  check(
    'genderByAge is bands by genders, with every declared cell present',
    demo.genderByAge?.rows?.length === demo.genderByAge?.cells?.length &&
      demo.genderByAge.cells.every(row => row.length === demo.genderByAge.cols.length),
    { rows: demo.genderByAge?.rows?.length, cols: demo.genderByAge?.cols?.length },
  );
  check(
    'and withheld cells are listed by coordinate for the portal to shade',
    (demo.genderByAge?.suppressed ?? []).every(([r, c]) => demo.genderByAge.cells[r][c] === null),
    demo.genderByAge?.suppressed,
  );
  check(
    'a zero cell is shown — zero identifies nobody',
    demo.genderByAge?.cells?.flat().includes(0),
    demo.genderByAge?.cells?.[0],
  );

  check(
    'cityByJourneyStage is capped at fifteen cities',
    (demo.cityByJourneyStage?.rows ?? []).length <= 15,
    demo.cityByJourneyStage?.rows?.length,
  );
  check(
    'and names them rather than showing their ids',
    (demo.cityByJourneyStage?.rows ?? []).every(row => row.label !== row.key) ||
      (demo.cityByJourneyStage?.rows ?? []).length === 0,
    demo.cityByJourneyStage?.rows,
  );

  res = await api(
    null,
    'GET',
    `/admin/analytics/demographics?population=signups&from=${shift(-2)}&to=${today()}&charts=gender`,
    null,
    headers,
  );
  check(
    'population=signups narrows to those who joined in the range',
    res.status === 200 && res.body?.data?.charts?.gender?.total < demo.gender.total,
    { signups: res.body?.data?.charts?.gender?.total, all: demo.gender?.total },
  );

  res = await api(null, 'GET', '/admin/analytics/demographics?population=everyone', null, headers);
  check('an unknown population mode is refused', res.status === 400, res.body?.error);

  res = await api(
    null,
    'GET',
    '/admin/analytics/demographics?charts=heritage&heritage=SOUTH_ASIAN',
    null,
    headers,
  );
  check(
    'and the tab honours the shared filter too',
    res.body?.meta?.populationSuppressed === true,
    res.body?.meta,
  );

  console.log('\n— Analytics: Community —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/community', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check(
    'with all ten charts',
    [
      'created',
      'requestsByCategory',
      'requestOutcomes',
      'responseTimes',
      'unansweredByCity',
      'visibilityMix',
      'topGuides',
      'guideDeflection',
      'groups',
      'engagement',
    ].every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}),
  );
  check(
    'and none of them failed',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {})
      .filter(([, chart]) => chart.kind === 'error')
      .map(([id, c]) => [id, c.code]),
  );

  // A content tab's `cityIds` narrows the content's city, not the author's — and a reader
  // comparing two tabs has no other way to know which.
  check(
    'the response says what cityIds means on a content tab',
    typeof res.body?.meta?.filterSemantics?.cityIds === 'string',
    res.body?.meta?.filterSemantics,
  );

  const comm = res.body.data.charts;

  check(
    'created stacks requests, offers and posts',
    comm.created?.series?.map(s => s.key).join() === 'requests,offers,posts',
    comm.created?.series?.map(s => s.key),
  );
  check('and counts things, not members', comm.created?.unit === 'count', comm.created?.unit);

  check(
    'request outcomes keep their order, with EXPIRED folded in as the fourth',
    comm.requestOutcomes?.items?.map(i => i.key).join() ===
      'HELPED,SOLVED_ELSEWHERE,NO_LONGER_NEEDED,EXPIRED',
    comm.requestOutcomes?.items?.map(i => i.key),
  );

  check(
    'responseTimes is two medians and a trend, in minutes',
    ['medianFirstResponse', 'medianResolution', 'trend'].every(
      id => id in (comm.responseTimes?.items ?? {}),
    ) && comm.responseTimes.items.medianFirstResponse.unit === 'minutes',
    Object.keys(comm.responseTimes?.items ?? {}),
  );
  check(
    'and a bucket with no resolved request is null, not zero minutes',
    (comm.responseTimes?.items?.trend?.series?.[1]?.points ?? []).every(
      point => point.v === null || point.v > 0,
    ),
    comm.responseTimes?.items?.trend?.series?.[1]?.points?.slice(0, 3),
  );

  check(
    'visibilityMix keeps the three visibilities in order',
    comm.visibilityMix?.items?.map(i => i.key).join() === 'PUBLIC,ANONYMOUS,PRIVATE_TO_CIRCL',
    comm.visibilityMix?.items?.map(i => i.key),
  );

  check(
    'topGuides is a table with named columns',
    comm.topGuides?.kind === 'table' && comm.topGuides.columns.some(c => c.key === 'uniqueReaders'),
    comm.topGuides?.columns?.map(c => c.key),
  );
  check(
    'and at most twenty rows',
    (comm.topGuides?.rows ?? []).length <= 20,
    comm.topGuides?.rows?.length,
  );

  check(
    'guideDeflection is a gauge plus a trend',
    comm.guideDeflection?.items?.rate?.kind === 'gauge' &&
      comm.guideDeflection?.items?.trend?.kind === 'timeseries',
    Object.keys(comm.guideDeflection?.items ?? {}),
  );
  check(
    'and the rate is a percentage or null where nobody was shown a guide',
    comm.guideDeflection?.items?.rate?.value === null ||
      (comm.guideDeflection.items.rate.value >= 0 && comm.guideDeflection.items.rate.value <= 100),
    comm.guideDeflection?.items?.rate,
  );

  check(
    'groups is growth plus the most active table',
    comm.groups?.items?.growth?.series?.map(s => s.key).join() ===
      'groupsCreated,membershipsJoined' && comm.groups?.items?.mostActive?.kind === 'table',
    Object.keys(comm.groups?.items ?? {}),
  );

  check(
    'engagement is two ratios',
    comm.engagement?.unit === 'ratio' &&
      comm.engagement.series.map(s => s.key).join() === 'repliesPerPost,reactionsPerPost',
    comm.engagement?.series?.map(s => s.key),
  );
  check(
    'and a bucket with no posts is null rather than a zero rate',
    (comm.engagement?.series?.[0]?.points ?? []).every(point => point.v === null || point.v >= 0),
    comm.engagement?.series?.[0]?.points?.slice(0, 3),
  );

  res = await api(
    null,
    'GET',
    '/admin/analytics/community?charts=requestsByCategory&categories=HOUSING',
    null,
    headers,
  );
  check(
    'a category filter narrows the breakdown',
    (res.body?.data?.charts?.requestsByCategory?.items ?? []).every(item => item.key === 'HOUSING'),
    res.body?.data?.charts?.requestsByCategory?.items,
  );

  res = await api(
    null,
    'GET',
    '/admin/analytics/community?charts=visibilityMix&visibility=PUBLIC',
    null,
    headers,
  );
  check(
    'and a visibility filter does too',
    (res.body?.data?.charts?.visibilityMix?.items ?? []).every(item =>
      item.key !== 'PUBLIC' ? (item.value ?? 0) === 0 : true,
    ),
    res.body?.data?.charts?.visibilityMix?.items,
  );

  res = await api(null, 'GET', '/admin/analytics/community?visibility=SECRET', null, headers);
  check('an unknown visibility is refused', res.status === 400, res.body?.error);

  // Every declared tab filter has to reach at least one chart. `requestStatuses` was accepted and
  // applied to nothing, so the reader got a chart answering a different question under the heading
  // they had chosen — which is worse than a filter the endpoint refuses outright.
  const unfiltered = await api(
    null,
    'GET',
    '/admin/analytics/community?charts=requestsByCategory',
    null,
    headers,
  );
  const narrowed = {
    categories: await api(
      null,
      'GET',
      '/admin/analytics/community?charts=requestsByCategory&categories=HOUSING',
      null,
      headers,
    ),
    requestStatuses: await api(
      null,
      'GET',
      '/admin/analytics/community?charts=requestsByCategory&requestStatuses=RESOLVED',
      null,
      headers,
    ),
    visibility: await api(
      null,
      'GET',
      '/admin/analytics/community?charts=requestsByCategory&visibility=ANONYMOUS',
      null,
      headers,
    ),
    cityIds: await api(
      null,
      'GET',
      '/admin/analytics/community?charts=requestsByCategory&cityIds=LONDON',
      null,
      headers,
    ),
  };
  const baseline = unfiltered.body?.data?.charts?.requestsByCategory?.total;
  const ignored = Object.entries(narrowed)
    .filter(([, probe]) => probe.body?.data?.charts?.requestsByCategory?.total === baseline)
    .map(([name]) => name);

  check(
    'every tab filter reaches the charts rather than being silently ignored',
    ignored.length === 0,
    {
      baseline,
      ignored,
      totals: Object.fromEntries(
        Object.entries(narrowed).map(([k, v]) => [
          k,
          v.body?.data?.charts?.requestsByCategory?.total,
        ]),
      ),
    },
  );

  console.log('\n— Analytics: Professionals —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/professionals', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check(
    'with all nine charts',
    [
      'listingsByProfession',
      'newListings',
      'acceptingWork',
      'experienceLevels',
      'responseTimeByProfession',
      'ratingsDistribution',
      'briefsFunnel',
      'briefsByCategoryUrgency',
      'supplyDemand',
    ].every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}),
  );
  check(
    'and none of them failed',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {})
      .filter(([, chart]) => chart.kind === 'error')
      .map(([id, c]) => [id, c.code]),
  );

  const pro = res.body.data.charts;

  check(
    'acceptingWork keeps both sides, so a city of closed listings is visible',
    pro.acceptingWork?.items?.map(item => item.key).join() === 'ACCEPTING,NOT_ACCEPTING',
    pro.acceptingWork?.items?.map(item => item.key),
  );
  check(
    'experience levels keep the vocabulary order, zeroes included',
    pro.experienceLevels?.items?.map(item => item.key).join() === 'BEGINNER,MID_LEVEL,EXPERT',
    pro.experienceLevels?.items?.map(item => item.key),
  );
  check(
    'ratings always show all five bars, so the scale cannot look like it starts at two',
    pro.ratingsDistribution?.items?.map(item => item.key).join() === '1,2,3,4,5',
    pro.ratingsDistribution?.items?.map(item => item.key),
  );

  /**
   * A breakdown of medians has no meaningful total, so it reports none. Summing them and dividing
   * would give a "share of minutes" — inviting a reader to conclude one profession takes up a third
   * of everybody's waiting, which the data does not say.
   */
  check(
    'the response-time breakdown is in minutes with no total',
    pro.responseTimeByProfession?.unit === 'minutes' &&
      pro.responseTimeByProfession?.total === null,
    { unit: pro.responseTimeByProfession?.unit, total: pro.responseTimeByProfession?.total },
  );
  check(
    'and no shares, because medians do not add up',
    (pro.responseTimeByProfession?.items ?? []).every(item => item.share === null),
    pro.responseTimeByProfession?.items?.slice(0, 2),
  );
  check(
    'while a count breakdown on the same tab does have both',
    pro.listingsByProfession?.total > 0 &&
      pro.listingsByProfession?.items?.some(item => item.share !== null),
    pro.listingsByProfession?.items?.[0],
  );

  const briefs = pro.briefsFunnel?.steps ?? [];

  check(
    'the brief funnel never rises',
    briefs.every((step, i, all) => i === 0 || step.value <= all[i - 1].value),
    briefs.map(step => [step.key, step.value]),
  );
  check(
    'and counts briefs rather than members',
    pro.briefsFunnel?.unit === 'count',
    pro.briefsFunnel?.unit,
  );

  /**
   * Two matrices, not one ratio. A ratio of 0.5 is one listing against two briefs and fifty against
   * a hundred — the same number, and completely different problems. Identical axes are what make
   * the two readable against each other, cell for cell.
   */
  const sd = pro.supplyDemand?.items;

  check(
    'supplyDemand is two matrices',
    sd?.supply?.kind === 'matrix' && sd?.demand?.kind === 'matrix',
    Object.keys(sd ?? {}),
  );
  check(
    'over identical rows',
    JSON.stringify(sd?.supply?.rows?.map(row => row.key)) ===
      JSON.stringify(sd?.demand?.rows?.map(row => row.key)),
    { supply: sd?.supply?.rows?.map(r => r.key), demand: sd?.demand?.rows?.map(r => r.key) },
  );
  check(
    'and identical columns',
    JSON.stringify(sd?.supply?.cols?.map(col => col.key)) ===
      JSON.stringify(sd?.demand?.cols?.map(col => col.key)),
    { supply: sd?.supply?.cols?.map(c => c.key), demand: sd?.demand?.cols?.map(c => c.key) },
  );
  check(
    'both grids matching their declared axes',
    [sd?.supply, sd?.demand].every(
      m =>
        m?.cells?.length === m?.rows?.length && m.cells.every(row => row.length === m.cols.length),
    ),
    { supply: sd?.supply?.cells?.length, demand: sd?.demand?.cells?.length },
  );
  check(
    'and counting things, so a city with one listing is still visible',
    sd?.supply?.unit === 'count' && (sd?.supply?.suppressed ?? []).length === 0,
    sd?.supply?.suppressed,
  );

  check(
    'the response says what cityIds means on a listing chart',
    typeof res.body?.meta?.filterSemantics?.cityIds === 'string',
    res.body?.meta?.filterSemantics,
  );

  res = await api(
    null,
    'GET',
    '/admin/analytics/professionals?charts=listingsByProfession&professions=IMMIGRATION',
    null,
    headers,
  );
  check(
    'a profession filter narrows the tab',
    (res.body?.data?.charts?.listingsByProfession?.items ?? []).every(
      item => item.key === 'IMMIGRATION',
    ),
    res.body?.data?.charts?.listingsByProfession?.items,
  );

  // `regulated` is a taxonomy fact rather than a column, so this proves the metadata lookup works
  // and that the two halves of the filter are complements.
  const regulated = await api(
    null,
    'GET',
    '/admin/analytics/professionals?charts=listingsByProfession&regulated=true',
    null,
    headers,
  );
  const unregulated = await api(
    null,
    'GET',
    '/admin/analytics/professionals?charts=listingsByProfession&regulated=false',
    null,
    headers,
  );
  const all = await api(
    null,
    'GET',
    '/admin/analytics/professionals?charts=listingsByProfession',
    null,
    headers,
  );

  check(
    'regulated and unregulated partition the listings between them',
    (regulated.body?.data?.charts?.listingsByProfession?.total ?? 0) +
      (unregulated.body?.data?.charts?.listingsByProfession?.total ?? 0) ===
      all.body?.data?.charts?.listingsByProfession?.total,
    {
      regulated: regulated.body?.data?.charts?.listingsByProfession?.total,
      unregulated: unregulated.body?.data?.charts?.listingsByProfession?.total,
      all: all.body?.data?.charts?.listingsByProfession?.total,
    },
  );

  res = await api(
    null,
    'GET',
    '/admin/analytics/professionals?experienceLevels=GURU',
    null,
    headers,
  );
  check('an unknown experience level is refused', res.status === 400, res.body?.error);

  console.log('\n— Analytics: Connect —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/connect', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check(
    'with all seven charts',
    [
      'profilesByType',
      'profilesCreated',
      'connectionRequests',
      'acceptanceRate',
      'storiesPerDay',
      'ageGender',
      'dmPolicy',
    ].every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}),
  );
  check(
    'and none of them failed',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {})
      .filter(([, chart]) => chart.kind === 'error')
      .map(([id, c]) => [id, c.code]),
  );

  const conn = res.body.data.charts;

  // Connect counts are counts of people, so the floor applies to them — unlike Commerce below.
  check(
    'profile counts are members, so small groups are withheld',
    conn.profilesByType?.unit === 'members' &&
      conn.profilesByType.items.some(item => item.suppressed === true || (item.value ?? 0) >= 10),
    conn.profilesByType?.items?.slice(0, 2),
  );
  check(
    'ageGender is bands by genders with every declared cell present',
    conn.ageGender?.cells?.length === conn.ageGender?.rows?.length &&
      conn.ageGender.cells.every(row => row.length === conn.ageGender.cols.length),
    { rows: conn.ageGender?.rows?.length, cols: conn.ageGender?.cols?.length },
  );
  check(
    'and its withheld cells are listed by coordinate',
    (conn.ageGender?.suppressed ?? []).every(([r, c]) => conn.ageGender.cells[r][c] === null),
    conn.ageGender?.suppressed,
  );

  // A ratio never shares an axis with a count: at a hundred requests a week a rate of 0.4 would be
  // a flat line on the floor of the chart.
  check(
    'acceptanceRate is its own chart, in ratio',
    conn.acceptanceRate?.unit === 'ratio' && conn.acceptanceRate?.series?.length === 1,
    conn.acceptanceRate?.unit,
  );
  check(
    'while the request counts share one chart in count',
    conn.connectionRequests?.unit === 'count' &&
      conn.connectionRequests.series.map(s => s.key).join() === 'sent,accepted',
    conn.connectionRequests?.series?.map(s => s.key),
  );
  check(
    'and a bucket where nobody answered has no rate rather than a zero one',
    (conn.acceptanceRate?.series?.[0]?.points ?? []).every(
      point => point.v === null || (point.v >= 0 && point.v <= 1),
    ),
    conn.acceptanceRate?.series?.[0]?.points?.slice(0, 3),
  );

  check(
    'dmPolicy keeps both options in order',
    conn.dmPolicy?.items?.map(item => item.key).join() === 'OPEN,REQUEST_FIRST',
    conn.dmPolicy?.items?.map(item => item.key),
  );

  res = await api(
    null,
    'GET',
    '/admin/analytics/connect?charts=profilesByType&connectionTypes=FRIENDSHIP',
    null,
    headers,
  );
  check(
    'a connection-type filter narrows the tab',
    (res.body?.data?.charts?.profilesByType?.items ?? []).every(item => item.key === 'FRIENDSHIP'),
    res.body?.data?.charts?.profilesByType?.items,
  );

  res = await api(null, 'GET', '/admin/analytics/connect?dmPolicy=SHOUT', null, headers);
  check('an unknown dm policy is refused', res.status === 400, res.body?.error);

  console.log('\n— Analytics: Commerce —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/commerce', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check(
    'with all eight charts',
    [
      'storesByType',
      'storesByCity',
      'itemsByCategory',
      'enquiries',
      'enquiryFunnel',
      'enquiryOutcomes',
      'storeStatusCompliance',
      'topStores',
    ].every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}),
  );
  check(
    'and none of them failed',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {})
      .filter(([, chart]) => chart.kind === 'error')
      .map(([id, c]) => [id, c.code]),
  );

  const comm2 = res.body.data.charts;

  check(
    'the response says what cityIds means on a shop chart',
    typeof res.body?.meta?.filterSemantics?.cityIds === 'string',
    res.body?.meta?.filterSemantics,
  );

  // Shops and items are things, not people. A town with three shops is a fact about the town that
  // staff need in order to decide where to recruit sellers, not a disclosure about three people.
  check(
    'shop and item counts are counts, so the member floor does not blank them',
    comm2.storesByType?.unit === 'count' &&
      comm2.itemsByCategory?.unit === 'count' &&
      comm2.storesByType.items.every(item => item.suppressed === undefined),
    comm2.storesByType?.items,
  );
  check(
    'and the status/compliance matrix keeps its small cells for the same reason',
    comm2.storeStatusCompliance?.unit === 'count' &&
      (comm2.storeStatusCompliance?.suppressed ?? []).length === 0,
    comm2.storeStatusCompliance?.suppressed,
  );

  /**
   * The two invariants the funnel was rewritten for. A later step exceeding an earlier one is
   * visibly broken, and a `received` count that disagrees with `COMPLETED` beside it makes a reader
   * distrust the whole tab — which is what happened when the funnel read timestamps and the
   * outcomes read state.
   */
  const funnel = comm2.enquiryFunnel?.steps ?? [];

  check(
    'the enquiry funnel never rises',
    funnel.every((step, i, all) => i === 0 || step.value <= all[i - 1].value),
    funnel.map(step => [step.key, step.value]),
  );
  check(
    'and its last step agrees with the completed count beside it',
    funnel.find(step => step.key === 'received')?.value ===
      comm2.enquiryOutcomes?.items?.find(item => item.key === 'COMPLETED')?.value,
    {
      received: funnel.find(step => step.key === 'received')?.value,
      completed: comm2.enquiryOutcomes?.items?.find(item => item.key === 'COMPLETED')?.value,
    },
  );
  check(
    'the funnel counts enquiries, not members',
    comm2.enquiryFunnel?.unit === 'count',
    comm2.enquiryFunnel?.unit,
  );

  check(
    'enquiry outcomes separate a shop declining from a buyer cancelling',
    comm2.enquiryOutcomes?.items?.map(item => item.key).join() ===
      'COMPLETED,DECLINED,CANCELLED,EXPIRED',
    comm2.enquiryOutcomes?.items?.map(item => item.key),
  );

  check(
    'topStores is a table of at most twenty',
    comm2.topStores?.kind === 'table' && comm2.topStores.rows.length <= 20,
    comm2.topStores?.rows?.length,
  );
  check(
    'and is ordered by enquiries',
    (comm2.topStores?.rows ?? []).every(
      (row, i, all) => i === 0 || all[i - 1].enquiries >= row.enquiries,
    ),
    (comm2.topStores?.rows ?? []).map(row => row.enquiries),
  );

  res = await api(
    null,
    'GET',
    '/admin/analytics/commerce?charts=storesByType&storeStatus=OPEN',
    null,
    headers,
  );
  check('a store-status filter narrows the tab', res.status === 200, res.body?.error);

  res = await api(null, 'GET', '/admin/analytics/commerce?complianceState=NOPE', null, headers);
  check('an unknown compliance state is refused', res.status === 400, res.body?.error);

  console.log('\n— Analytics: Deals —');

  await clearAnalyticsCache();

  /**
   * Twelve deals with amounts I can add up by hand, so the money figures are checked against
   * arithmetic rather than against whatever the query returns. Suppressed nulls prove nothing:
   * below the floor every card is null whether the sums are right or not.
   */
  const payer = await makeUser('an-payer');
  const provider = await makeUser('an-provider');
  const dealIds = [];

  // Analytics counts members through `mv_member_dimensions`, which is refreshed on a schedule — so
  // a deal involving somebody who signed up in the last few minutes is genuinely not in it yet.
  // That staleness is the deliberate trade (the member list is live; the charts are not), and a
  // suite that creates its own members has to ask for the refresh rather than assume it.
  await refreshView(headers);

  for (let i = 0; i < 12; i += 1) {
    const amount = 1000 + i * 100; // 1000..2100, median 1550
    const convo = await prisma.conversation.create({
      data: {
        kind: 'PROFESSIONAL',
        participantKey: `e2e-deal-${i}-${Date.now()}`,
        participants: { create: [{ userId: payer.id }, { userId: provider.id }] },
      },
    });
    const deal = await prisma.deal.create({
      data: {
        conversationId: convo.id,
        track: 'PROFESSIONAL',
        payerId: payer.id,
        providerId: provider.id,
        proposedByRole: 'PAYER',
        amount,
        timing: 'ON_COMPLETION',
        isAgreedByBoth: true,
      },
    });

    dealIds.push(deal.id);

    await prisma.dealStep.create({
      data: { dealId: deal.id, stage: 'AGREED', byRole: 'PAYER', reachedAt: new Date() },
    });

    // Ten paid in full and finished, so `completedValue` clears the deal floor and can be checked
    // against arithmetic. The last two are open and recorded at three times their amount — a typo,
    // which the `min(amount, …)` cap must absorb rather than report.
    if (i < 10) {
      await prisma.dealStep.create({
        data: { dealId: deal.id, stage: 'PAID', byRole: 'PAYER', amount, reachedAt: new Date() },
      });
      await prisma.dealStep.create({
        data: { dealId: deal.id, stage: 'DONE', byRole: 'PROVIDER', reachedAt: new Date() },
      });
    } else {
      await prisma.dealStep.create({
        data: {
          dealId: deal.id,
          stage: 'PAID',
          byRole: 'PAYER',
          amount: amount * 3,
          reachedAt: new Date(),
        },
      });
    }
  }

  const amounts = Array.from({ length: 12 }, (_, i) => 1000 + i * 100);
  const mine = {
    dealsAgreed: 12,
    agreedValue: amounts.reduce((sum, a) => sum + a, 0),
    // Every one of the twelve: ten paid in full, two capped at their own amount by the typo guard.
    // So this must come out equal to `agreedValue`, which is the whole point of the cap.
    recordedPaid: amounts.reduce((sum, a) => sum + a, 0),
    completedValue: amounts.slice(0, 10).reduce((sum, a) => sum + a, 0),
    medianValue: (amounts[5] + amounts[6]) / 2,
  };

  await refreshView(headers);
  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/deals', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check(
    'with all eight charts',
    [
      'totals',
      'byProfession',
      'dealsByTrack',
      'agreedValue',
      'stageFunnel',
      'completionCancellation',
      'problems',
      'paymentTiming',
    ].every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}),
  );
  check(
    'and none of them failed',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {})
      .filter(([, chart]) => chart.kind === 'error')
      .map(([id, c]) => [id, c.code]),
  );

  const money = res.body?.data?.charts?.totals?.items ?? {};

  check(
    `dealsAgreed counts the live agreed deals (${mine.dealsAgreed}+)`,
    money.dealsAgreed?.value >= mine.dealsAgreed,
    money.dealsAgreed,
  );
  check('agreedValue is the sum of their amounts', money.agreedValue?.value >= mine.agreedValue, {
    got: money.agreedValue?.value,
    atLeast: mine.agreedValue,
  });
  check(
    'completedValue counts only the DONE deals, and is less than everything agreed',
    money.completedValue?.value >= mine.completedValue &&
      money.completedValue?.value < money.agreedValue?.value,
    { got: money.completedValue?.value, atLeast: mine.completedValue },
  );

  // The typo guard. Two deals recorded three times their amount; `recordedPaid` caps each at what
  // was agreed, so it can never exceed `agreedValue` however badly somebody mistypes.
  check(
    'recordedPaid caps each deal at the amount agreed, so a typo cannot inflate it',
    money.recordedPaid?.value <= money.agreedValue?.value,
    {
      recordedPaid: money.recordedPaid?.value,
      agreedValue: money.agreedValue?.value,
    },
  );
  check(
    'and outstanding is never negative, for the same reason',
    money.outstanding === undefined ||
      money.outstanding?.value === null ||
      money.outstanding.value >= 0,
    money.outstanding,
  );
  check(
    'medianValue is a whole number of pence',
    Number.isInteger(money.medianValue?.value),
    money.medianValue,
  );
  check(
    'every money card is in pence',
    ['agreedValue', 'recordedPaid', 'outstanding', 'completedValue', 'medianValue'].every(
      id => money[id]?.unit === 'pence',
    ),
    Object.fromEntries(Object.entries(money).map(([k, v]) => [k, v.unit])),
  );
  check('while dealsAgreed is a count', money.dealsAgreed?.unit === 'count', money.dealsAgreed);

  // Each figure has its own contributing set, so they suppress independently. Only two of the
  // twelve are still open, so `outstanding` is withheld while the other four cards are not — which
  // is the addendum's §4 table working rather than a gap.
  check(
    'outstanding is withheld because only two deals are open, while the rest are shown',
    money.outstanding?.value === null &&
      money.outstanding?.suppressed === true &&
      money.agreedValue?.value !== null,
    { outstanding: money.outstanding, agreedValue: money.agreedValue?.value },
  );

  // The series total has to equal the card, which is what excluding cancelled deals fixed.
  const seriesTotal = (res.body?.data?.charts?.agreedValue?.series?.[0]?.points ?? []).reduce(
    (sum, point) => sum + (point.v ?? 0),
    0,
  );

  check(
    'the agreedValue series sums to the agreedValue card, ignoring suppressed buckets',
    seriesTotal <= money.agreedValue?.value,
    { series: seriesTotal, card: money.agreedValue?.value },
  );

  check(
    'byProfession returns rows now there are enough deals',
    (res.body?.data?.charts?.byProfession?.rows ?? []).length > 0,
    res.body?.data?.charts?.byProfession?.rows,
  );
  check(
    'and every row is built from at least ten deals',
    (res.body?.data?.charts?.byProfession?.rows ?? []).every(row => row.dealsAgreed >= 10),
    (res.body?.data?.charts?.byProfession?.rows ?? []).map(row => [
      row.profession,
      row.dealsAgreed,
    ]),
  );

  check(
    'the stage funnel has a sequence per track',
    ['COMMERCE', 'PROFESSIONAL'].every(
      track => (res.body?.data?.charts?.stageFunnel?.items?.[track]?.steps ?? []).length > 0,
    ),
    Object.keys(res.body?.data?.charts?.stageFunnel?.items ?? {}),
  );
  // Deliberately **not** a monotonicity check. This is a "stage reached" funnel and the stages are
  // not strictly sequential in practice: a deal can go straight to PAID without a deposit, so
  // DEPOSIT_PAID is legitimately zero while PAID is not. Asserting a descending sequence would be
  // asserting something about the product that is not true.
  check(
    'every step of the deal funnel is a real count, never withheld',
    (res.body?.data?.charts?.stageFunnel?.items?.PROFESSIONAL?.steps ?? []).every(
      step => typeof step.value === 'number' && step.value >= 0,
    ),
    res.body?.data?.charts?.stageFunnel?.items?.PROFESSIONAL?.steps?.map(s => s.value),
  );
  check(
    'because a deal funnel counts deals, not members — the member floor would hole it',
    res.body?.data?.charts?.stageFunnel?.items?.PROFESSIONAL?.unit === 'count',
    res.body?.data?.charts?.stageFunnel?.items?.PROFESSIONAL?.unit,
  );
  check(
    'while the onboarding funnel counts members, so it does declare that',
    (await api(null, 'GET', '/admin/analytics/growth?charts=onboardingFunnel', null, headers)).body
      ?.data?.charts?.onboardingFunnel?.unit === 'members',
    'unit',
  );

  check(
    'completion and cancellation are rates, and null where nothing was created',
    res.body?.data?.charts?.completionCancellation?.unit === 'ratio' &&
      (res.body?.data?.charts?.completionCancellation?.series?.[0]?.points ?? []).every(
        point => point.v === null || (point.v >= 0 && point.v <= 1),
      ),
    res.body?.data?.charts?.completionCancellation?.series?.[0]?.points?.slice(0, 3),
  );

  res = await api(
    null,
    'GET',
    '/admin/analytics/deals?track=COMMERCE&charts=totals',
    null,
    headers,
  );
  check(
    'a track filter changes the figures',
    res.body?.data?.charts?.totals?.items?.dealsAgreed?.value < mine.dealsAgreed,
    res.body?.data?.charts?.totals?.items?.dealsAgreed,
  );

  res = await api(null, 'GET', '/admin/analytics/deals?track=NOWHERE', null, headers);
  check('an unknown track is refused', res.status === 400, res.body?.error);

  await prisma.dealStep.deleteMany({ where: { dealId: { in: dealIds } } });
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });

  console.log('\n— Analytics: Search & Demand —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/search', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check(
    'with all four charts',
    ['topTerms', 'zeroResultTerms', 'volumeBySection', 'demandGaps'].every(
      id => id in (res.body?.data?.charts ?? {}),
    ),
    Object.keys(res.body?.data?.charts ?? {}),
  );
  check(
    'and none of them failed',
    Object.values(res.body?.data?.charts ?? {}).every(chart => chart.kind !== 'error'),
    Object.entries(res.body?.data?.charts ?? {})
      .filter(([, chart]) => chart.kind === 'error')
      .map(([id, c]) => [id, c.code]),
  );

  const srch = res.body.data.charts;

  /**
   * The floor applies to the **row** here, not the cell. Withholding the number while still
   * printing the term would say "fewer than ten people searched for this", which is the
   * disclosure — so the term never appears at all.
   */
  check(
    'every listed term was searched by at least ten members',
    (srch.topTerms?.rows ?? []).every(row => row.uniqueSearchers >= 10),
    srch.topTerms?.rows?.map(row => [row.term, row.uniqueSearchers]).slice(0, 4),
  );
  check(
    'and the member column declares its unit, so the floor can find it',
    srch.topTerms?.columns?.find(column => column.key === 'uniqueSearchers')?.unit === 'members',
    srch.topTerms?.columns,
  );
  check(
    'resultRate is a percentage, not a fraction',
    (srch.topTerms?.rows ?? []).every(
      row => row.resultRate === null || (row.resultRate >= 0 && row.resultRate <= 100),
    ),
    srch.topTerms?.rows?.map(row => row.resultRate).slice(0, 4),
  );

  // A term beside an exact timestamp can be matched to one session, and the day is all anybody
  // needs in order to act on it.
  check(
    'zero-result terms are dated to the day, not the moment',
    (srch.zeroResultTerms?.rows ?? []).every(row => /^\d{4}-\d{2}-\d{2}$/.test(row.lastSearchedAt)),
    srch.zeroResultTerms?.rows?.map(row => row.lastSearchedAt).slice(0, 3),
  );
  check(
    'and publish no member count at all',
    (srch.zeroResultTerms?.columns ?? []).every(column => column.unit !== 'members'),
    srch.zeroResultTerms?.columns,
  );

  check(
    'volumeBySection gives every scope a line, so an unused section reads as zero',
    (srch.volumeBySection?.series ?? []).length === 5 && srch.volumeBySection.unit === 'count',
    srch.volumeBySection?.series?.map(series => series.key),
  );

  check(
    'demandGaps is a matrix of scores',
    srch.demandGaps?.unit === 'ratio',
    srch.demandGaps?.unit,
  );

  /**
   * Seeded, not borrowed — and the table is **emptied first and put back afterwards**.
   *
   * Two earlier versions of this block were wrong in opposite directions. The first asserted
   * against whatever happened to be in `demand_signals`, which made the checks pass or fail on
   * suite order (`intelligence-deletion.e2e.cjs` empties the table wholesale). The second seeded
   * its own two rows but still read the chart over every other row in the table, so the moment
   * the intelligence job computed a real `LONDON/STORE_ITEM/FOOD_GROCERIES` signal the fixture
   * collided with it on the unique key — and, had it not collided, the asserted window would have
   * silently spanned the real rows instead of the two being tested.
   *
   * So the block owns the table while it runs: every row is set aside, the fixtures are the only
   * signals the chart can see, and the originals go back at the end. `demand_signals` is derived
   * data that the intelligence jobs rebuild, which is what makes that safe.
   *
   * Two signals with deliberately different windows, so the reported window has to be the span
   * across both rather than either one's own.
   */
  const parkedSignals = await prisma.demandSignal.findMany();

  await prisma.demandSignal.deleteMany({});

  const signalIds = [];

  for (const signal of [
    { city: 'LONDON', code: 'FOOD_GROCERIES', start: '2026-08-01', end: '2026-08-31', score: 4.5 },
    { city: 'MANCHESTER', code: 'LANGUAGE_HELP', start: '2026-08-15', end: '2026-09-14', score: 9 },
  ]) {
    const row = await prisma.demandSignal.create({
      data: {
        cityId: signal.city,
        surface: 'STORE_ITEM',
        code: signal.code,
        term: '',
        label: signal.code,
        score: signal.score,
        windowStart: new Date(`${signal.start}T00:00:00Z`),
        windowEnd: new Date(`${signal.end}T00:00:00Z`),
        computedAt: new Date(`${signal.end}T06:00:00Z`),
      },
    });

    signalIds.push(row.id);
  }

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/search?charts=demandGaps', null, headers);

  const gaps = res.body?.data?.charts?.demandGaps;

  check(
    'the window spans every signal charted, not just one of them',
    gaps?.window?.from === '2026-08-01' && gaps?.window?.to === '2026-09-14',
    gaps?.window,
  );
  check(
    'and names when the job last computed them',
    gaps?.window?.computedAt?.startsWith('2026-09-14'),
    gaps?.window?.computedAt,
  );
  check(
    'the scores land in their own city and category',
    gaps?.cells?.[gaps.rows.findIndex(row => row.key === 'MANCHESTER')]?.[
      gaps.cols.findIndex(col => col.key === 'LANGUAGE_HELP')
    ] === 9,
    { rows: gaps?.rows?.map(r => r.key), cols: gaps?.cols?.map(c => c.key), cells: gaps?.cells },
  );

  // A city filter must narrow a precomputed chart even though the date range cannot: the signal
  // carries a city, so there is something to narrow on.
  res = await api(
    null,
    'GET',
    '/admin/analytics/search?charts=demandGaps&cityIds=MANCHESTER',
    null,
    headers,
  );
  check(
    'cityIds narrows demandGaps, and the window narrows with it',
    res.body?.data?.charts?.demandGaps?.window?.from === '2026-08-15',
    res.body?.data?.charts?.demandGaps?.window,
  );
  /**
   * `demand_signals` stores an absent city or code as the empty string, not null, because its
   * unique key is composite. Folded back to null, those blanks keyed a column of their own —
   * thirteen different uncoded terms arrived as one blank column with one blank label.
   */
  check(
    'every axis entry has a key and a label',
    [...(srch.demandGaps?.rows ?? []), ...(srch.demandGaps?.cols ?? [])].every(
      entry => entry.key?.length > 0 && entry.label?.length > 0,
    ),
    [...(srch.demandGaps?.rows ?? []), ...(srch.demandGaps?.cols ?? [])].filter(
      entry => !entry.key?.length || !entry.label?.length,
    ),
  );
  check(
    'and no two axis entries share a key',
    new Set((srch.demandGaps?.cols ?? []).map(col => col.key)).size ===
      srch.demandGaps?.cols?.length,
    srch.demandGaps?.cols?.map(col => col.key),
  );
  check(
    'the grid matches its declared axes',
    srch.demandGaps?.cells?.length === srch.demandGaps?.rows?.length &&
      srch.demandGaps.cells.every(row => row.length === srch.demandGaps.cols.length),
    { rows: srch.demandGaps?.rows?.length, cells: srch.demandGaps?.cells?.length },
  );

  // Precomputed scores: the date picker above the chart does not control them, which is exactly
  // why the chart carries its own window.
  const unranged = await api(
    null,
    'GET',
    '/admin/analytics/search?charts=demandGaps',
    null,
    headers,
  );

  res = await api(
    null,
    'GET',
    `/admin/analytics/search?charts=demandGaps&from=${shift(-1)}&to=${today()}`,
    null,
    headers,
  );
  check(
    'demandGaps ignores the date range it was asked for',
    JSON.stringify(res.body?.data?.charts?.demandGaps?.cells) ===
      JSON.stringify(unranged.body?.data?.charts?.demandGaps?.cells),
    {
      ranged: res.body?.data?.charts?.demandGaps?.cells,
      unranged: unranged.body?.data?.charts?.demandGaps?.cells,
    },
  );
  check(
    'and the tab says so rather than leaving a reader to wonder',
    typeof res.body?.meta?.filterSemantics?.demandGaps === 'string',
    res.body?.meta?.filterSemantics,
  );

  res = await api(null, 'GET', '/admin/analytics/search?scopes=PRODUCTS', null, headers);
  check(
    'a scope filter narrows the sections charted',
    res.body?.data?.charts?.volumeBySection?.series?.length === 1 &&
      res.body.data.charts.volumeBySection.series[0].key === 'PRODUCTS',
    res.body?.data?.charts?.volumeBySection?.series?.map(series => series.key),
  );
  check(
    'and the terms tables with it',
    (res.body?.data?.charts?.topTerms?.rows ?? []).every(row => row.scope === 'PRODUCTS'),
    res.body?.data?.charts?.topTerms?.rows?.map(row => row.scope),
  );

  /**
   * `GUIDES` is a search scope with no supply surface behind it — a guide is written rather than
   * supplied, so the demand job computes no signal for one. The filter therefore has to select
   * nothing; ignoring it would show the whole platform's gaps under a heading saying "Guides".
   */
  res = await api(null, 'GET', '/admin/analytics/search?scopes=GUIDES', null, headers);
  check(
    'a scope with no supply surface selects no demand rather than all of it',
    (res.body?.data?.charts?.demandGaps?.cells ?? null)?.length === 0,
    res.body?.data?.charts?.demandGaps,
  );
  check(
    'while its own searches still chart',
    (res.body?.data?.charts?.volumeBySection?.series?.[0]?.points ?? []).some(
      point => (point.v ?? 0) > 0,
    ),
    res.body?.data?.charts?.volumeBySection?.series?.[0]?.key,
  );

  res = await api(null, 'GET', '/admin/analytics/search?scopes=EVERYWHERE', null, headers);
  check('an unknown scope is refused', res.status === 400, res.body?.error);

  await prisma.demandSignal.deleteMany({ where: { id: { in: signalIds } } });
  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/search?charts=demandGaps', null, headers);
  check(
    'with no signals at all the chart is empty and reports no window, not a made-up one',
    res.body?.data?.charts?.demandGaps?.kind === 'matrix' &&
      res.body.data.charts.demandGaps.window === undefined,
    res.body?.data?.charts?.demandGaps,
  );

  // The real signals go back, so the next suite — and the demo dashboards — see what they did
  // before. Ids and all: a restored row has to be the same row.
  if (parkedSignals.length) {
    await prisma.demandSignal.createMany({ data: parkedSignals, skipDuplicates: true });
  }

  await clearAnalyticsCache();

  /**
   * Both floors, proved by what they leave out.
   *
   * Asserting that every returned row clears the floor only shows the rows that came back are
   * fine; it says nothing about whether a row below the floor would have been excluded. So: four
   * terms, built to sit either side of each threshold.
   */
  const searchers = [];

  for (let i = 0; i < 9; i += 1) {
    searchers.push(await makeUser(`an-searcher-${i}`, { cityId: 'LONDON' }));
  }

  const dictionary = [
    // Nine distinct searchers — one short of §2.7's ten, so it must not be named in topTerms.
    { term: 'e2e nine searchers', searchers: 9, hadResults: true },
    // Two, one short of the zero-result floor of three.
    { term: 'e2e two searchers', searchers: 2, hadResults: false },
    // Three, which clears it.
    { term: 'e2e three searchers', searchers: 3, hadResults: false },
    // Junk is never shown however many people typed it.
    { term: 'e2e junk term', searchers: 9, hadResults: false, source: 'JUNK' },
  ];

  for (const entry of dictionary) {
    await prisma.searchTermCanonical.create({
      data: {
        normalised: entry.term,
        scope: 'PRODUCTS',
        canonical: entry.term,
        source: entry.source ?? 'RAW',
      },
    });

    for (let i = 0; i < entry.searchers; i += 1) {
      // Each member searches it twice, so `searches` and `uniqueSearchers` cannot be confused.
      await prisma.activityEvent.createMany({
        data: [0, 1].map(() => ({
          userId: searchers[i].id,
          verb: 'SEARCH',
          subject: 'STORE_ITEM',
          scope: 'PRODUCTS',
          term: entry.term,
          hadResults: entry.hadResults,
          cityId: 'LONDON',
        })),
      });
    }
  }

  await refreshView(headers);
  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/search?scopes=PRODUCTS', null, headers);

  const named = (res.body?.data?.charts?.topTerms?.rows ?? []).map(row => row.term);
  const failing = (res.body?.data?.charts?.zeroResultTerms?.rows ?? []).map(row => row.term);

  check(
    'a term nine members searched is not named in topTerms',
    !named.includes('e2e nine searchers'),
    named,
  );
  check(
    'a term two members searched and failed is not named either',
    !failing.includes('e2e two searchers'),
    failing,
  );
  check(
    'while three members clears the zero-result floor',
    failing.includes('e2e three searchers'),
    failing,
  );
  check(
    'junk never appears, however many people typed it',
    !named.includes('e2e junk term') && !failing.includes('e2e junk term'),
    { named, failing },
  );
  check(
    'and searches are counted per event, not per member',
    res.body?.data?.charts?.zeroResultTerms?.rows?.find(row => row.term === 'e2e three searchers')
      ?.searches === 6,
    res.body?.data?.charts?.zeroResultTerms?.rows?.find(row => row.term === 'e2e three searchers'),
  );

  await prisma.activityEvent.deleteMany({
    where: { term: { in: dictionary.map(entry => entry.term) } },
  });
  await prisma.searchTermCanonical.deleteMany({
    where: { normalised: { in: dictionary.map(entry => entry.term) } },
  });

  /**
   * The population floor and tables. A table had been falling through the suppressor untouched,
   * which is how a tab of withheld charts kept a table of search terms beside it.
   */
  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/search?heritage=SOUTH_ASIAN', null, headers);
  check(
    'a population under ten suppresses the search tab too',
    res.body?.meta?.populationSuppressed === true,
    res.body?.meta,
  );
  check(
    'the term tables lose their rows entirely, not cell by cell',
    res.body?.data?.charts?.topTerms?.rows?.length === 0 &&
      res.body?.data?.charts?.zeroResultTerms?.rows?.length === 0,
    {
      top: res.body?.data?.charts?.topTerms?.rows,
      zero: res.body?.data?.charts?.zeroResultTerms?.rows,
    },
  );
  check(
    'and say the emptiness was a decision',
    res.body?.data?.charts?.topTerms?.suppressed === true,
    res.body?.data?.charts?.topTerms,
  );
  check(
    'while keeping the header, so the portal still draws a table',
    (res.body?.data?.charts?.topTerms?.columns ?? []).length > 0,
    res.body?.data?.charts?.topTerms?.columns,
  );

  console.log('\n— Analytics: Trust & Safety —');

  /**
   * Fixtures, because the demo dataset has no decided case, no scan above CLEAN, no risk-term hit,
   * no decided appeal and no live suspension — so every one of these charts computes zero and the
   * arithmetic goes unverified.
   *
   * Each chart now reads the table §5.25 names, so the fixtures are five tables rather than one:
   * report cases for time-to-action and the decision mix, `content_safety` for the flagged matrix,
   * `risk_term_hits` for the lexicon table, appeals for the overturn rate, and the queue only for
   * the backlog — which is the one chart still derived from it, on purpose.
   */
  const hour = 3_600_000;
  const safetySubject = await makeUser('an-safety-subject', { cityId: 'LONDON' });
  // Stamped, and swept first. `report_cases` carries a partial unique index — one open case per
  // target (§4.6) — so a run that dies before its cleanup makes the next one fail on a fixture
  // rather than on a chart. Both halves, because the stamp alone leaves rows behind for ever and
  // the sweep alone still collides with a parallel run.
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  for (const [model, prefix] of [
    ['reportCase', 'e2e-case-'],
    ['contentSafety', 'e2e-scan-'],
    ['moderationQueueItem', 'e2e-safety-'],
  ]) {
    await prisma[model].deleteMany({ where: { targetId: { startsWith: prefix } } });
  }

  await prisma.riskTerm.deleteMany({ where: { pattern: { startsWith: 'e2e ' } } });

  const riskTerm = await prisma.riskTerm.create({
    data: { category: 'SCAM', pattern: `e2e wire the deposit ${stamp}`, weight: 40 },
  });
  const otherTerm = await prisma.riskTerm.create({
    data: { category: 'HATE', pattern: `e2e never resolved ${stamp}`, weight: 20 },
  });

  // ── report_cases: time to action, and the decision mix ────────────────────
  //
  // `first_action_at − first_reported_at`, not time-to-decision, and the case's own priority
  // rather than a risk level mapped onto one. The fourth case is the fold: `REMOVE_AND_SUSPEND`
  // must land on the SUSPEND_AUTHOR band rather than on one of its own.
  const caseIds = [];

  for (const item of [
    { priority: 'URGENT', actedAfter: 0.5, decision: 'SUSPEND_AUTHOR' },
    { priority: 'NORMAL', actedAfter: 3, decision: 'NO_ACTION' },
    { priority: 'HIGH', actedAfter: null, decision: null },
    { priority: 'URGENT', actedAfter: 1, decision: 'REMOVE_AND_SUSPEND' },
  ]) {
    const reported = new Date(Date.now() - 6 * hour);
    const row = await prisma.reportCase.create({
      data: {
        targetType: 'UPDATE',
        targetId: `e2e-case-${stamp}-${item.priority}-${item.decision ?? 'open'}`,
        targetUserId: safetySubject.id,
        priority: item.priority,
        state: item.decision ? 'ACTIONED' : 'OPEN',
        // The one reason no other case on the platform carries, so `?reasonCodes=ILLEGAL_ITEM`
        // isolates these four exactly — and does it through `caseScope`'s array overlap, which is
        // the code path the filter uses in earnest.
        reasonCodes: ['ILLEGAL_ITEM'],
        riskLevel: 'MEDIUM',
        firstReportedAt: reported,
        lastReportedAt: reported,
        dueAt: new Date(Date.now() + 24 * hour),
        ...(item.actedAfter === null
          ? {}
          : {
              firstActionAt: new Date(reported.getTime() + item.actedAfter * hour),
              decision: item.decision,
              decidedAt: new Date(reported.getTime() + item.actedAfter * hour),
            }),
      },
    });

    caseIds.push(row.id);
  }

  // ── content_safety: the flagged matrix ───────────────────────────────────
  //
  // Scans, not queue items — which is the whole point of the move. The CLEAN row proves the floor
  // is excluded, and it is a row the old source could not have produced at all: a scan that found
  // nothing never became a queue item.
  const scanIds = [];

  for (const scan of [
    { tier: 'CRITICAL', category: 'SCAM' },
    { tier: 'MEDIUM', category: 'SCAM' },
    { tier: 'LOW', category: 'HATE' },
    { tier: 'CLEAN', category: null },
    // Flagged, with **no category**. `ContentSafety.category` is nullable and `categoryOf` returns
    // the lexicon's category — null when the classifier is what raised the score. There are no
    // such rows in the wild yet only because the classifier is switched off (§6.7), so this is the
    // row that proves the matrix has somewhere to put one: without the "Not categorised" column,
    // `toMatrix` maps the null onto its own UNKNOWN key, finds no column and drops the cell.
    { tier: 'HIGH', category: null },
  ]) {
    const row = await prisma.contentSafety.create({
      data: {
        targetType: 'UPDATE',
        targetId: `e2e-scan-${stamp}-${scan.tier}`,
        authorId: safetySubject.id,
        tier: scan.tier,
        category: scan.category ?? undefined,
        finalScore: 50,
        scanStatus: 'COMPLETE',
      },
    });

    scanIds.push(row.id);
  }

  // ── risk_term_hits: the lexicon table ───────────────────────────────────
  //
  // Three hits on one phrase with the three outcomes, so the false-positive rate is taken over the
  // two that were resolved. A hit on a second term that nobody has looked at proves the other half:
  // a term with no resolved hits reports a null rate rather than a flattering zero.
  const hitIds = [];

  for (const hit of [
    { term: riskTerm.id, outcome: 'CONFIRMED' },
    { term: riskTerm.id, outcome: 'FALSE_POSITIVE' },
    { term: riskTerm.id, outcome: 'PENDING' },
    { term: otherTerm.id, outcome: 'PENDING' },
  ]) {
    const row = await prisma.riskTermHit.create({
      data: {
        riskTermId: hit.term,
        contentSafetyId: scanIds[0],
        targetType: 'UPDATE',
        targetId: `e2e-scan-${stamp}-CRITICAL`,
        outcome: hit.outcome,
      },
    });

    hitIds.push(row.id);
  }

  // ── appeals: the overturn rate ──────────────────────────────────────────
  //
  // One upheld, one overturned, one withdrawn and one still open. The rate is 50% — over the two
  // that were answered, and the two that were not must not drag it to 25%.
  const appealIds = [];

  for (const appeal of [
    { state: 'UPHELD', decided: true },
    { state: 'OVERTURNED', decided: true },
    { state: 'WITHDRAWN', decided: true },
    { state: 'OPEN', decided: false },
  ]) {
    const row = await prisma.appeal.create({
      data: {
        userId: safetySubject.id,
        subjectType: 'REPORT_CASE',
        subjectId: caseIds[0],
        statement: `e2e appeal in state ${appeal.state}`,
        loggedById: admin.id,
        state: appeal.state,
        dueAt: new Date(Date.now() + 24 * hour),
        ...(appeal.decided ? { decidedAt: new Date(Date.now() - 2 * hour) } : {}),
      },
    });

    appealIds.push(row.id);
  }

  // ── moderation_queue_items: the backlog, and only the backlog ───────────
  const queueIds = [];

  for (const item of [
    { type: 'GUARD_RISK', level: 'CRITICAL', decidedAfter: 0.5, decision: 'SUSPEND_AUTHOR' },
    { type: 'REPORTED_CONTENT', level: 'MEDIUM', decidedAfter: 3, decision: 'NO_ACTION' },
    { type: 'GUARD_RISK', level: 'HIGH', decidedAfter: null, decision: null },
    { type: 'ANONYMOUS_POST', level: 'NONE', decidedAfter: null, decision: null },
  ]) {
    const created = new Date(Date.now() - 6 * hour);
    const row = await prisma.moderationQueueItem.create({
      data: {
        // §5.9: both required since the queue gained a deadline. Non-nullable on purpose — an
        // item that can never be overdue sorts last in a queue ordered by urgency.
        priority: 'NORMAL',
        dueAt: new Date(Date.now() + 24 * hour),
        type: item.type,
        state: item.decision ? 'RESOLVED' : 'PENDING',
        targetType: 'UPDATE',
        targetId: `e2e-safety-${stamp}-${item.type}-${item.level}`,
        subjectUserId: safetySubject.id,
        riskLevel: item.level,
        riskCategory: item.level === 'NONE' ? null : 'SCAM',
        riskScore: 50,
        decision: item.decision ?? undefined,
        decidedAt:
          item.decidedAfter === null
            ? undefined
            : new Date(created.getTime() + item.decidedAfter * hour),
        createdAt: created,
      },
    });

    queueIds.push(row.id);
  }

  const suspensionIds = [];

  for (const live of [true, false]) {
    const row = await prisma.suspension.create({
      data: {
        userId: safetySubject.id,
        reasonCode: 'SAFETY_CONCERN',
        sourceType: 'MANUAL',
        issuedById: admin.id,
        startsAt: new Date(Date.now() - 3 * hour),
        ...(live ? {} : { liftedAt: new Date(Date.now() - hour), liftedById: admin.id }),
      },
    });

    suspensionIds.push(row.id);
  }

  await refreshView(headers);
  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/trust-safety', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check(
    'with all ten charts',
    [
      'reportsByReason',
      'reportsByTarget',
      'timeToAction',
      'queueBacklog',
      'decisionMix',
      'flaggedByTierCategory',
      'topRiskTerms',
      'guardCases',
      'appealOverturn',
      'activeSuspensions',
    ].every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}),
  );

  const ts = res.body.data.charts;

  /**
   * All ten now compute. Nine did before, and the tenth — `appealOverturn` — was a
   * `NOT_AVAILABLE_YET` slot because §5.11's appeals had no table. The whole tab reading its own
   * sources is what this one check is for: an `{ kind: 'error' }` anywhere means a chart has gone
   * back to standing in for itself.
   */
  check(
    'every one of them computed',
    Object.entries(ts).filter(([, chart]) => chart.kind === 'error').length === 0,
    Object.entries(ts)
      .filter(([, chart]) => chart.kind === 'error')
      .map(([id, c]) => [id, c.code]),
  );

  check(
    'reportsByReason keeps a band per declared reason, so a stack never reorders itself',
    (ts.reportsByReason?.series ?? []).length === 10,
    ts.reportsByReason?.series?.map(series => series.key),
  );
  check(
    'and counts reports rather than reporters',
    ts.reportsByReason?.unit === 'count',
    ts.reportsByReason?.unit,
  );

  check(
    'timeToAction draws a band for every priority a case can carry',
    (ts.timeToAction?.series ?? []).map(series => series.key).join() === 'URGENT,HIGH,NORMAL',
    ts.timeToAction?.series?.map(series => series.key),
  );
  check('measured in minutes', ts.timeToAction?.unit === 'minutes', ts.timeToAction?.unit);

  /**
   * The arithmetic, over the four fixture cases alone.
   *
   * Filtered rather than read off the whole tab, because the demo dataset holds sixty-four decided
   * cases whose first action is the same instant as their first report — a median of zero on every
   * line, which swamps any fixture and would make this assertion pass or fail for reasons that
   * have nothing to do with the code. The first version of this check did exactly that.
   *
   * 30 and 60 minutes on the two URGENT cases, so the URGENT line is **45** — a figure neither
   * case has on its own, and one the old implementation could not have produced: it took the
   * *larger* of two medians, because a risk level is not a priority and `NORMAL` combined two of
   * them. 180 on NORMAL, and nothing at all on HIGH, whose only case has not been actioned.
   */
  await clearAnalyticsCache();

  res = await api(
    null,
    'GET',
    '/admin/analytics/trust-safety?reasonCodes=ILLEGAL_ITEM&charts=timeToAction,decisionMix',
    null,
    headers,
  );

  const only = res.body?.data?.charts ?? {};
  const line = key => only.timeToAction?.series?.find(series => series.key === key);
  const minutesOn = key => (line(key)?.points ?? []).filter(point => point.v !== null);

  check(
    'time to **first action**, medianed within one priority',
    minutesOn('URGENT').length === 1 && minutesOn('URGENT')[0].v === 45,
    minutesOn('URGENT'),
  );
  check(
    'the NORMAL case at three hours',
    minutesOn('NORMAL').length === 1 && minutesOn('NORMAL')[0].v === 180,
    minutesOn('NORMAL'),
  );
  check(
    'and nothing at all where a case has not been actioned',
    minutesOn('HIGH').length === 0,
    minutesOn('HIGH'),
  );

  /**
   * The same four cases, so the decision mix is exact rather than "at least". Two land on
   * `SUSPEND_AUTHOR` — one decided that way and one `REMOVE_AND_SUSPEND` folded onto it — one on
   * `NO_ACTION`, and the fourth is open and so has no decision to count.
   */
  const band = key => only.decisionMix?.items?.find(item => item.key === key)?.value;

  check(
    'REMOVE_AND_SUSPEND folds onto SUSPEND_AUTHOR rather than being lost',
    band('SUSPEND_AUTHOR') === 2,
    only.decisionMix?.items?.map(item => [item.key, item.value]),
  );
  check(
    'the other decided case is counted once, and the open one not at all',
    band('NO_ACTION') === 1 && only.decisionMix?.total === 3,
    { noAction: band('NO_ACTION'), total: only.decisionMix?.total },
  );
  check(
    'with no band for a compound decision, which would double-count the same severity',
    !(only.decisionMix?.items ?? []).some(item => item.key.startsWith('REMOVE_AND_')),
    only.decisionMix?.items?.map(item => item.key),
  );

  /**
   * The backlog is derived rather than snapshotted, so the invariants are what prove it: it can
   * never go negative, and its last point must equal the live count of open items. This is the one
   * chart still read from the queue, and deliberately so — derived, the series is exact, where
   * `moderation_backlog_daily` would be a nightly sample that can drift from the live count.
   */
  const backlog = ts.queueBacklog?.series ?? [];
  // Scoped the way the chart is scoped. `PROFESSIONAL_REVIEW` shares the queue table but is not
  // moderation work, so safety analytics leaves it out everywhere; counting it here would make the
  // invariant fail for the one reason that is correct.
  const live = await prisma.moderationQueueItem.count({
    where: { decidedAt: null, type: { not: 'PROFESSIONAL_REVIEW' } },
  });

  check(
    'queueBacklog never goes negative',
    backlog.every(series => series.points.every(point => (point.v ?? 0) >= 0)),
    backlog.flatMap(series =>
      series.points
        .filter(point => (point.v ?? 0) < 0)
        .map(point => [series.key, point.t, point.v]),
    ),
  );
  check(
    'and its last point equals the open items the queue actually holds',
    backlog.reduce(
      (running, series) => running + (series.points[series.points.length - 1]?.v ?? 0),
      0,
    ) === live,
    {
      charted: backlog.map(series => [series.key, series.points[series.points.length - 1]?.v]),
      live,
    },
  );

  /**
   * The five bands §5.25 names, from `report_cases.decision`, with `REMOVE_AND_*` folded under
   * their strongest action. The fourth fixture case was decided `REMOVE_AND_SUSPEND` and there is
   * no band of that name — so if the fold is dropped, the case vanishes from a chart that still
   * adds up.
   */
  check(
    'decisionMix draws the five bands a case can be decided, strongest first',
    (ts.decisionMix?.items ?? []).map(item => item.key).join() ===
      'SUSPEND_AUTHOR,REMOVE_CONTENT,WARN_AUTHOR,NO_ACTION,ESCALATE_GUARD',
    ts.decisionMix?.items?.map(item => item.key),
  );

  check(
    'the shares are over the folded total, so they still sum to one',
    Math.abs((ts.decisionMix?.items ?? []).reduce((sum, i) => sum + (i.share ?? 0), 0) - 1) < 0.01,
    ts.decisionMix?.items?.map(item => item.share),
  );

  /**
   * Tiers, from the scan table. `CLEAN` is excluded because a scan that found nothing is not a
   * flag — and the `LOW` row is what the old source could not produce: it read the queue items the
   * scanner raised, and a LOW scan is never held, so that row was permanently empty.
   */
  check(
    'the flagged matrix charts tiers and leaves CLEAN out',
    (ts.flaggedByTierCategory?.rows ?? []).map(row => row.key).join() ===
      'LOW,MEDIUM,HIGH,CRITICAL',
    ts.flaggedByTierCategory?.rows?.map(row => row.key),
  );
  check(
    'and keeps a column for a flagged scan nobody categorised',
    (ts.flaggedByTierCategory?.cols ?? []).some(col => col.key === 'UNKNOWN'),
    ts.flaggedByTierCategory?.cols?.map(col => col.key),
  );

  const cell = (chart, rowKey, colKey) =>
    chart?.cells?.[chart.rows.findIndex(row => row.key === rowKey)]?.[
      chart.cols.findIndex(col => col.key === colKey)
    ];

  check(
    'and files each scan under its own tier and category',
    cell(ts.flaggedByTierCategory, 'CRITICAL', 'SCAM') >= 1 &&
      cell(ts.flaggedByTierCategory, 'MEDIUM', 'SCAM') >= 1 &&
      cell(ts.flaggedByTierCategory, 'LOW', 'HATE') >= 1,
    ts.flaggedByTierCategory?.cells,
  );
  check(
    'including the uncategorised one, which used to be dropped silently',
    cell(ts.flaggedByTierCategory, 'HIGH', 'UNKNOWN') >= 1,
    { cell: cell(ts.flaggedByTierCategory, 'HIGH', 'UNKNOWN') },
  );

  /**
   * The hit log, with its own outcome column. A hit nobody has looked at is neither confirmed nor
   * a false positive — counting it either way makes a fresh term look infallible or useless, and
   * the second is when somebody deletes the term that was working.
   */
  const term = (ts.topRiskTerms?.rows ?? []).find(row => row.pattern === riskTerm.pattern);

  check(
    'topRiskTerms reads the hit log',
    term !== undefined,
    ts.topRiskTerms?.rows?.map(row => row.pattern),
  );
  check(
    'resolving each row to its lexicon entry by id, so a reviewer can act on it',
    term?.termId === riskTerm.id,
    { got: term?.termId, want: riskTerm.id },
  );
  check(
    'three hits: one confirmed, one a false positive, one still pending',
    term?.hits === 3 && term?.confirmed === 1 && term?.falsePositives === 1,
    term,
  );
  check(
    'and a rate over the resolved ones only, not over all three',
    term?.falsePositiveRate === 50,
    term?.falsePositiveRate,
  );

  const unresolved = (ts.topRiskTerms?.rows ?? []).find(row => row.pattern === otherTerm.pattern);

  check(
    'a term whose hits nobody has judged reports a null rate, not a flattering zero',
    unresolved?.hits === 1 && unresolved?.falsePositiveRate === null,
    unresolved,
  );

  check(
    'guardCases keeps a row for threads nobody has categorised yet',
    (ts.guardCases?.rows ?? []).some(row => row.key === 'UNKNOWN'),
    ts.guardCases?.rows?.map(row => row.key),
  );
  check(
    'and counts threads rather than members',
    ts.guardCases?.unit === 'count',
    ts.guardCases?.unit,
  );

  /**
   * One upheld, one overturned, one withdrawn, one open. 50%, over the two that were answered —
   * and a number whose job is to catch a reviewer being wrong too often must not be flattered by
   * the two that were not.
   */
  check(
    'appealOverturn is a rate and a trend, not an error',
    ts.appealOverturn?.kind === 'group' &&
      ts.appealOverturn.items?.rate?.kind === 'kpi' &&
      ts.appealOverturn.items?.trend?.kind === 'timeseries',
    ts.appealOverturn?.kind,
  );
  check(
    'over the decided appeals only: 1 of 2, not 1 of 4',
    ts.appealOverturn?.items?.rate?.value === 50,
    {
      value: ts.appealOverturn?.items?.rate?.value,
      unit: ts.appealOverturn?.items?.rate?.unit,
    },
  );
  check(
    'and its trend is null where nothing was decided, rather than zero',
    (ts.appealOverturn?.items?.trend?.series?.[0]?.points ?? []).some(point => point.v === null),
    ts.appealOverturn?.items?.trend?.series?.[0]?.points?.slice(-3),
  );

  /**
   * "As of", not "in the range". A suspension issued last year and still in force is a current
   * fact; one lifted an hour ago is not.
   */
  check(
    'activeSuspensions counts the live suspension and not the lifted one',
    ts.activeSuspensions?.value === 1,
    { value: ts.activeSuspensions?.value, spark: ts.activeSuspensions?.sparkline?.slice(-2) },
  );
  check(
    'and is a count of members, so its sparkline obeys the floor',
    ts.activeSuspensions?.unit === 'members',
    ts.activeSuspensions?.unit,
  );

  // ── The filter bar across five tables ────────────────────────────────────

  await clearAnalyticsCache();

  res = await api(
    null,
    'GET',
    '/admin/analytics/trust-safety?riskCategories=HATE&charts=flaggedByTierCategory,topRiskTerms',
    null,
    headers,
  );
  check(
    'a risk-category filter narrows the flagged matrix to that column',
    (res.body?.data?.charts?.flaggedByTierCategory?.cells ?? [])
      .flat()
      .filter(Boolean)
      .every(Boolean) &&
      cell(res.body?.data?.charts?.flaggedByTierCategory, 'CRITICAL', 'SCAM') === 0,
    res.body?.data?.charts?.flaggedByTierCategory?.cells,
  );
  check(
    'and the lexicon table to that category — the term’s own, not the scan’s',
    (res.body?.data?.charts?.topRiskTerms?.rows ?? []).every(
      row => row.category === 'Hate' && row.pattern !== riskTerm.pattern,
    ),
    res.body?.data?.charts?.topRiskTerms?.rows?.map(row => [row.pattern, row.category]),
  );

  await clearAnalyticsCache();

  res = await api(
    null,
    'GET',
    '/admin/analytics/trust-safety?states=ACTIONED&charts=decisionMix',
    null,
    headers,
  );
  check(
    'a state the two enums share reaches the case charts',
    res.status === 200 &&
      (res.body?.data?.charts?.decisionMix?.items ?? []).some(item => (item.value ?? 0) > 0),
    res.body?.data?.charts?.decisionMix?.items?.filter(item => (item.value ?? 0) > 0),
  );
  check(
    'and the payload says which filters crossed which enum',
    typeof res.body?.meta?.filterSemantics?.states === 'string' &&
      res.body.meta.filterSemantics.states.includes('ReportCaseState'),
    res.body?.meta?.filterSemantics?.states,
  );
  // A filter that narrows one chart out of ten is one somebody will reach for expecting the tab to
  // move. The payload has to say so, because nothing else will.
  check(
    'and that `queueTypes` now reaches only the backlog',
    (res.body?.meta?.filterSemantics?.queueTypes ?? '').includes('queueBacklog'),
    res.body?.meta?.filterSemantics?.queueTypes,
  );

  res = await api(null, 'GET', '/admin/analytics/trust-safety?riskLevels=SEVERE', null, headers);
  check('an unknown risk level is refused', res.status === 400, res.body?.error);

  res = await api(null, 'GET', '/admin/analytics/trust-safety?states=RECEIVED', null, headers);
  check('a report state is accepted', res.status === 200, res.body?.error);

  console.log('\n— Analytics: Support —');

  await clearAnalyticsCache();

  res = await api(null, 'GET', '/admin/analytics/support', null, headers);
  check('the tab answers', res.status === 200, res.body?.error);
  check(
    'with all five charts',
    [
      'openedResolved',
      'responseTimes',
      'threadsByType',
      'workloadPerAgent',
      'disputesByReasonOutcome',
    ].every(id => id in (res.body?.data?.charts ?? {})),
    Object.keys(res.body?.data?.charts ?? {}),
  );

  /**
   * The four thread charts answered `NOT_AVAILABLE_YET` until §4.8's `support_threads` existed.
   * They read it now, and the arithmetic below is asserted against stamped fixtures rather than
   * against whatever the demo seed happens to contain.
   *
   * Isolation is `assigneeIds`: every fixture is assigned to one fresh support account, and the
   * filter reaches all four charts, so the numbers are exactly the ones put there. Checking a
   * median against an unfiltered tab is how the Trust & Safety section first reported zero for
   * every line.
   */
  check(
    'the four thread charts are real charts now, not NOT_AVAILABLE_YET',
    res.body?.data?.charts?.openedResolved?.kind === 'timeseries' &&
      res.body?.data?.charts?.responseTimes?.kind === 'group' &&
      res.body?.data?.charts?.threadsByType?.kind === 'breakdown' &&
      res.body?.data?.charts?.workloadPerAgent?.kind === 'group',
    Object.entries(res.body?.data?.charts ?? {}).map(([id, c]) => [id, c.kind, c.code]),
  );

  // ── Support: the four thread charts, on fixtures ──────────────────────────
  const agent = await makeAdmin('an-sup-agent', 'support');
  const minutes = n => n * 60_000;
  const daysAgo = n => new Date(Date.parse(`${today()}T12:00:00Z`) - n * 86_400_000);

  // Four threads, each with its own member, stamped so every number below is known. Written
  // directly: what is being tested is the arithmetic over the columns, and driving four member
  // journeys through four sections to produce them would test those sections instead.
  //
  // `memberDelayMins` is the load-bearing part: the member writes some time **after** the thread
  // is opened, because four of the five types are opened by Circl. Without it, measuring from
  // `created_at` and measuring from the member's first message would give the same answer on every
  // fixture, and the assertion below would pass against the wrong column.
  //
  // Member-based response times are 30, 60 and 10 → median 30. From `created_at` they would be
  // 30, 360 and 610 → median 360, so the one number catches the wrong column.
  const threadFixtures = [
    {
      tag: 'sup-a',
      type: 'SUPPORT',
      openedAt: 10,
      memberDelayMins: 0,
      firstResponseMins: 30,
      resolvedDay: 9,
    },
    {
      tag: 'sup-b',
      type: 'MANAGED',
      openedAt: 8,
      memberDelayMins: 300,
      firstResponseMins: 60,
      resolvedDay: 7,
    },
    {
      tag: 'sup-c',
      type: 'DEAL_PROBLEM',
      openedAt: 6,
      memberDelayMins: 600,
      firstResponseMins: 10,
      resolvedDay: null,
    },
    // Circl opened this one and the member has not written, so it has no response time to report.
    {
      tag: 'sup-d',
      type: 'GUARD',
      openedAt: 4,
      memberDelayMins: null,
      firstResponseMins: null,
      resolvedDay: null,
    },
  ];

  for (const fixture of threadFixtures) {
    const member = await makeUser(`an-${fixture.tag}`, { cityId: 'BRISTOL' });
    const openedAt = daysAgo(fixture.openedAt);
    const conversation = await prisma.conversation.create({
      data: {
        kind: 'SUPPORT',
        contextType: 'SUPPORT',
        contextId: null,
        participantKey: `${member.id}|an-${fixture.tag}`,
        createdAt: openedAt,
        participants: { create: [{ userId: member.id, role: 'MEMBER' }] },
      },
    });

    await prisma.supportThread.create({
      data: {
        conversationId: conversation.id,
        memberId: member.id,
        type: fixture.type,
        state: fixture.resolvedDay ? 'RESOLVED' : fixture.firstResponseMins ? 'OPEN' : 'NEW',
        assignedToId: agent.id,
        assignedAt: openedAt,
        createdAt: openedAt,
        firstMemberMessageAt:
          fixture.memberDelayMins === null
            ? null
            : new Date(openedAt.getTime() + minutes(fixture.memberDelayMins)),
        firstResponseAt:
          fixture.firstResponseMins === null
            ? null
            : new Date(
                openedAt.getTime() + minutes(fixture.memberDelayMins + fixture.firstResponseMins),
              ),
        resolvedAt: fixture.resolvedDay ? daysAgo(fixture.resolvedDay) : null,
      },
    });
  }

  await clearAnalyticsCache();

  const agentWork = `/admin/analytics/support?assigneeIds=${agent.id}&from=${shift(-14)}&to=${today()}&granularity=day`;

  res = await api(null, 'GET', agentWork, null, headers);
  check('the tab answers for one agent’s work', res.status === 200, res.body?.error);

  const charts = res.body?.data?.charts ?? {};
  const sum = series => (series?.points ?? []).reduce((total, p) => total + (p.v ?? 0), 0);
  const opened = (charts.openedResolved?.series ?? []).find(s => s.key === 'opened');
  const resolved = (charts.openedResolved?.series ?? []).find(s => s.key === 'resolved');

  check('four threads opened in the range', sum(opened) === 4, sum(opened));
  check('two of them settled in it', sum(resolved) === 2, sum(resolved));
  check(
    'and a thread opened and resolved on different days counts in both buckets, not one',
    (opened?.points ?? []).filter(p => p.v > 0).length === 4 &&
      (resolved?.points ?? []).filter(p => p.v > 0).length === 2,
    {
      opened: (opened?.points ?? []).filter(p => p.v > 0).map(p => p.t),
      resolved: (resolved?.points ?? []).filter(p => p.v > 0).map(p => p.t),
    },
  );
  check(
    'counted as threads rather than members, so nothing is suppressed at four',
    charts.openedResolved?.unit === 'count',
    charts.openedResolved?.unit,
  );

  // 30, 90 and 10 minutes → median 30. The GUARD thread has no member message, so it is not a
  // response time of zero: it is not a response time at all.
  check(
    'the median first response is measured from the member’s message, not the thread’s creation',
    charts.responseTimes?.items?.firstResponse?.value === 30,
    charts.responseTimes?.items?.firstResponse,
  );
  check(
    'in minutes',
    charts.responseTimes?.items?.firstResponse?.unit === 'minutes',
    charts.responseTimes?.items?.firstResponse?.unit,
  );
  check(
    'and the median resolution is the median of the two that were resolved',
    charts.responseTimes?.items?.resolution?.value === 1440,
    charts.responseTimes?.items?.resolution,
  );
  check(
    'a day with nothing to measure is null rather than zero',
    (charts.responseTimes?.items?.trend?.series ?? []).every(s => s.points.some(p => p.v === null)),
    (charts.responseTimes?.items?.trend?.series ?? []).map(s => s.points.map(p => p.v)),
  );
  check(
    'and the two medians come back with no previous period, because one slow afternoon moves them',
    charts.responseTimes?.items?.firstResponse?.previous === null &&
      charts.responseTimes?.items?.resolution?.changePct === null,
    charts.responseTimes?.items,
  );

  const byType = new Map(
    (charts.threadsByType?.items ?? []).map(group => [group.key, group.value]),
  );

  check(
    'every type the agent handled is counted once',
    byType.get('SUPPORT') === 1 &&
      byType.get('MANAGED') === 1 &&
      byType.get('DEAL_PROBLEM') === 1 &&
      byType.get('GUARD') === 1,
    [...byType],
  );
  check('a type nobody opened is a zero rather than a missing bar', byType.get('DISPUTE') === 0, [
    ...byType,
  ]);
  check(
    'and GUARD is in the aggregate: a disclosure is work to be staffed for, even though the ' +
      'thread itself is not readable here',
    byType.has('GUARD'),
    [...byType],
  );

  const workload = charts.workloadPerAgent?.items ?? {};
  const openFor = (workload.assignedOpen?.items ?? []).find(group => group.key === agent.id);
  const doneFor = (workload.resolvedInRange?.items ?? []).find(group => group.key === agent.id);

  check('the agent is holding the two that are still open', openFor?.value === 2, openFor);
  check('and is credited with the two they settled', doneFor?.value === 2, doneFor);
  check('named rather than left as an id', typeof openFor?.label === 'string', openFor?.label);
  check(
    'and their counts are not suppressed at two, because they are threads and not members',
    openFor?.suppressed !== true && workload.assignedOpen?.unit === 'count',
    { suppressed: openFor?.suppressed, unit: workload.assignedOpen?.unit },
  );

  res = await api(
    null,
    'GET',
    `/admin/analytics/support?assigneeIds=${agent.id}&threadTypes=GUARD&from=${shift(-14)}&to=${today()}`,
    null,
    headers,
  );

  check(
    'narrowing to GUARD leaves the one disclosure',
    (res.body?.data?.charts?.threadsByType?.items ?? []).find(g => g.key === 'GUARD')?.value === 1,
    res.body?.data?.charts?.threadsByType?.items,
  );
  check(
    'and nothing else',
    (res.body?.data?.charts?.threadsByType?.items ?? [])
      .filter(g => g.key !== 'GUARD')
      .every(g => g.value === 0),
    res.body?.data?.charts?.threadsByType?.items,
  );

  await clearAnalyticsCache();

  res = await api(
    null,
    'GET',
    `/admin/analytics/support?from=${shift(-14)}&to=${today()}`,
    null,
    headers,
  );

  check(
    'unfiltered, the open queue names whoever holds nothing as Unassigned',
    (res.body?.data?.charts?.workloadPerAgent?.items?.assignedOpen?.items ?? []).some(
      group => group.label === 'Unassigned',
    ),
    (res.body?.data?.charts?.workloadPerAgent?.items?.assignedOpen?.items ?? []).map(
      group => group.label,
    ),
  );
  check(
    'while the dispute matrix is real',
    res.body?.data?.charts?.disputesByReasonOutcome?.kind === 'matrix' &&
      res.body.data.charts.disputesByReasonOutcome.rows.length === 5 &&
      res.body.data.charts.disputesByReasonOutcome.cols.length === 4,
    {
      rows: res.body?.data?.charts?.disputesByReasonOutcome?.rows?.length,
      cols: res.body?.data?.charts?.disputesByReasonOutcome?.cols?.length,
    },
  );
  check(
    'keeping OPEN and IN_REVIEW as columns, so a recent range does not read as all settled',
    (res.body?.data?.charts?.disputesByReasonOutcome?.cols ?? []).map(col => col.key).join() ===
      'OPEN,IN_REVIEW,RESOLVED,WITHDRAWN',
    res.body?.data?.charts?.disputesByReasonOutcome?.cols?.map(col => col.key),
  );
  check(
    'and the tab still says what each filter reaches, now that they all reach something',
    (res.body?.meta?.filterSemantics?.threadTypes ?? '').includes('disputesByReasonOutcome') &&
      (res.body?.meta?.filterSemantics?.assigneeIds ?? '').includes('workloadPerAgent'),
    res.body?.meta?.filterSemantics,
  );

  res = await api(null, 'GET', '/admin/analytics/support?assigneeIds=not-a-uuid', null, headers);
  check('a malformed assignee id is refused', res.status === 400, res.body?.error);

  // §5.25 defines eleven tabs. `staff` was never one of them.
  res = await api(null, 'GET', '/admin/analytics/staff', null, headers);
  check('there is no staff tab', res.status === 400, { status: res.status, body: res.body?.error });

  // Hits before terms, scans after hits: the hit rows point at both, and `risk_term_hits` cascades
  // from the term but only nulls `content_safety_id`, so a scan deleted first leaves orphans the
  // next run would count.
  await prisma.riskTermHit.deleteMany({ where: { id: { in: hitIds } } });
  await prisma.appeal.deleteMany({ where: { id: { in: appealIds } } });
  await prisma.contentSafety.deleteMany({ where: { id: { in: scanIds } } });
  await prisma.reportCase.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.suspension.deleteMany({ where: { id: { in: suspensionIds } } });
  await prisma.moderationQueueItem.deleteMany({ where: { id: { in: queueIds } } });
  await prisma.riskTerm.deleteMany({ where: { id: { in: [riskTerm.id, otherTerm.id] } } });

  console.log('\n— Analytics: filter options —');

  /**
   * App versions come from sessions, and the demo data carries none — so the sort, the grouping
   * and the 180-day cut-off all went unexercised. Four sessions: three recent builds on two
   * platforms, and one that has not been seen for a year.
   */
  const versionUser = await makeUser('an-versions');
  const sessionIds = [];

  for (const session of [
    { version: '2.9.0', platform: 'IOS', daysAgo: 2 },
    { version: '2.10.0', platform: 'IOS', daysAgo: 1 },
    { version: '2.10.0', platform: 'ANDROID', daysAgo: 3 },
    { version: '1.0.0', platform: 'IOS', daysAgo: 400 },
  ]) {
    const row = await prisma.userSession.create({
      data: {
        userId: versionUser.id,
        deviceType: 'MOBILE',
        browserName: 'e2e',
        operatingSystem: 'e2e',
        userAgent: 'e2e',
        ipAddress: '127.0.0.1',
        deviceFingerprint: `e2e-fo-${session.version}-${session.platform}`,
        appVersion: session.version,
        platform: session.platform,
        lastActiveAt: new Date(Date.now() - session.daysAgo * 86_400_000),
      },
    });

    sessionIds.push(row.id);
  }

  await forgetCacheKeys('admin:filter-options:*');

  res = await api(null, 'GET', '/admin/analytics/filter-options', null, headers);

  /**
   * The literal route has to be declared before `analytics/:tab`, or Nest matches the parameter
   * first and `filter-options` arrives as a tab name. The symptom is a 400 that reads exactly like
   * the portal calling the wrong path.
   */
  check('filter-options is a route, not a tab name', res.status === 200, res.body?.error);

  const opts = res.body?.data ?? {};

  check(
    'it answers every list the filter bar binds',
    [
      'cityIds',
      'gender',
      'ageBands',
      'countriesOfOrigin',
      'heritage',
      'journeyStages',
      'interests',
      'languages',
      'platforms',
      'appVersions',
      'signupMethods',
      'statuses',
      'categories',
      'guideTopics',
      'professions',
      'connectionTypes',
      'storeTypes',
      'itemCategories',
      'reasonCodes',
      'riskCategories',
    ].every(key => Array.isArray(opts[key])),
    Object.keys(opts),
  );

  /**
   * The assertion that matters, and the only one that catches the failure a staff member cannot
   * diagnose: a dropdown offering a value the API rejects. They pick it, get a 400, and cannot
   * tell a refused filter from a city with nobody in it.
   */
  const refused = [];

  for (const [field, list] of Object.entries(opts)) {
    if (!Array.isArray(list) || list.length === 0) continue;

    const probe = await api(
      null,
      'GET',
      `/admin/analytics/overview?charts=kpis&${field}=${encodeURIComponent(list[0].code)}`,
      null,
      headers,
    );

    if (probe.status !== 200) refused.push([field, list[0].code, probe.status]);
  }

  check('every option it offers is one the filter accepts', refused.length === 0, refused);

  /**
   * Every city, not merely some. A flat list of 103 is what grouping exists to fix, and one city
   * with no region sits outside every group — which reads as a missing city rather than a missing
   * field. `City.region` was in the schema from the start and nothing filled it until now.
   */
  const ungrouped = (opts.cityIds ?? []).filter(option => !option.group);

  check('every city is grouped by region, so a list of 103 is navigable', ungrouped.length === 0, {
    ungrouped: ungrouped.map(option => option.code),
    regions: [...new Set((opts.cityIds ?? []).map(option => option.group))].sort(),
  });
  check(
    'and the groups are the regions staff think in',
    new Set((opts.cityIds ?? []).map(option => option.group)).size >= 10,
    [...new Set((opts.cityIds ?? []).map(option => option.group))].sort(),
  );
  check(
    'and only active ones are offered',
    opts.cityIds?.length === (await prisma.city.count({ where: { isActive: true } })),
    { offered: opts.cityIds?.length },
  );

  check(
    'iOS is spelled the way Apple spells it, not title-cased to "Ios"',
    opts.platforms?.find(option => option.code === 'IOS')?.label === 'iOS',
    opts.platforms,
  );

  // Numerically, not alphabetically: 2.10.0 is newer than 2.9.0, which string order reverses.
  const iosVersions = (opts.appVersions ?? [])
    .filter(option => option.group === 'iOS')
    .map(option => option.code);

  check('app versions are grouped by platform', iosVersions.length >= 2, opts.appVersions);
  check(
    'and sorted newest first, numerically',
    iosVersions.indexOf('2.10.0') < iosVersions.indexOf('2.9.0'),
    iosVersions,
  );
  check(
    'a build nobody has run for a year is not offered',
    !(opts.appVersions ?? []).some(option => option.code === '1.0.0'),
    opts.appVersions?.map(option => option.code),
  );

  /**
   * The §2.7 floor applies to the **list**, not to a count beside it: offering a country one
   * member gave is itself the disclosure, and selecting it reveals the number.
   */
  const offeredCountries = (opts.countriesOfOrigin ?? []).map(option => option.code);
  const countryCounts = await prisma.$queryRawUnsafe(
    `SELECT country_code AS code, COUNT(*)::int AS n FROM mv_member_dimensions
      WHERE country_code IS NOT NULL GROUP BY 1`,
  );

  check(
    'a country fewer than ten members gave is left out of the list entirely',
    countryCounts.filter(row => row.n < 10).every(row => !offeredCountries.includes(row.code)),
    countryCounts.map(row => [row.code, row.n, offeredCountries.includes(row.code)]),
  );
  check(
    'while every country at or above the floor is offered, with its real name',
    countryCounts.filter(row => row.n >= 10).every(row => offeredCountries.includes(row.code)) &&
      opts.countriesOfOrigin?.every(option => option.label !== option.code),
    opts.countriesOfOrigin,
  );

  check(
    'age band labels come from the taxonomy staff can reword',
    opts.ageBands?.find(option => option.code === 'AGE_25_34')?.label !== 'Age 25 34',
    opts.ageBands,
  );

  // `members:read` alone opens it: the filter bar is drawn on the member list too.
  const listOnly = await makeAdmin('an-list-only', 'support');

  res = await api(null, 'GET', '/admin/analytics/filter-options', null, adminHeaders(listOnly));
  check('a caller with members:read can draw the filter bar', res.status === 200, res.body?.error);

  await prisma.userSession.deleteMany({ where: { id: { in: sessionIds } } });
  await forgetCacheKeys('admin:filter-options:*');

  console.log('\n— The guard stack —');

  res = await api(null, 'GET', '/admin/analytics/overview', null, {});
  check('no token, no analytics', res.status === 401 || res.status === 404, res.status);

  res = await api(null, 'GET', '/admin/dashboard/charts?notAField=1', null, headers);
  check(
    'an unknown query field is refused by name',
    res.status === 400 && JSON.stringify(res.body).includes('notAField'),
    res.body?.error,
  );

  await sweep('admin-analytics');
  await refreshView(headers);
  await finish();
})().catch(async error => {
  console.error(error);
  process.exit(1);
});
