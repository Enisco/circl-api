import { PrismaClient } from '@prisma/client';

interface Permission {
  name: string;
  code: string;
  group: string;
}

const permissions: Permission[] = [
  // Special
  { name: 'Manage all', code: 'manage:all', group: 'special' },

  // Add more as required
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
