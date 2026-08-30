/* The docs the app team reads.
 *
 * Swagger is generated, which means it degrades silently: a new controller without
 * @ApiBearerAuth is a route nobody can try from the UI, and a handler with no @ApiOperation is a
 * row with a path and nothing else. Neither breaks a test anywhere else. */
const { check, finish } = require('./harness.cjs');

const DOCS = 'http://localhost:4000/docs-json';

/** The endpoints the app team was told to look at, so these must read well specifically. */
const GAP_ENDPOINTS = [
  ['get', '/api/v1/users/me/sessions'],
  ['delete', '/api/v1/users/me/sessions'],
  ['get', '/api/v1/users/me/privacy'],
  ['patch', '/api/v1/users/me/privacy'],
  ['post', '/api/v1/users/me/data-export'],
  ['get', '/api/v1/users/me/data-export'],
  ['post', '/api/v1/users/me/email/change'],
  ['post', '/api/v1/users/me/email/change/confirm'],
  ['get', '/api/v1/professionals/listings/{listingId}/slots'],
  ['get', '/api/v1/search'],
  ['get', '/api/v1/verification/status'],
  ['get', '/api/v1/taxonomy'],
  ['delete', '/api/v1/users/notification-preferences/device-token'],
];

(async () => {
  const res = await fetch(DOCS);
  check('the OpenAPI document is served', res.status === 200, res.status);

  const doc = await res.json();
  const ops = [];

  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (['get', 'post', 'patch', 'put', 'delete'].includes(method)) ops.push({ path, method, op });
    }
  }

  console.log('\n── Every operation is described ─────────────────────────────');
  check(`${ops.length} operations are published`, ops.length > 190, ops.length);
  check('every one has a summary', ops.every(o => o.op.summary),
    ops.filter(o => !o.op.summary).map(o => `${o.method} ${o.path}`));
  check('every one has a description', ops.every(o => o.op.description),
    ops.filter(o => !o.op.description).map(o => `${o.method} ${o.path}`));
  check('every one is tagged', ops.every(o => (o.op.tags ?? []).length > 0),
    ops.filter(o => !(o.op.tags ?? []).length).map(o => `${o.method} ${o.path}`));

  console.log('\n── Auth is marked, so the Authorize button works ────────────');
  const open = ops.filter(o => !o.op.security).map(o => `${o.method.toUpperCase()} ${o.path}`);
  check('only the public routes are unauthenticated',
    open.every(route => /auth\/(register|verify)|\/taxonomy$/.test(route)), open);
  check('everything else requires a bearer token', ops.filter(o => o.op.security).length > 190,
    ops.filter(o => o.op.security).length);

  console.log('\n── The envelope is documented, not left to be discovered ────');
  check('the success envelope is a named schema', !!doc.components.schemas.SuccessEnvelope);
  check('so is the error envelope', !!doc.components.schemas.ErrorEnvelope);
  check('and the page meta list responses carry', !!doc.components.schemas.PageMeta);
  check('every operation documents a response body',
    ops.every(o => Object.entries(o.op.responses ?? {})
      .every(([status, r]) => status === '204' || !!r.content)),
    ops.filter(o => Object.entries(o.op.responses ?? {})
      .some(([status, r]) => status !== '204' && !r.content)).map(o => `${o.method} ${o.path}`));
  check('and the validation failure it can return',
    ops.every(o => o.op.responses?.['400']),
    ops.filter(o => !o.op.responses?.['400']).map(o => `${o.method} ${o.path}`));
  check('authenticated routes document the 401 too',
    ops.filter(o => o.op.security).every(o => o.op.responses?.['401']),
    ops.filter(o => o.op.security && !o.op.responses?.['401']).map(o => `${o.method} ${o.path}`));

  console.log('\n── The two things a route list cannot tell you ─────────────');
  const intro = doc.info.description ?? '';
  check('the description explains the response envelope', intro.includes('"data"') || intro.includes('`data`'), intro.length);
  check('and warns that auth tokens sit inside it', /accessToken/.test(intro) && /data/.test(intro));
  check('and carries the WebSocket contract OpenAPI cannot describe',
    intro.includes('/ws/chat') && intro.includes('message.ack') && intro.includes('sync'), intro.length);
  check('naming the 4401 close code', intro.includes('4401'));

  console.log('\n── The endpoints the gaps document points at ────────────────');
  for (const [method, path] of GAP_ENDPOINTS) {
    const op = doc.paths[path]?.[method];

    check(`${method.toUpperCase()} ${path} is documented`,
      !!op && !!op.summary && !!op.description, op ? 'thin' : 'missing');
  }

  const typed = ['/api/v1/users/me/sessions', '/api/v1/users/me/privacy', '/api/v1/search',
    '/api/v1/professionals/listings/{listingId}/slots'];
  check('and the new ones describe their payload, not just the wrapper',
    typed.every(path => {
      const schema = JSON.stringify(doc.paths[path]?.get?.responses?.['200'] ?? {});

      return schema.includes('allOf') && schema.includes('Dto');
    }), typed.filter(path => !JSON.stringify(doc.paths[path]?.get?.responses?.['200'] ?? {}).includes('allOf')));

  await finish();
})();
