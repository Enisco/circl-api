import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, UserAccountStatus } from '@prisma/client';
import 'dotenv/config';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { Pool } from 'pg';

/**
 * Creates the first super admin, once.
 *
 * There is no seeded default administrator and no default password anywhere in this repository,
 * because a known starting credential is a known way in for as long as somebody forgets to change
 * it. Instead this prints a single-use invitation link, valid 72 hours, and the person who runs it
 * sets their own password and enrols their own authenticator.
 *
 * It refuses to run while an active super admin exists: the way to add a second is to invite them
 * from the portal, where the act is attributable to somebody.
 *
 *   pnpm admin:bootstrap --email you@circl.app --first Ada --last Lovelace
 */

const argOf = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? undefined : process.argv[index + 1];
};

const fail = (message: string): never => {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
};

const main = async () => {
  const email = argOf('email')?.trim().toLowerCase();
  const firstName = argOf('first')?.trim();
  const lastName = argOf('last')?.trim() ?? '';

  if (!email || !firstName) {
    fail('Usage: pnpm admin:bootstrap --email <address> --first <name> [--last <name>]');
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email!)) fail(`"${email}" is not an email address.`);

  const portalUrl = process.env.ADMIN_CLIENT_URL?.replace(/\/$/, '');

  if (!portalUrl) fail('ADMIN_CLIENT_URL is not set, so there is no link to print.');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool as unknown as ConstructorParameters<typeof PrismaPg>[0]);
  const prisma = new PrismaClient({ adapter, log: ['error'] });

  try {
    const role = await prisma.role.findUnique({ where: { code: 'super_admin' } });

    if (!role) fail('The super_admin role does not exist. Run the seeders first (pnpm db:seed).');

    const existing = await prisma.user.findFirst({
      where: {
        isStaff: true,
        status: UserAccountStatus.ACTIVE,
        userRole: { role: { code: 'super_admin' } },
        adminCredential: { deactivatedAt: null },
      },
      select: { email: true },
    });

    if (existing) {
      fail(
        `There is already an active super admin (${existing.email}). ` +
          `Invite further staff from the portal, where the invitation is attributable.`,
      );
    }

    const taken = await prisma.user.findUnique({ where: { email: email! }, select: { isStaff: true } });

    if (taken) {
      fail(
        taken.isStaff
          ? `${email} is already a staff account.`
          : `${email} belongs to a member account. Staff need a separate address.`,
      );
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

    await prisma.$transaction(async tx => {
      const invite = await tx.adminInvite.create({
        data: {
          email: email!,
          roleId: role!.id,
          tokenHash,
          // The invite records who sent it, and nobody did. It points at the account it creates,
          // which is the honest answer: this was the bootstrap, not a person.
          invitedById: '00000000-0000-0000-0000-000000000000',
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'staff.bootstrap_created',
          area: 'AUTH',
          actorId: null,
          targetType: 'STAFF',
          targetLabel: email!,
          metadata: { inviteId: invite.id, role: 'super_admin', via: 'cli' },
        },
      });
    });

    console.info(`
  ✅ Invitation created for ${firstName} ${lastName} <${email}>

     ${portalUrl}/invite/${token}

     It works once and expires in 72 hours. Nothing has been emailed — hand the link over
     yourself, and do not paste it anywhere that keeps a history.
`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
};

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
