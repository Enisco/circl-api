/* `countryCode` on every person, everywhere.
 *
 * The app draws a flag beside every name, so a person object without the field is a hole in a UI
 * that has no fallback to fall back to. This file is deliberately structural rather than a list of
 * expected values: it walks whole responses, finds every object that looks like a person (anything
 * with a `displayName`), and asserts the key is present on all of them. A new endpoint that
 * returns a person and forgets the field fails here without anybody having to remember to add a
 * case for it.
 *
 * Present, not truthy. Null is a real answer: the member has not said where they are from, or
 * chose "Other", which has no flag. */
const { api, check, fail, finish, makeUser, prisma, sweep } = require('./harness.cjs');

/** Every person-shaped object in a response, wherever it is nested, with the path that found it. */
const peopleIn = (node, path = '$', found = []) => {
  if (Array.isArray(node)) {
    node.forEach((item, index) => peopleIn(item, `${path}[${index}]`, found));

    return found;
  }

  if (node && typeof node === 'object') {
    if (typeof node.displayName === 'string') {
      found.push({ path, has: 'countryCode' in node, value: node.countryCode, isAnonymous: node.isAnonymous });
    }

    for (const [key, value] of Object.entries(node)) peopleIn(value, `${path}.${key}`, found);
  }

  return found;
};

(async () => {
  await sweep('country-code');

  const me = await makeUser('flag-me', { countryOfOrigin: 'NG' });
  const other = await makeUser('flag-other', { countryOfOrigin: 'OTHER' });
  const nowhere = await makeUser('flag-none');

  console.log('\n── The shared author object ────────────────────────────────');

  let r = await api(me.token, 'GET', `/users/${me.id}/profile`);
  const mine = peopleIn(r.body?.data)[0];

  check('a member with a country carries its ISO code', mine?.value === 'NG', mine);

  r = await api(me.token, 'GET', `/users/${other.id}/profile`);
  check('"Other" is null, because there is no flag for it',
    peopleIn(r.body?.data)[0]?.value === null, peopleIn(r.body?.data)[0]);

  r = await api(me.token, 'GET', `/users/${nowhere.id}/profile`);
  const unset = peopleIn(r.body?.data)[0];

  check('a member who has not said is null, and the key is still there',
    unset?.has === true && unset?.value === null, unset);

  r = await api(me.token, 'GET', '/users/profile');
  check('your own profile carries it beside your own name',
    r.body?.data?.countryCode === 'NG', r.body?.data?.countryCode);

  console.log('\n── Anonymity ──────────────────────────────────────────────');

  r = await api(me.token, 'POST', '/community/requests', {
    categoryCode: 'LANGUAGE_HELP',
    title: 'An anonymous question about a difficult landlord situation',
    description: 'Posting this without my name attached because my landlord is in the same group.',
    cityId: 'MANCHESTER',
    visibility: 'ANONYMOUS',
  });
  const anonymous = peopleIn(r.body?.data)[0];

  check('an anonymous author has the key', anonymous?.has === true, anonymous);
  check('and it is null, because a rare nationality in one city is not anonymous',
    anonymous?.isAnonymous === true && anonymous?.value === null, anonymous);

  console.log('\n── Every endpoint that returns a person ────────────────────');

  // Enough data of their own that the personal endpoints are not empty.
  const ids = {};

  for (const [key, path] of [
    ['request', '/community/requests?limit=2'],
    ['guide', '/community/guides?limit=2'],
    ['store', '/commerce/stores?limit=2'],
    ['pro', '/professionals?limit=2'],
    ['group', '/community/groups?limit=2'],
  ]) {
    ids[key] = (await api(me.token, 'GET', path)).body?.data?.[0]?.id;
  }

  const endpoints = [
    '/community/feed?limit=5',
    '/community/requests?limit=3',
    '/community/offers?limit=3',
    '/community/guides?limit=3',
    '/community/updates?limit=3',
    '/professionals?limit=3',
    '/search?q=gp',
    `/users?q=${encodeURIComponent('E2E')}`,
    `/community/requests/${ids.request}`,
    `/community/guides/${ids.guide}`,
    `/commerce/stores/${ids.store}`,
    `/professionals/${ids.pro}`,
    `/community/groups/${ids.group}`,
    `/users/${me.id}/profile`,
    `/reviews/${me.id}`,
  ];

  let seen = 0;
  const holes = [];

  for (const path of endpoints) {
    const response = await api(me.token, 'GET', path);

    if (response.status !== 200) {
      check(`${path} answered`, false, response.status);
      continue;
    }

    const found = peopleIn(response.body?.data);

    seen += found.length;
    holes.push(...found.filter(person => !person.has).map(person => `${path} ${person.path}`));
  }

  check(`every person across ${endpoints.length} endpoints carries countryCode (${seen} people)`,
    holes.length === 0, holes.slice(0, 5));
  check('and the walk actually found people, rather than passing on an empty response',
    seen >= 10, seen);

  await sweep('country-code');
  await finish();
})().catch(fail);
