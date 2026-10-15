import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

/**
 * One staff account per role, so the portal can be signed into on a fresh database.
 *
 * ## Never in production
 *
 * These are published credentials: the password is in this file, in git, and the same on every
 * machine that runs the seed. An account with a known password and `super_admin` is the whole
 * platform, so this refuses to run if **either** environment signal says production — the same
 * two-signal rule as the demo dataset, because a guard that reads one of them is off in exactly
 * the configuration that matters.
 *
 * ## The second factor needs no setup
 *
 * Admin sign-in is password **plus** a six-digit code emailed to the account, and `login` never
 * returns a session for a password alone. There is nothing to enrol, so these accounts are usable
 * the moment they are seeded — which is the whole reason the authenticator went.
 *
 * Outside production that code is the fixed `111222` (see `dev-otp.constant.ts`), so a developer
 * with no mail provider configured can still sign in. Note what that means here: on a machine
 * where these accounts exist, the password is in this file and the code is a constant. That is two
 * published factors, which is one more reason this seeder refuses to run in production.
 */

/** Long enough and shapeless enough to pass the password rules the portal enforces. */
const PASSWORD = 'CirclStaffDev2026';

type SeedAdmin = {
  roleCode: string;
  email: string;
  firstName: string;
  lastName: string;
};

/**
 * One per role that can sign into the portal.
 *
 * `user` is left out on purpose: it is the member role, it holds no admin permission, and an
 * account carrying it with `isStaff` would be a staff credential that can reach nothing — which
 * looks like a broken account rather than a deliberate one.
 */
const ADMINS: SeedAdmin[] = [
  {
    roleCode: 'super_admin',
    email: 'super.admin@circl.test',
    firstName: 'Super',
    lastName: 'Admin',
  },
  { roleCode: 'manager', email: 'manager@circl.test', firstName: 'Platform', lastName: 'Manager' },
  {
    roleCode: 'trust_safety',
    email: 'trust.safety@circl.test',
    firstName: 'Trust',
    lastName: 'Safety',
  },
  {
    roleCode: 'support',
    email: 'support.staff@circl.test',
    firstName: 'Support',
    lastName: 'Team',
  },
];

const assertNotProduction = () => {
  if ([process.env.NODE_ENV, process.env.APP_ENV].includes('production')) {
    throw new Error(
      'The staff accounts refuse to be seeded in production: the password is in the repository. ' +
        'There is deliberately no flag to override this.',
    );
  }
};

export const seedAdminAccounts = async (prisma: PrismaClient) => {
  assertNotProduction();

  console.info('Seeding staff accounts...');

  // The same parameters as `AdminPasswordService`, and the same cast for the same reason: `type`
  // is the numeric variant constant at runtime while the package's declaration types it as a name.
  const options = {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  } as unknown as argon2.HashOptions;
  const passwordHash: string = await argon2.hash(PASSWORD, options);

  let created = 0;
  let kept = 0;

  for (const admin of ADMINS) {
    const role = await prisma.role.findUnique({ where: { code: admin.roleCode } });

    if (!role) {
      console.warn(`  ⚠ no ${admin.roleCode} role — run the role seeder first`);
      continue;
    }

    const existing = await prisma.user.findUnique({
      where: { email: admin.email },
      select: { id: true, adminCredential: { select: { passwordHash: true } } },
    });

    if (existing) {
      // The role and staff flag are re-asserted, because a role rename or a permission change
      // should reach these accounts.
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          isStaff: true,
          status: 'ACTIVE',
          userRole: {
            upsert: { create: { roleId: role.id }, update: { roleId: role.id } },
          },
        },
      });

      // And so is the password, when it has stopped being the published one.
      //
      // This used to be left alone, on the reasoning that somebody may have changed it on a shared
      // environment and a seeder should not quietly undo that. It is the wrong reasoning for these
      // four rows: the password is printed in this file, so changing it makes nothing secret — it
      // only strands the one credential the documentation tells people to use. That is exactly
      // what happened on at least one database, where these accounts were created by an earlier
      // version of this seeder and then kept a password nobody could name.
      //
      // Re-asserted rather than reset blindly, and announced when it changes anything, so the
      // objection that stood behind the old behaviour — doing it *silently* — still does not apply.
      const stale =
        existing.adminCredential !== null &&
        !(await argon2.verify(existing.adminCredential.passwordHash, PASSWORD).catch(() => false));

      if (stale) {
        await prisma.adminCredential.update({
          where: { userId: existing.id },
          data: {
            passwordHash,
            passwordUpdatedAt: new Date(),
            lockedUntil: null,
            failedAttempts: 0,
          },
        });
        console.warn(`  ↺ ${admin.email}: password was not the published one, and has been reset`);
      }

      kept += 1;
      continue;
    }

    await prisma.user.create({
      data: {
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
        username: admin.email.split('@')[0].replace(/\./g, '_'),
        status: 'ACTIVE',
        isStaff: true,
        // Verified: these never receive an email, and an unverified staff account would be stopped
        // by the nudge in `AccountSecurityService` before it reached the portal. It lives on
        // `UserAuth`, not on the user.
        userAuth: { create: { emailVerifiedAt: new Date() } },
        userRole: { create: { roleId: role.id } },
        adminCredential: {
          create: {
            passwordHash,
            passwordUpdatedAt: new Date(),
            // Dormant column, set explicitly so the row says so rather than leaving it to the
            // default. Nothing reads it; the second factor is emailed.
            totpEnabledAt: null,
          },
        },
      },
    });
    created += 1;
  }

  console.info(`  ✅ ${created} staff account(s) created, ${kept} already present`);
  console.info(`     Password for all of them: ${PASSWORD}`);
  console.info('     Sign-in code: 111222 — the fixed development OTP, so no mail is needed.');
};
