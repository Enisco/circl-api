import { PrismaClient } from '@prisma/client';

interface RoleData {
  name: string;
  code: string;
  description: string;
  isSystem: boolean;
  isAdmin: boolean;
  permissions: string[];
}

/**
 * The four staff roles, exactly as the admin spec defines them (§4.13), plus the member role.
 *
 * `super_admin` is granted every code explicitly rather than a wildcard. It is more lines, and it
 * is the point: a new permission is not silently granted to anybody by existing, so adding one is
 * a decision about who gets it rather than a decision that was already made.
 */
const ALL_ADMIN_PERMISSIONS = [
  'analytics:read',
  'analytics:safety',
  'members:read',
  'members:edit',
  'members:sessions',
  'members:suspend',
  'members:delete',
  'members:data_export',
  'members:pii_reveal',
  'messages:read',
  'content:read',
  'content:moderate',
  'guides:publish',
  'moderation:read',
  'moderation:decide',
  'moderation:assign',
  'reports:read',
  'reports:escalate',
  'guard:read',
  'guard:manage',
  'risk_terms:manage',
  'professions:gate',
  'support:read',
  'support:manage',
  'managed:manage',
  'disputes:manage',
  'communications:manage',
  'config:read',
  'config:taxonomy',
  'config:system',
  'jobs:run',
  'team:read',
  'team:manage',
  'audit:read',
  'audit:read_area',
  'audit:read_self',
  'exports:csv',
  'exports:read_all',
];

const defaultRoles: RoleData[] = [
  {
    name: 'Super Admin',
    code: 'super_admin',
    description: 'Everything, including platform configuration and the team',
    isSystem: true,
    isAdmin: true,
    permissions: ALL_ADMIN_PERMISSIONS,
  },
  {
    name: 'Manager',
    code: 'manager',
    description: 'Everything except platform limits, scheduled jobs and the full audit trail',
    isSystem: true,
    isAdmin: true,
    permissions: ALL_ADMIN_PERMISSIONS.filter(
      code => !['config:system', 'jobs:run'].includes(code),
    ),
  },
  {
    name: 'Trust & Safety',
    code: 'trust_safety',
    description: 'Moderation, reports, Guard cases, risk terms and enforcement',
    isSystem: true,
    isAdmin: true,
    permissions: [
      'analytics:safety',
      'members:read',
      'members:sessions',
      'members:suspend',
      'messages:read',
      'content:read',
      'content:moderate',
      'guides:publish',
      'moderation:read',
      'moderation:decide',
      'reports:read',
      'guard:read',
      'guard:manage',
      'risk_terms:manage',
      // §2.9: T&S decides which professions are gated. The same judgement as the risk lexicon, and
      // the reason this is its own permission rather than `config:taxonomy` — which they do not
      // hold, and which would have come with every other vocabulary attached.
      'professions:gate',
      // Read-only on managed work, so an escalation can be understood without being acted on.
      'support:read',
      'disputes:manage',
      'audit:read_area',
      'audit:read_self',
    ],
  },
  {
    name: 'Support',
    code: 'support',
    description: 'The support inbox, managed requests, disputes and member help',
    isSystem: true,
    isAdmin: true,
    permissions: [
      'members:read',
      'members:edit',
      'members:sessions',
      'members:data_export',
      'members:pii_reveal',
      'messages:read',
      'content:read',
      'reports:read',
      // Support cannot suspend. Where a case needs enforcement they escalate to trust & safety,
      // which is a decision with a different trail behind it.
      'reports:escalate',
      'support:read',
      'support:manage',
      'managed:manage',
      'disputes:manage',
      'audit:read_self',
    ],
  },
  {
    name: 'User',
    code: 'user',
    description: 'A member of Circl',
    isSystem: true,
    isAdmin: false,
    permissions: [],
  },
];

/** The roles the four above replace, and who each becomes. */
const MIGRATIONS: Record<string, string> = {
  moderator: 'trust_safety',
  safeguarding: 'trust_safety',
};

export const seedRoles = async (prisma: PrismaClient) => {
  console.info('Seeding roles...');

  const allNeeded = Array.from(new Set(defaultRoles.flatMap(role => role.permissions)));
  const found = await prisma.permission.findMany({ where: { code: { in: allNeeded } } });
  const idByCode = new Map(found.map(permission => [permission.code, permission.id]));

  for (const code of allNeeded) {
    if (!idByCode.has(code)) {
      throw new Error(`Permission "${code}" is referenced by a role but was never seeded.`);
    }
  }

  await prisma.$transaction(
    async tx => {
      for (const { permissions: codes, ...roleInfo } of defaultRoles) {
        const role = await tx.role.upsert({
          where: { code: roleInfo.code },
          update: roleInfo,
          create: roleInfo,
        });

        await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
        await tx.rolePermission.createMany({
          data: codes.map(code => ({ roleId: role.id, permissionId: idByCode.get(code)! })),
        });
      }

      // Move anybody on a retired role before deleting it, or they would be left pointing at
      // nothing — and a staff account with no role cannot sign in to put itself right.
      for (const [from, to] of Object.entries(MIGRATIONS)) {
        const [oldRole, newRole] = await Promise.all([
          tx.role.findUnique({ where: { code: from }, select: { id: true } }),
          tx.role.findUniqueOrThrow({ where: { code: to }, select: { id: true } }),
        ]);

        if (!oldRole) continue;

        const moved = await tx.userRole.updateMany({
          where: { roleId: oldRole.id },
          data: { roleId: newRole.id },
        });

        if (moved.count) console.info(`  ↪ Moved ${moved.count} staff from ${from} to ${to}`);

        await tx.adminInvite.updateMany({
          where: { roleId: oldRole.id, acceptedAt: null, revokedAt: null },
          data: { roleId: newRole.id },
        });
        await tx.rolePermission.deleteMany({ where: { roleId: oldRole.id } });
        await tx.role.delete({ where: { id: oldRole.id } });
      }
    },
    { timeout: 30000, maxWait: 35000 },
  );

  console.info(`  ✅ Seeded ${defaultRoles.length} roles`);
};
