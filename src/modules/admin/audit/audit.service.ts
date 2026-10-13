import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AdminReasonCode, AuditArea, Prisma } from '@prisma/client';
import { CacheService, PrismaService } from '@/infrastructure';
import { rowDigest, toJson } from '@/common';
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
  /**
   * Overrides the action's registered area.
   *
   * For the handful of actions whose area is a property of the *target* rather than the action:
   * one note table serves every subject (§4.7), and who may read the entry about it follows the
   * subject — a note on a Guard case belongs with safety work, not with member administration.
   * Everything else leaves this unset, so the registry stays the single answer.
   */
  area?: AuditArea;
}

type Tx = Prisma.TransactionClient;

/** How long the sealed tip is reused for. It changes once a night; this is about write cost. */
const TIP_TTL_MS = 60_000;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
  ) {}

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
  async mutate<T>(
    draft: AuditDraft | ((result: T) => AuditDraft),
    work: (tx: Tx) => Promise<T>,
  ): Promise<{
    result: T;
    auditId: string;
  }> {
    return this.database.$transaction(async tx => {
      const result = await work(tx);
      // A draft may be a function of the result, because `after` is usually the row the mutation
      // just produced and no caller can know it in advance. Passing it as a plain object and
      // leaving `after` out is how an entry comes to record what was asked for rather than what
      // happened — which is the one difference worth having the trail for.
      const auditId = await this.record(tx, typeof draft === 'function' ? draft(result) : draft);

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
    /**
     * The id and the timestamp are set here rather than by the database, because the row's digest
     * has to cover both and cannot be computed after the insert — the trail is append-only, so
     * there is no second write to put a hash into (S11.3).
     *
     * `occurredAt` is therefore the moment the entry was recorded. The column default was
     * `now()`, which in Postgres is the *transaction's* start time: two entries written minutes
     * apart inside one long transaction carried the same timestamp, and an entry written at the
     * end of one appeared to precede things that happened before it.
     */
    const id = randomUUID();
    const occurredAt = new Date();
    const digested = {
      id,
      occurredAt,
      actorId: draft.actorId !== undefined ? draft.actorId : (context?.actorId ?? null),
      actorRole: context?.actorRole ?? null,
      actorSessionId: context?.actorSessionId ?? null,
      action: draft.action,
      area: draft.area ?? areaOf(draft.action),
      targetType: draft.targetType ?? null,
      targetId: draft.targetId ?? null,
      targetLabel: draft.targetLabel ?? null,
      before: draft.before,
      after: draft.after,
      reasonCode: draft.reasonCode ?? null,
      policySubtype: draft.policySubtype ?? null,
      reason: draft.reason ?? null,
      metadata: draft.metadata ?? null,
      ip: context?.clientIp ?? null,
      userAgent: context?.userAgent ?? null,
      requestId: context?.requestId ?? null,
      idempotencyKey: context?.idempotencyKey ?? null,
    };
    /**
     * The insert is built **from** the digested object rather than beside it.
     *
     * Two field lists would be a way for a column to be recorded and not covered by its own
     * digest: somebody adds a field to the insert, the digest keeps hashing the nineteen it knew,
     * and the trail quietly stops being evidence of that twentieth thing. The JSON columns are the
     * only ones that differ, because Prisma needs `DbNull` where the draft says nothing.
     */
    const row = await tx.auditLog.create({
      data: {
        ...digested,
        before: draft.before === undefined ? Prisma.DbNull : toJson(draft.before),
        after: draft.after === undefined ? Prisma.DbNull : toJson(draft.after),
        metadata: draft.metadata ? toJson(draft.metadata) : Prisma.DbNull,
        hash: rowDigest(digested),
        prevHash: await this.sealedTip(),
      },
      select: { id: true },
    });

    return row.id;
  }

  /** The sealed tip, and when it was read. Memoised, because every entry asks for it. */
  private tip: { hash: string | null; readAt: number } = { hash: null, readAt: 0 };

  /**
   * The hash of the newest sealed segment, cached for a minute.
   *
   * Written onto every entry as `prevHash`, which anchors the entry to history that was already
   * sealed when it was recorded. What that catches is a row **inserted later and backdated**: it
   * carries a tip that did not exist at the time it claims to have happened. What it does not
   * catch is somebody writing rows straight into Postgres with a tip of their choosing — nothing
   * on this side of the connection can — and that is what the segment chain and the append-only
   * trigger are for.
   *
   * A minute of staleness is deliberate: the alternative is a query per audit entry, on the write
   * path of every admin mutation, for a value that changes once a night. A read that fails leaves
   * the entry unanchored rather than failing the action it describes.
   */
  /**
   * Drops the cached tip, called by the chain service the moment it seals a segment.
   *
   * Without it the minute of staleness is also a minute of entries anchored to the segment before
   * the one that had just been written — harmless in production, and impossible to write a check
   * against, which is how a cache becomes the reason a rule is never tested.
   */
  forgetTip(): void {
    this.tip = { hash: null, readAt: 0 };
  }

  private async sealedTip(): Promise<string | null> {
    if (this.tip.readAt && Date.now() - this.tip.readAt < TIP_TTL_MS) return this.tip.hash;

    try {
      const latest = await this.database.auditChainSegment.findFirst({
        orderBy: { seq: 'desc' },
        select: { hash: true },
      });

      this.tip = { hash: latest?.hash ?? null, readAt: Date.now() };
    } catch (error) {
      this.logger.warn(
        `audit chain tip unreadable, entries unanchored: ${(error as Error).message}`,
      );
      this.tip = { hash: null, readAt: Date.now() };
    }

    return this.tip.hash;
  }

  /**
   * Records something with no transaction of its own.
   *
   * Used for events that are not a database change — a failed login attempt, a rate-limit trip.
   * It must not be able to fail the thing it describes: refusing a login because the note about
   * refusing it could not be written would turn a logging fault into an outage. Logged loudly
   * instead, because a silent gap in an audit trail is the worst of the three outcomes.
   */
  /**
   * The same, but at most once per window for a given key (§5.12).
   *
   * A read is worth recording and a *poll* is not. The portal refreshes the Guard thread every
   * thirty seconds, so one entry per request is roughly 2,800 rows per staff member per case per
   * day — a trail in which every genuine act is buried in noise, which is the same as not having
   * one. §5.12 asks for once per staff member per case per day, and this is that rule.
   *
   * Keyed in the cache rather than queried out of the audit table: "has this person already been
   * recorded today" is a question about a counter, and asking it of an append-only log on every
   * poll is a scan of the thing we are trying to keep small.
   *
   * A cache that is down means the window cannot be established, and this writes the entry rather
   * than dropping it — a duplicated audit row is noise, a missing one is a gap, and the two are
   * not equally bad.
   */
  async noteOncePer(key: string, windowSeconds: number, draft: AuditDraft): Promise<string | null> {
    try {
      const seen = await this.cache.get<boolean>(key);

      if (seen) return null;
    } catch (error) {
      this.logger.warn(`Audit throttle unavailable, recording anyway: ${(error as Error).message}`);
    }

    const id = await this.note(draft);

    // After the write, so a failed write does not open the window and swallow the next read too.
    await this.cache.set(key, true, windowSeconds).catch(() => undefined);

    return id;
  }

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
