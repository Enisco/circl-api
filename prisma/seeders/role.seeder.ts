import { PrismaClient } from '@prisma/client';

interface RoleData {
  name: string;
  code: string;
  description: string;
  isSystem: boolean;
  isAdmin: boolean;
  permissions: string[];
}

const defaultRoles: RoleData[] = [
  {
    name: 'Super Admin',
    code: 'super_admin',
    description: 'Has full access to all system features and data',
    isSystem: true,
    isAdmin: true,
    permissions: ['manage:all'],
  },
  {
    name: 'Moderator',
    code: 'moderator',
    description: 'Works the moderation queue: reported content and anonymous posts',
    isSystem: true,
    isAdmin: true,
    permissions: ['moderation:read', 'moderation:decide', 'users:read', 'guides:publish'],
  },
  {
    // Deliberately separate from Moderator. Reading a domestic-abuse disclosure
    // is a different job from triaging spam, and not everyone who does the second
    // should be able to do the first.
    name: 'Safeguarding',
    code: 'safeguarding',
    description: 'Works Circl Guard cases: the private admin channel and the risk queue',
    isSystem: true,
    isAdmin: true,
    permissions: ['guard:read', 'guard:manage', 'users:read', 'moderation:read'],
  },
  {
    name: 'Support',
    code: 'support',
    description: 'Works managed requests and disputes',
    isSystem: true,
    isAdmin: true,
    permissions: ['managed:manage', 'users:read'],
  },
  {
    name: 'User',
    code: 'user',
    description: 'Basic user role',
    isSystem: true,
    isAdmin: false,
    permissions: [],
  },
];

export const seedRoles = async (prisma: PrismaClient) => {
  console.info('Seeding roles...');

  try {
    // Step 1: Gather all required permission codes from all roles
    const allNeededPermissionCodes = Array.from(
      new Set(defaultRoles.flatMap(role => role.permissions)),
    );

    // Step 2: Fetch all permissions at once
    const allPermissions = await prisma.permission.findMany({
      where: { code: { in: allNeededPermissionCodes } },
    });

    // Step 3: Validate that we have all required permissions
    const foundCodes = new Set(allPermissions.map(p => p.code));

    for (const role of defaultRoles) {
      for (const neededCode of role.permissions) {
        if (!foundCodes.has(neededCode)) {
          throw new Error(`Permission "${neededCode}" not found for role "${role.code}".`);
        }
      }
    }

    // Step 4: Create a map from code to permission ID for quick lookup
    const permissionIdByCode: Record<string, string> = {};

    for (const perm of allPermissions) {
      permissionIdByCode[perm.code] = perm.id;
    }

    // Step 5: Run updates in a transaction
    await prisma.$transaction(
      async tx => {
        for (const roleData of defaultRoles) {
          const { permissions: permissionCodes, ...roleInfo } = roleData;

          // Upsert the role (create or update if exists)
          const role = await tx.role.upsert({
            where: { code: roleInfo.code },
            update: { ...roleInfo },
            create: { ...roleInfo },
          });

          // Delete existing role permissions in one go
          await tx.rolePermission.deleteMany({
            where: { roleId: role.id },
          });

          // Prepare data for createMany
          const rolePermissionsData = permissionCodes.map(code => ({
            roleId: role.id,
            permissionId: permissionIdByCode[code],
          }));

          // Insert all role permissions at once
          await tx.rolePermission.createMany({
            data: rolePermissionsData,
          });
        }
      },
      {
        timeout: 30000,
        maxWait: 35000,
      },
    );

    console.info('Role seeding completed');
  } catch (error) {
    console.error('Error seeding roles:', error);
    throw error;
  }
};
