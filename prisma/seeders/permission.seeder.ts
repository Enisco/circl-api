import { PrismaClient } from '@prisma/client';

interface Permission {
  name: string;
  code: string;
  group: string;
}

/**
 * Every permission, exactly as the admin portal spec names them (§4.13).
 *
 * `manage:all` is deliberately **absent**. It used to short-circuit every check in
 * `PermissionGuard`, so any role holding it bypassed authorisation entirely — one role assignment
 * away from a staff account that could do anything. The spec says the admin guard should ignore
 * it; removing the row instead means no guard anywhere can honour what does not exist.
 */
const permissions: Permission[] = [
  // ── Analytics ───────────────────────────────────────────────────────────────
  { name: 'Read analytics', code: 'analytics:read', group: 'analytics' },
  { name: 'Read safety analytics', code: 'analytics:safety', group: 'analytics' },

  // ── Members ─────────────────────────────────────────────────────────────────
  { name: 'Read members', code: 'members:read', group: 'members' },
  { name: 'Edit member profiles', code: 'members:edit', group: 'members' },
  { name: 'Manage member sessions', code: 'members:sessions', group: 'members' },
  { name: 'Suspend and warn members', code: 'members:suspend', group: 'members' },
  { name: 'Delete a member', code: 'members:delete', group: 'members' },
  { name: 'Trigger a member data export', code: 'members:data_export', group: 'members' },
  // Separate from `members:read` because reading a masked profile and reading somebody's phone
  // number are different acts, and only the second needs a reason recorded against it.
  { name: 'Reveal member contact details', code: 'members:pii_reveal', group: 'members' },
  { name: 'Read member messages', code: 'messages:read', group: 'members' },

  // ── Content ─────────────────────────────────────────────────────────────────
  { name: 'Read content', code: 'content:read', group: 'content' },
  { name: 'Moderate content', code: 'content:moderate', group: 'content' },
  { name: 'Publish guides', code: 'guides:publish', group: 'content' },

  // ── Trust and safety ────────────────────────────────────────────────────────
  { name: 'Read the moderation queue', code: 'moderation:read', group: 'safety' },
  { name: 'Decide moderation items', code: 'moderation:decide', group: 'safety' },
  { name: 'Assign moderation work', code: 'moderation:assign', group: 'safety' },
  { name: 'Read reports', code: 'reports:read', group: 'safety' },
  { name: 'Escalate and appeal', code: 'reports:escalate', group: 'safety' },
  // Guard is separate from ordinary moderation on purpose: a member in danger is a different job
  // from a spam report, and not everybody who triages spam should read a safeguarding disclosure.
  { name: 'Read Guard cases', code: 'guard:read', group: 'safety' },
  { name: 'Work Guard cases', code: 'guard:manage', group: 'safety' },
  { name: 'Manage risk terms', code: 'risk_terms:manage', group: 'safety' },

  // ── Support ─────────────────────────────────────────────────────────────────
  { name: 'Read the support inbox', code: 'support:read', group: 'support' },
  { name: 'Work the support inbox', code: 'support:manage', group: 'support' },
  { name: 'Act on managed requests', code: 'managed:manage', group: 'support' },
  { name: 'Act on disputes', code: 'disputes:manage', group: 'support' },

  // ── Communications ──────────────────────────────────────────────────────────
  { name: 'Manage announcements', code: 'communications:manage', group: 'comms' },

  // ── Configuration ───────────────────────────────────────────────────────────
  { name: 'Read configuration', code: 'config:read', group: 'config' },
  { name: 'Manage taxonomy and places', code: 'config:taxonomy', group: 'config' },
  { name: 'Manage platform limits', code: 'config:system', group: 'config' },
  { name: 'Run a scheduled job now', code: 'jobs:run', group: 'config' },

  // ── Team ────────────────────────────────────────────────────────────────────
  { name: 'Read the team', code: 'team:read', group: 'team' },
  { name: 'Manage the team', code: 'team:manage', group: 'team' },

  // ── Audit ───────────────────────────────────────────────────────────────────
  // Three scopes rather than one flag: an auditor sees everything, trust & safety see their own
  // area so they can check each other's enforcement, and everybody can see what they did.
  { name: 'Read the whole audit trail', code: 'audit:read', group: 'audit' },
  { name: 'Read my area of the audit trail', code: 'audit:read_area', group: 'audit' },
  { name: 'Read my own audit entries', code: 'audit:read_self', group: 'audit' },

  // ── Exports ─────────────────────────────────────────────────────────────────
  { name: 'Export CSV', code: 'exports:csv', group: 'exports' },
  { name: 'Read everybody\'s exports', code: 'exports:read_all', group: 'exports' },
];

/**
 * The codes the list above replaces.
 *
 * `manage:all` is the one that matters: it short-circuited every check, so any role holding it
 * bypassed authorisation entirely. The other three are renamings — `users:read` became
 * `members:read`, and so on.
 */
const RETIRED_CODES = ['manage:all', 'users:read', 'users:manage', 'taxonomy:manage'];

export const seedPermissions = async (prisma: PrismaClient) => {
  console.info('Seeding permissions...');

  // Retired first, then the new set. `Permission.name` is unique and the retired rows hold display
  // names the replacements need — "Read members" was `users:read` and is now `members:read` — so
  // upserting first collides on a column nobody would think to look at.
  const retired = await prisma.permission.findMany({
    where: { code: { in: RETIRED_CODES } },
    select: { id: true, code: true },
  });

  if (retired.length) {
    await prisma.rolePermission.deleteMany({
      where: { permissionId: { in: retired.map(row => row.id) } },
    });
    await prisma.permission.deleteMany({ where: { id: { in: retired.map(row => row.id) } } });
    console.info(`  🧹 Retired ${retired.map(row => row.code).join(', ')}`);
  }

  for (const permission of permissions) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { name: permission.name, group: permission.group },
      create: permission,
    });
  }

  console.info(`  ✅ Seeded ${permissions.length} permissions`);
};
