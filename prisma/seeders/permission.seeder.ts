import { PrismaClient } from '@prisma/client';

interface Permission {
  name: string;
  code: string;
  group: string;
}

const permissions: Permission[] = [
  // Special. `manage:all` short-circuits every check in PermissionGuard.
  { name: 'Manage all', code: 'manage:all', group: 'special' },

  // ── Moderation ────────────────────────────────────────────────────────────
  // The queue a human works through: reported content, and every anonymous post,
  // which is moderated whether or not it was reported.
  { name: 'Read moderation queue', code: 'moderation:read', group: 'moderation' },
  { name: 'Decide moderation items', code: 'moderation:decide', group: 'moderation' },

  // ── Circl Guard ───────────────────────────────────────────────────────────
  // Separate from ordinary moderation on purpose: a member in danger is a
  // different job from a spam report, and not everyone who triages spam should
  // be reading a domestic-abuse disclosure.
  { name: 'Read the Guard queue', code: 'guard:read', group: 'guard' },
  { name: 'Work Guard cases', code: 'guard:manage', group: 'guard' },

  // ── Taxonomy ──────────────────────────────────────────────────────────────
  // What makes "reword a label without an app release" real.
  { name: 'Manage taxonomy', code: 'taxonomy:manage', group: 'taxonomy' },

  // ── Members ───────────────────────────────────────────────────────────────
  { name: 'Read members', code: 'users:read', group: 'users' },
  { name: 'Suspend or restore members', code: 'users:manage', group: 'users' },

  // ── Content ───────────────────────────────────────────────────────────────
  { name: 'Publish auto-drafted guides', code: 'guides:publish', group: 'content' },

  // ── Managed work ──────────────────────────────────────────────────────────
  { name: 'Work managed requests and disputes', code: 'managed:manage', group: 'managed' },
];

export const seedPermissions = async (prisma: PrismaClient) => {
  console.warn('Seeding permissions...');

  await prisma.$transaction(
    async tx => {
      for (const permission of permissions) {
        await tx.permission.upsert({
          where: { code: permission.code },
          update: permission,
          create: permission,
        });
      }
    },
    { timeout: 30000, maxWait: 35000 },
  );

  console.warn(`  ✅ Seeded ${permissions.length} permissions`);
};
