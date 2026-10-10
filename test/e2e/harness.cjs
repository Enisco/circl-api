/* Shared helpers for the end-to-end scripts.
 *
 * The sweep matters: a script that crashes mid-run leaves its users behind, and
 * the next run then sees their data and fails an assertion that has nothing wrong
 * with it. Sweeping on the way IN rather than only on the way out makes each run
 * independent of how the last one ended. */
require('dotenv').config({ path: './.env' });
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

// Overridable so a sweep can run against a second instance while the usual one keeps port 4000.
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4000/api/v1';
const E2E_PREFIX = 'e2e-';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const state = { pass: 0, fail: 0 };

const check = (name, ok, detail) => {
  if (ok) {
    state.pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    state.fail += 1;
    console.log(
      `  ✗ ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`,
    );
  }
};

async function api(token, method, path, body, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  return { status: res.status, body: json };
}

async function makeUser(tag, profile = {}) {
  const role = await prisma.role.findUnique({ where: { code: 'user' } });
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const user = await prisma.user.create({
    data: {
      firstName: 'E2E',
      lastName: tag,
      email: `${E2E_PREFIX}${tag}-${stamp}@example.test`,
      username: `e2e_${tag}_${stamp}`,
      status: 'ACTIVE',
      userRole: { create: { roleId: role.id } },
      profile: { create: { cityId: 'MANCHESTER', ...profile } },
      trustChecks: { create: { check: 'EMAIL', status: 'VERIFIED', verifiedAt: new Date() } },
      sessions: {
        create: {
          userAgent: 'e2e',
          deviceType: 'cli',
          browserName: 'cli',
          operatingSystem: 'cli',
          ipAddress: '127.0.0.1',
          isActive: true,
          deviceFingerprint: `e2e-${tag}-${stamp}`,
        },
      },
    },
    include: { sessions: true },
  });

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    // The same claims the app mints. `type` and the audience are both checked now: without them a
    // refresh token or an admin token would be accepted as an access token, which is what the
    // member strategy used to do (B12).
    token: jwt.sign(
      { sub: user.id, sid: user.sessions[0].id, type: 'access' },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: '1h', audience: 'circl-app' },
    ),
  };
}

/** Removes every user any e2e script has ever created, and everything hanging off them. */
async function sweep(label = 'sweep') {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: E2E_PREFIX } },
    select: { id: true },
  });

  const ids = users.map(user => user.id);

  if (ids.length) {
    await prisma.moderationQueueItem.deleteMany({ where: { subjectUserId: { in: ids } } });
    await prisma.report.deleteMany({
      where: { OR: [{ reporterId: { in: ids } }, { targetUserId: { in: ids } }] },
    });
    await prisma.activityEvent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: ids } } });
    await prisma.conversation.deleteMany({
      where: { participants: { some: { userId: { in: ids } } } },
    });
    await prisma.group.deleteMany({ where: { createdById: { in: ids } } });
    // Internal notes hold a subject type and an id rather than a foreign key — deliberately, so a
    // note survives the member being anonymised — so nothing cascades them away either.
    await prisma.internalNote.deleteMany({
      where: { OR: [{ subjectId: { in: ids } }, { authorId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  // Admin invites carry no foreign key to the user — deliberately, so an invite survives the
  // account it refers to — which means nothing cascades them away.
  await prisma.adminInvite.deleteMany({ where: { email: { startsWith: E2E_PREFIX } } });

  // Risk terms, for the same reason and with a sharper edge: the lexicon is *reference* data, so a
  // phrase a suite added and never removed sits beside the real crisis vocabulary and is scanned
  // against every message. One had been there for hours reading as though somebody had seeded it.
  await prisma.riskTerm.deleteMany({ where: { pattern: { startsWith: 'e2e' } } });

  // Runs whether or not this sweep found users of its own, because a suite that deletes its own
  // members first leaves the orphans behind for somebody else to find. `guides.authorId` is
  // SetNull, since a Circl-drafted guide legitimately has no author, so a guide OUTLIVES the
  // member who wrote it. Right in production, where deletion anonymises and the row survives;
  // here it left every boundary-test guide sitting in the Guides tab forever.
  const orphaned = await prisma.guide.deleteMany({
    where: { authorId: null, isAutoGenerated: false },
  });

  // Same shape of leftover: deleting a user cascades their participant row away but leaves the
  // conversation, so a thread with nobody in it survives every sweep and accumulates.
  const emptyThreads = await prisma.conversation.deleteMany({
    where: { participants: { none: {} } },
  });

  // And again in the moderation queue, which holds ids rather than relations: sweeping the report
  // or the guide leaves the row behind. Ninety-two of them had built up, and since the queue pages
  // at fifty, a suite looking for the item it had just filed stopped finding it.
  const [reported, autoGuides] = await Promise.all([
    prisma.moderationQueueItem.findMany({
      where: { reportId: { not: null } },
      select: { id: true, reportId: true },
    }),
    prisma.moderationQueueItem.findMany({
      where: { targetType: 'GUIDE' },
      select: { id: true, targetId: true },
    }),
  ]);
  const [liveReports, liveGuides] = await Promise.all([
    prisma.report.findMany({
      where: { id: { in: reported.map(item => item.reportId) } },
      select: { id: true },
    }),
    prisma.guide.findMany({
      where: { id: { in: autoGuides.map(item => item.targetId) } },
      select: { id: true },
    }),
  ]);
  const liveReportIds = new Set(liveReports.map(row => row.id));
  const liveGuideIds = new Set(liveGuides.map(row => row.id));
  const staleQueue = await prisma.moderationQueueItem.deleteMany({
    where: {
      id: {
        in: [
          ...reported.filter(item => !liveReportIds.has(item.reportId)).map(item => item.id),
          ...autoGuides.filter(item => !liveGuideIds.has(item.targetId)).map(item => item.id),
        ],
      },
    },
  });

  if (!ids.length && !orphaned.count && !emptyThreads.count && !staleQueue.count) return 0;

  console.log(
    `  ${label}: removed ${ids.length} test users, their content` +
      `${orphaned.count ? ` and ${orphaned.count} authorless guides` : ''}` +
      `${emptyThreads.count ? ` and ${emptyThreads.count} empty threads` : ''}` +
      `${staleQueue.count ? ` and ${staleQueue.count} stale queue items` : ''}`,
  );

  return ids.length;
}

async function finish() {
  console.log(`\n═══ ${state.pass} passed, ${state.fail} failed ═══\n`);
  await prisma.$disconnect();
  await pool.end();
  process.exit(state.fail ? 1 : 0);
}

const fail = async error => {
  console.error(error);
  await prisma.$disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
};

const dobFor = years => {
  const date = new Date();

  date.setUTCFullYear(date.getUTCFullYear() - years);

  return date.toISOString().slice(0, 10);
};

/**
 * The seeded members sign in with an email code and no password (B.6). The route is throttled at
 * ten a minute keyed on the IP, and a whole sweep shares one IP, so a suite late in the run can be
 * refused for something no member would ever hit. Waits out the window the API itself names.
 */
async function verifyEmailCode(email, code = '1111', attempt = 0) {
  const res = await fetch(`${BASE}/auth/verify/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 429 && attempt < 2) {
    const wait = (body?.data?.retryAfterSeconds ?? 30) + 1;

    console.log(`  … throttled signing in as ${email}, waiting ${wait}s`);
    await new Promise(resolve => setTimeout(resolve, wait * 1000));

    return verifyEmailCode(email, code, attempt + 1);
  }

  const cookies = res.headers.getSetCookie?.() ?? [];

  return {
    status: res.status,
    ok: res.status === 200 || res.status === 201,
    body: body?.data ?? {},
    cookieToken:
      cookies
        .find(c => c.startsWith('accessToken='))
        ?.split(';')[0]
        .split('=')[1] ?? null,
  };
}

/** A real PNG of the given size, so a header read on S3 has genuine bytes to find. */
function realPng(width, height) {
  const zlib = require('zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);

    len.writeUInt32BE(data.length);

    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    let c = ~0;

    for (const byte of body) {
      c ^= byte;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }

    crc.writeUInt32BE(~c >>> 0);

    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);

  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(height * (1 + width * 3)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Mints an upload slot, PUTs the bytes, and hands back the key an attach expects. */
async function uploadPng(token, purpose, width, height) {
  const bytes = realPng(width, height);
  const minted = await api(token, 'POST', '/media/uploads', {
    purpose,
    files: [{ mimeType: 'image/png', byteSize: bytes.length }],
  });
  const slot = minted.body?.data?.[0];

  if (!slot) return null;

  await fetch(slot.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: bytes,
  });

  return slot.key;
}

/**
 * A clip, for the paths that only exist for video. Deliberately a stub with no readable `moov`:
 * nothing here plays it, and a server that cannot read a length has to say so rather than let it
 * through, which is itself worth asserting.
 */
async function uploadStubVideo(token, purpose) {
  const bytes = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypmp42'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('mp42isom'),
    Buffer.alloc(512),
  ]);
  const minted = await api(token, 'POST', '/media/uploads', {
    purpose,
    files: [{ mimeType: 'video/mp4', byteSize: bytes.length }],
  });
  const slot = minted.body?.data?.[0];

  if (!slot) return null;

  await fetch(slot.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: bytes,
  });

  return slot.key;
}

/**
 * A staff account with a real admin session and a real admin access token.
 *
 * Member authentication now refuses `isStaff` rows, so the old trick — mint a member token for a
 * staff user — stops working, and it should: that was the hole (B1). This signs a genuine admin
 * token with the admin secret and the admin claims, so the suites exercise the real guard stack
 * and the real strategy. There is no test-only bypass in application code.
 */
async function makeAdmin(tag, roleCode = 'super_admin') {
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const user = await prisma.user.create({
    data: {
      firstName: 'E2E',
      lastName: tag,
      email: `${E2E_PREFIX}${tag}-${stamp}@example.test`,
      username: `e2e_${tag}_${stamp}`,
      status: 'ACTIVE',
      isStaff: true,
      userRole: { create: { roleId: role.id } },
      adminCredential: {
        create: {
          // Not a usable password: these suites do not sign in through the password step, and a
          // hash that verifies against a known string would be a credential sitting in a test file.
          passwordHash: '$argon2id$v=19$m=19456,p=1,t=2$dGVzdC1vbmx5LW5vdC1hLWhhc2g$' + 'x'.repeat(43),
          passwordUpdatedAt: new Date(),
          totpEnabledAt: new Date(),
        },
      },
    },
  });

  const session = await prisma.adminSession.create({
    data: {
      userId: user.id,
      ip: '127.0.0.1',
      userAgent: 'e2e',
      absoluteExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    },
  });

  const token = jwt.sign(
    { sub: user.id, sid: session.id, typ: 'admin_access', role: roleCode },
    process.env.ADMIN_JWT_ACCESS_SECRET,
    { expiresIn: '1h', issuer: 'circl-api', audience: 'circl-admin', algorithm: 'HS256' },
  );

  return { id: user.id, email: user.email, sessionId: session.id, token, role: roleCode };
}

/**
 * Clears the throttler's tally.
 *
 * The admin limits are deliberately tight — five sign-ins in fifteen minutes — so a suite that
 * exercises the sign-in flow several times trips them, which is the limit working. The suite
 * asserts that it works once, on purpose, and then clears the counter rather than pretending the
 * limit is looser than it is.
 */
async function clearRateLimits() {
  const Redis = require('ioredis');
  const redis = new Redis(process.env.REDIS_URL);

  try {
    // Both keys. Exceeding a limit sets a separate `:blocked` key holding the block duration, so
    // clearing only `:hits` leaves the refusal in place and the next call still gets a 429 —
    // which is exactly how this helper quietly did nothing the first time.
    const keys = [...(await redis.keys('{*}:hits')), ...(await redis.keys('{*}:blocked'))];

    if (keys.length) await redis.del(...keys);
  } finally {
    await redis.quit();
  }
}

/** Drops a Redis key, for suites that need to simulate a short TTL having passed. */
async function forgetCacheKeys(pattern) {
  const Redis = require('ioredis');
  const redis = new Redis(process.env.REDIS_URL);

  try {
    const keys = await redis.keys(pattern);

    if (keys.length) await redis.del(...keys);

    return keys.length;
  } finally {
    await redis.quit();
  }
}

/** The headers an admin request needs: the bearer token, and the trusted-client credential. */
const adminHeaders = admin => ({
  Authorization: `Bearer ${admin.token}`,
  ...(process.env.ADMIN_BFF_SECRET ? { 'X-Circl-Admin-Client': process.env.ADMIN_BFF_SECRET } : {}),
});

module.exports = {
  adminHeaders,
  api,
  clearRateLimits,
  forgetCacheKeys,
  check,
  dobFor,
  fail,
  finish,
  makeAdmin,
  makeUser,
  prisma,
  realPng,
  sweep,
  uploadPng,
  uploadStubVideo,
  verifyEmailCode,
};
