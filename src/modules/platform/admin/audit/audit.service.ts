import { Injectable, Logger } from '@nestjs/common';
import { AdminReasonCode, Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { toJson } from '@/common';
import { AuditAction, areaOf } from './audit-actions';
import { adminContext } from '../common/admin-context';

/** What the caller knows about the action. Everything else is filled from the request context. */
export interface AuditDraft {
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  /**
   * A display snapshot for non-member targets. Left unset for members on purpose: their name is
   * resolved from the live row when the entry is read, so anonymising an account does not need
   * history rewritten — which the append-only trigger would refuse anyway (S11.4).
   */
  targetLabel?: string | null;
  before?: unknown;
  after?: unknown;
  reasonCode?: AdminReasonCode | null;
  policySubtype?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Overrides the context actor. Only for events with no authenticated actor: jobs, the CLI. */
  actorId?: string | null;
}

type Tx = Prisma.TransactionClient;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly database: PrismaService) {}

  /**
   * Runs a change and records it, or does neither.
   *
   * This is the only way admin services mutate. The spec asks that the audit row be written in the
   * same transaction as the change so a failed insert fails the action (S11.1) — which stops a
   * *wrong* entry but not a *missing* one, because a caller that never calls the audit service at
   * all satisfies it. Here the draft is a parameter: a mutation with no audit entry cannot be
   * written down.
   *
   * Returns the audit id alongside the result because every mutation response carries it, so the
   * portal can link a confirmation straight to the entry that recorded it (§5.0).
   */
  async mutate<T>(draft: AuditDraft, work: (tx: Tx) => Promise<T>): Promise<{
    result: T;
    auditId: string;
  }> {
    return this.database.$transaction(async tx => {
      const result = await work(tx);
      const auditId = await this.record(tx, draft);

      return { result, auditId };
    });
  }

  /**
   * Writes one entry on the transaction given.
   *
   * Public because some actions have no database change of their own — a failed login, a PII
   * reveal, a thread read — and those are exactly the ones worth recording.
   */
  async record(tx: Tx, draft: AuditDraft): Promise<string> {
    const context = adminContext.current();
    const row = await tx.auditLog.create({
      data: {
        action: draft.action,
        area: areaOf(draft.action),
        actorId: draft.actorId !== undefined ? draft.actorId : (context?.actorId ?? null),
        actorRole: context?.actorRole ?? null,
        actorSessionId: context?.actorSessionId ?? null,
        targetType: draft.targetType ?? null,
        targetId: draft.targetId ?? null,
        targetLabel: draft.targetLabel ?? null,
        before: draft.before === undefined ? Prisma.DbNull : toJson(draft.before),
        after: draft.after === undefined ? Prisma.DbNull : toJson(draft.after),
        reasonCode: draft.reasonCode ?? null,
        policySubtype: draft.policySubtype ?? null,
        reason: draft.reason ?? null,
        metadata: draft.metadata ? toJson(draft.metadata) : Prisma.DbNull,
        ip: context?.clientIp ?? null,
        userAgent: context?.userAgent ?? null,
        requestId: context?.requestId ?? null,
        idempotencyKey: context?.idempotencyKey ?? null,
      },
      select: { id: true },
    });

    return row.id;
  }

  /**
   * Records something with no transaction of its own.
   *
   * Used for events that are not a database change — a failed login attempt, a rate-limit trip.
   * It must not be able to fail the thing it describes: refusing a login because the note about
   * refusing it could not be written would turn a logging fault into an outage. Logged loudly
   * instead, because a silent gap in an audit trail is the worst of the three outcomes.
   */
  async note(draft: AuditDraft): Promise<string | null> {
    try {
      return await this.record(this.database, draft);
    } catch (error) {
      this.logger.error({
        securityEvent: 'audit_write_failed',
        action: draft.action,
        message: (error as Error).message,
      });

      return null;
    }
  }
}
