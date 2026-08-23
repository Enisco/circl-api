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

const BASE = 'http://localhost:4000/api/v1';
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
    console.log(`  ✗ ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
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
          userAgent: 'e2e', deviceType: 'cli', browserName: 'cli', operatingSystem: 'cli',
          ipAddress: '127.0.0.1', isActive: true, deviceFingerprint: `e2e-${tag}-${stamp}`,
        },
      },
    },
    include: { sessions: true },
  });

  return {
    id: user.id,
    token: jwt.sign(
      { sub: user.id, sid: user.sessions[0].id },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: '1h' },
    ),
  };
}

/** Removes every user any e2e script has ever created, and everything hanging off them. */
async function sweep(label = 'sweep') {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: E2E_PREFIX } },
    select: { id: true },
  });

  if (!users.length) return 0;

  const ids = users.map(user => user.id);

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
  await prisma.user.deleteMany({ where: { id: { in: ids } } });

  console.log(`  ${label}: removed ${ids.length} test users and their content`);

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

module.exports = { api, check, dobFor, fail, finish, makeUser, prisma, sweep };
