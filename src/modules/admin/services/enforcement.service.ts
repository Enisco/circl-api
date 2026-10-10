import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UserAccountStatus } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { AuditService } from '../audit/audit.service';

/**
 * Strikes and suspensions: the arithmetic of enforcement, apart from the endpoints that trigger it.
 *
 * Here rather than in a controller because two different things call it — a staff decision, and
 * the job that ends suspensions when their time is up — and both have to behave identically. A
 * suspension lifted by the clock and one lifted by a person differ in who is recorded, not in what
 * happens to the account.
 */
@Injectable()
export class EnforcementService {
  private readonly logger = new Logger(EnforcementService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Strikes that still count: not revoked, not yet expired. */
  async activeStrikeCount(userId: string): Promise<number> {
    return this.database.strike.count({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  /** The suspension in force, if any. */
  async activeSuspension(userId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.database;

    return client.suspension.findFirst({
      where: {
        userId,
        liftedAt: null,
        OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Ends every suspension whose time has run out.
   *
   * Run on a schedule because a suspension that outlives its end date is the platform keeping
   * somebody out by accident — and they cannot report it, because they cannot sign in to tell
   * anybody. Checking on their next sign-in attempt instead would be cheaper and would mean the
   * account stayed suspended until they happened to try.
   *
   * `liftedAt` with no `liftedById` is the signature of an expiry rather than a decision, which is
   * how the two are told apart afterwards.
   */
  async expireSuspensions(): Promise<number> {
    const now = new Date();
    const due = await this.database.suspension.findMany({
      where: { liftedAt: null, endsAt: { not: null, lte: now } },
      select: { id: true, userId: true, endsAt: true },
      take: 500,
    });

    if (!due.length) return 0;

    let lifted = 0;

    for (const suspension of due) {
      try {
        await this.database.$transaction(async tx => {
          await tx.suspension.update({
            where: { id: suspension.id },
            data: { liftedAt: now, liftReason: 'Suspension period ended.' },
          });

          // Only if nothing else is keeping them out. A second, longer suspension issued while the
          // first was running must not be undone by the first one expiring.
          const stillSuspended = await this.activeSuspension(suspension.userId, tx);

          if (!stillSuspended) {
            await tx.user.update({
              where: { id: suspension.userId },
              data: { status: UserAccountStatus.ACTIVE, suspendedUntil: null },
            });
          }

          await this.audit.record(tx, {
            action: 'member.suspension_expired',
            targetType: 'MEMBER',
            targetId: suspension.userId,
            // No actor: the clock did this, and saying a person did would be a false record.
            actorId: null,
            metadata: {
              suspensionId: suspension.id,
              endedAt: suspension.endsAt?.toISOString() ?? null,
              reactivated: !stillSuspended,
            },
          });
        });

        lifted += 1;
      } catch (error) {
        // One stuck row must not hold up the rest: the next member in the list is also waiting to
        // be let back in.
        this.logger.error({
          event: 'suspension_expiry_failed',
          suspensionId: suspension.id,
          message: (error as Error).message,
        });
      }
    }

    return lifted;
  }
}
