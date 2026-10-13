import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { AuditDigestInput, JobFailure, rowDigest, segmentHash } from '@/common';
import { AuditService } from './audit.service';

/**
 * S11.3: seals the audit trail into hashed segments and checks the seals.
 *
 * **What this is for.** The trail is append-only in Postgres (S11.2): a trigger refuses UPDATE
 * outright and DELETE outside a transaction that has declared itself a retention purge. That
 * stops the application rewriting its own history — the second half of S11.2, a database role for
 * the app with only `INSERT, SELECT` on `audit_logs`, is **not** set up here and would have to be
 * granted at deploy time; the trigger is what is actually enforcing this today.
 *
 * Neither stops somebody with database-owner access editing a row directly, and the one row an
 * attacker most wants to change is the one recording what they did. A hash chain cannot stop that
 * either. What it does is make it **visible**.
 *
 * **Why segments rather than a hash on every row.** A per-row chain has to read the previous row's
 * hash and write the next one as one serialised step, or two concurrent actions read the same tip
 * and the chain forks. Serialising it means holding a lock through the business transaction the
 * audit row belongs to — a global queue through every admin mutation, and a new deadlock surface —
 * for a control the spec marks *recommended, P3*. Sealing afterwards costs nothing on the write
 * path, covers the rows written before any of this existed, and detects the same three things: a
 * row changed, a row removed, a row inserted into a stretch already sealed.
 *
 * **Where the evidence has to live.** A chain stored only next to the rows it describes is worth
 * what the attacker's patience is worth: rewrite a row, re-seal the segment, done. So every seal
 * logs its hash, and the job run records it too (§5.22's history). Those are the copies that leave
 * the database — the log is shipped off the box — and the whole value of this is that somebody can
 * hold yesterday's tip against today's table.
 */
@Injectable()
export class AuditChainService {
  private readonly logger = new Logger(AuditChainService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Rows older than this are sealable.
   *
   * `occurredAt` is set when the entry is recorded, and the row becomes visible when its
   * transaction commits — so a row can appear a few seconds after the instant it carries. Sealing
   * only what is older than fifteen minutes means a commit would have to outlive every transaction
   * timeout on the platform by two orders of magnitude to land inside a sealed range. When one
   * does anyway, verification reports it as a late insert rather than as tampering, because the two
   * are different problems and only one of them is somebody's fault.
   */
  private static readonly SEAL_LAG_MS = 15 * 60 * 1000;

  /** At most this many rows in one segment, so a backlog seals as several rather than one vast one. */
  private static readonly MAX_SEGMENT_ROWS = 50_000;

  /**
   * And at most a day of the trail in one segment, which is what makes the six-year purge possible.
   *
   * The purge (S11.4) removes **whole** segments, because deleting rows out of a sealed stretch and
   * re-sealing what is left would let anybody who can run the purge launder a deletion. A segment
   * is therefore the granularity at which history can be dropped: a day of it means retention
   * overshoots by at most a day, and a single segment spanning the whole trail — which is what an
   * uncapped seal produces the first time it runs against an existing trail — would mean the purge
   * could never remove anything at all.
   */
  private static readonly MAX_SEGMENT_SPAN_MS = 24 * 60 * 60 * 1000;

  /**
   * How many segments one run will seal.
   *
   * A trail that has gone unsealed for a year seals as a year of days, and a job that writes three
   * hundred and sixty-five segments in one pass is one nobody can read the log of. The backlog
   * clears over as many nights as it takes, oldest first, and the summary says how far it got.
   */
  private static readonly MAX_SEGMENTS_PER_RUN = 400;

  /** The newest segments are re-checked every run. */
  private static readonly ALWAYS_VERIFY = 7;

  /**
   * And the rest on a rotation, a thirtieth of them a night.
   *
   * Verifying every segment every night means reading the entire trail every night, which at six
   * years of retention is most of the database for a job nobody is watching. Verifying only the
   * newest would leave an edit to a two-year-old row undetected for ever, which is precisely the
   * row somebody would choose. A rotation covers the whole history every month at a thirtieth of
   * the cost, and the link check below covers all of it every single run.
   */
  private static readonly ROTATION = 30;

  /**
   * Seals everything sealable, then verifies. Returns the one-line summary the job history keeps.
   *
   * Sealing first on purpose: a run that found nothing to check still has to advance the chain, and
   * a run that seals a tampered stretch has still sealed it — the segment records what was there
   * when it ran, which is all any seal can claim.
   */
  async run(): Promise<string> {
    const sealed = await this.seal();
    const findings = await this.verify();
    const tip = await this.tip();

    const summary = [
      sealed.segments
        ? `sealed ${sealed.segments} segment(s) over ${sealed.rows} row(s)`
        : 'nothing new to seal',
      findings.checked ? `verified ${findings.checked} segment(s)` : 'no segments to verify',
      tip ? `tip ${tip.slice(0, 16)}…` : 'no tip',
    ].join(', ');

    if (findings.problems.length) {
      /**
       * The alert S11.3 asks for.
       *
       * `securityEvent` is the field the log pipeline alerts on, and the message says which
       * segment and what kind of difference, because "the audit chain is broken" with no range in
       * it sends somebody looking through six years of rows.
       */
      this.logger.error({
        securityEvent: 'audit_chain_mismatch',
        problems: findings.problems,
        message: `Audit chain verification found ${findings.problems.length} problem(s)`,
      });

      /**
       * Thrown, so the run is recorded as FAILED rather than as a success with a note in it. A job
       * history where this reads green is a worse outcome than the tampering it is reporting.
       *
       * The first few problems, not all of them: a rewritten stretch produces one per row, and an
       * alert carrying ten thousand row ids is one nobody reads. The count is in the sentence, and
       * the rest are in the structured log line above.
       */
      const named = findings.problems.slice(0, PROBLEMS_IN_MESSAGE);
      const rest = findings.problems.length - named.length;

      /**
       * Thrown with the summary attached, so the sealing survives into the run's history row.
       * A night that sealed four stretches and found a difference in a fifth did both, and a row
       * that says only "verification failed" has lost half of what happened.
       */
      throw new JobFailure(
        `Audit chain verification failed: ${named.map(problem => problem.detail).join('; ')}` +
          (rest ? ` (and ${rest} more)` : ''),
        summary,
      );
    }

    this.logger.log(`audit.verify-chain: ${summary}`);

    return summary;
  }

  /** The newest sealed segment's hash: the value every new audit row is anchored to. */
  async tip(): Promise<string | null> {
    const latest = await this.database.auditChainSegment.findFirst({
      orderBy: { seq: 'desc' },
      select: { hash: true },
    });

    return latest?.hash ?? null;
  }

  /**
   * Covers every row older than the lag that no segment covers yet, a day of the trail at a time.
   *
   * The lower bound is the previous segment's `toOccurredAt` — not the last row's timestamp — so
   * the ranges are contiguous and there is nowhere between two segments for a row to sit
   * uncovered. The upper bound is a day on, or the cutoff, whichever is sooner.
   */
  async seal(now = new Date()): Promise<{ segments: number; rows: number }> {
    const cutoff = new Date(now.getTime() - AuditChainService.SEAL_LAG_MS);
    let segments = 0;
    let rows = 0;

    while (segments < AuditChainService.MAX_SEGMENTS_PER_RUN) {
      const last = await this.database.auditChainSegment.findFirst({
        orderBy: { seq: 'desc' },
        select: { hash: true, toOccurredAt: true },
      });
      const from = last?.toOccurredAt ?? (await this.earliest());

      // An empty trail has nothing to anchor a first segment to. Nothing to do until it has a row.
      if (!from) return { segments, rows };
      if (from >= cutoff) return { segments, rows };

      let window = await this.rowsIn(from, this.dayAfter(from, cutoff));

      /**
       * A day with nothing in it is skipped forward rather than sealed.
       *
       * An empty segment would hash the same every night and advance the watermark over rows that
       * may still be committing; stopping instead would mean a single quiet day left the rest of
       * the trail unsealed for ever. So the window keeps its lower bound — the ranges stay
       * contiguous — and its upper bound jumps to a day past the next entry there actually is.
       */
      if (!window.rows.length) {
        const next = await this.database.auditLog.findFirst({
          where: { occurredAt: { gt: from, lte: cutoff } },
          orderBy: { occurredAt: 'asc' },
          select: { occurredAt: true },
        });

        if (!next) return { segments, rows };

        window = await this.rowsIn(from, this.dayAfter(next.occurredAt, cutoff));
      }

      if (!window.rows.length) return { segments, rows };

      /**
       * Two runs sealing at once — the schedule firing while somebody has pressed the button —
       * would both read this `last` and both write a segment claiming to follow it. That is a
       * forked chain, which is worse than no chain: verification would report a broken link for
       * ever and nobody could tell which branch was the real history.
       *
       * Guarded by the table rather than by a lock: `prev_hash` and `from_occurred_at` are unique,
       * so the second insert fails, that run is recorded FAILED, and the chain is left with one
       * link. A lock would have to be held across a job that reads most of the trail.
       */
      await this.database.auditChainSegment.create({
        data: {
          fromOccurredAt: from,
          toOccurredAt: window.to,
          rowCount: window.rows.length,
          prevHash: last?.hash ?? null,
          hash: segmentHash(last?.hash ?? null, window.rows.map(digestOf)),
          verifiedAt: new Date(),
        },
      });

      segments += 1;
      rows += window.rows.length;

      // Entries written from here on are anchored to the segment just sealed rather than to the
      // one before it, which is only true if the cached tip is dropped now.
      this.audit.forgetTip();

      this.logger.log(
        `audit chain sealed ${window.rows.length} row(s) to ${window.to.toISOString()}`,
      );

      // A window that reached the cutoff is the last one. A shorter one stopped at a day or at a
      // row cap, so there is more behind it and the next pass carries on from this boundary.
      if (window.to >= cutoff) return { segments, rows };
    }

    this.logger.warn(
      `audit chain sealed ${AuditChainService.MAX_SEGMENTS_PER_RUN} segment(s), the most one run will: more remains`,
    );

    return { segments, rows };
  }

  /** A day on from `from`, or the cutoff if that is sooner. */
  private dayAfter(from: Date, cutoff: Date): Date {
    const end = from.getTime() + AuditChainService.MAX_SEGMENT_SPAN_MS;

    return new Date(Math.min(end, cutoff.getTime()));
  }

  /**
   * Recomputes segments and the links between them.
   *
   * Three kinds of problem, reported separately because they mean different things:
   *
   *  - **`row`** — a row in the range no longer digests to the hash it was sealed with. That is a
   *    row that has been edited, and it names the row.
   *  - **`segment`** — the range's hash no longer matches. With no row-level mismatch and fewer
   *    rows than were sealed, something was deleted; with more, something arrived late.
   *  - **`link`** — a segment's `prevHash` is not the previous segment's hash, which is a segment
   *    inserted, removed or rewritten.
   */
  async verify(now = new Date()): Promise<{ checked: number; problems: ChainProblem[] }> {
    const all = await this.database.auditChainSegment.findMany({
      orderBy: { seq: 'asc' },
      select: {
        id: true,
        seq: true,
        fromOccurredAt: true,
        toOccurredAt: true,
        rowCount: true,
        prevHash: true,
        hash: true,
      },
    });
    const problems: ChainProblem[] = [];
    /**
     * The hashes the six-year purge has removed (S11.4).
     *
     * The oldest remaining segment records a predecessor that was purged, which is a broken link
     * unless the purge said so. Read once rather than per segment — there is one of these per
     * purge, and the purge removes six years at a time.
     */
    const truncated = new Set(
      (await this.database.auditChainTruncation.findMany({ select: { removedHash: true } })).map(
        row => row.removedHash,
      ),
    );

    /**
     * The links, over the whole chain, every run. Cheap — one row per day of history — and it is
     * what catches a segment being removed to cover a stretch of rows.
     *
     * The one exception is the oldest segment after a purge (S11.4): its predecessor is gone, so
     * its `prevHash` points at nothing in the table. That is accepted only where a truncation row
     * accounts for the hash, and nowhere else — a chain that forgives a missing genesis forgives a
     * deleted one.
     */
    all.forEach((segment, index) => {
      const previous = index === 0 ? null : all[index - 1];
      const expected = previous?.hash ?? null;

      if ((segment.prevHash ?? null) === expected) return;

      // The first segment is allowed to follow a hash that is gone, if a truncation row says the
      // purge removed it. Any other segment, and any hash nobody recorded removing, is a break.
      if (index === 0 && segment.prevHash && truncated.has(segment.prevHash)) return;

      problems.push({
        kind: 'link',
        segmentId: segment.id,
        detail: `segment ${segment.seq} follows ${expected ?? 'the genesis'} but records ${segment.prevHash ?? 'nothing'}`,
      });
    });

    const due = all.filter((segment, index) => {
      if (index >= all.length - AuditChainService.ALWAYS_VERIFY) return true;

      return (
        Number(segment.seq) % AuditChainService.ROTATION ===
        now.getUTCDate() % AuditChainService.ROTATION
      );
    });

    for (const segment of due) {
      const window = await this.rowsIn(segment.fromOccurredAt, segment.toOccurredAt);
      const digests: string[] = [];

      for (const row of window.rows) {
        const digest = digestOf(row);

        digests.push(digest);

        // A row with no stored hash is one written before the chain existed. Every writer sets one
        // now — the admin service and both member-side paths — so this is history rather than a
        // gap, and those rows are still covered by the segment hash the moment they are sealed.
        if (row.hash && row.hash !== digest) {
          problems.push({
            kind: 'row',
            segmentId: segment.id,
            rowId: row.id,
            detail: `entry ${row.id} in segment ${segment.seq} no longer matches its own digest`,
          });
        }
      }

      const recomputed = segmentHash(segment.prevHash ?? null, digests);

      if (recomputed !== segment.hash) {
        const difference =
          window.rows.length === segment.rowCount
            ? 'the same number of rows, changed'
            : window.rows.length < segment.rowCount
              ? `${segment.rowCount - window.rows.length} row(s) missing`
              : `${window.rows.length - segment.rowCount} row(s) inserted after it was sealed`;

        problems.push({
          kind: 'segment',
          segmentId: segment.id,
          detail: `segment ${segment.seq} (${segment.fromOccurredAt.toISOString()} → ${segment.toOccurredAt.toISOString()}) sealed ${segment.rowCount} row(s) and now holds ${window.rows.length}: ${difference}`,
        });

        continue;
      }

      // Only the untouched ones are marked, and `verifiedAt` is the one column the append-only
      // trigger lets this job write — the sealed facts beside it stay unwritable.
      await this.database.auditChainSegment.update({
        where: { id: segment.id },
        data: { verifiedAt: new Date() },
      });
    }

    return { checked: due.length, problems };
  }

  /**
   * S11.4: drops the trail's oldest six years, and says so.
   *
   * **Whole segments only.** Deleting rows out of a sealed stretch and re-sealing what is left
   * would make the purge a laundering tool: anybody who could run it could remove a row and leave
   * a chain that verifies. So a stretch is removed entire, and the rows that outlive the boundary
   * by up to a segment's span — a day — are kept until their own segment is past it. Over-retaining
   * for a day is a smaller problem than a hash chain that can be re-cut.
   *
   * Rows **below the chain's genesis** are a separate case and are deleted outright: no segment
   * covers them, so removing them changes nothing any hash was computed over. That is where a
   * backdated insert lands, and it is the one stretch of the trail no seal protects.
   *
   * Every delete runs in a transaction that has declared itself a purge, which is the only thing
   * the append-only trigger lets through (S11.2) and which nothing else in the application sets.
   */
  async purge(
    boundary: Date,
  ): Promise<{ rows: number; segments: number; removedHash: string | null }> {
    const cut = await this.database.auditChainSegment.findFirst({
      where: { toOccurredAt: { lte: boundary } },
      orderBy: { seq: 'desc' },
      select: { id: true, seq: true, hash: true, toOccurredAt: true },
    });
    const upTo = cut ? cut.toOccurredAt : await this.unsealedBound(boundary);

    if (!upTo) return { rows: 0, segments: 0, removedHash: null };

    const rows = await this.deleteEntries(upTo);

    if (!cut) return { rows, segments: 0, removedHash: null };

    /**
     * The explanation is written **before** the segments go.
     *
     * A run that dies between the two leaves a truncation row for a stretch that is still there,
     * which verification ignores — the rule is that the oldest segment's predecessor must be
     * accounted for, not that every record must be used. The other order would leave the chain
     * shortened with nothing to explain it, which is the thing this table exists to prevent.
     */
    const removed = await this.database.auditChainSegment.count({
      where: { seq: { lte: cut.seq } },
    });

    await this.database.auditChainTruncation.create({
      data: {
        removedHash: cut.hash,
        upToOccurredAt: cut.toOccurredAt,
        segmentsRemoved: removed,
        rowsRemoved: rows,
      },
    });

    await this.purging(tx => tx.auditChainSegment.deleteMany({ where: { seq: { lte: cut.seq } } }));

    this.logger.log(
      `audit retention: purged ${rows} entr(ies) and ${removed} segment(s) up to ${cut.toOccurredAt.toISOString()}`,
    );

    return { rows, segments: removed, removedHash: cut.hash };
  }

  /**
   * How far a purge may go when no sealed stretch is old enough: the **earlier** of the chain's
   * start and the retention boundary.
   *
   * Both limits are real and the stricter one wins. The genesis is where the seals begin, so
   * nothing above it may be touched a row at a time; the boundary is the retention promise, so
   * nothing below it may be kept. With nothing sealed at all only the boundary applies.
   *
   * Taking the genesis alone was the first version, and it was wrong in the ordinary case: a chain
   * that started last week is *after* a six-year boundary, so it answered "nothing to purge" and
   * the backdated rows below it would have been kept for ever.
   */
  private async unsealedBound(boundary: Date): Promise<Date | null> {
    const genesis = await this.database.auditChainSegment.findFirst({
      orderBy: { seq: 'asc' },
      select: { fromOccurredAt: true },
    });

    if (!genesis) return boundary;

    return new Date(Math.min(genesis.fromOccurredAt.getTime(), boundary.getTime()));
  }

  /** The entries themselves, in batches, so one transaction never holds the table for minutes. */
  private async deleteEntries(upTo: Date): Promise<number> {
    let total = 0;

    for (;;) {
      const batch = await this.database.auditLog.findMany({
        where: { occurredAt: { lte: upTo } },
        orderBy: { occurredAt: 'asc' },
        take: PURGE_BATCH,
        select: { id: true },
      });

      if (!batch.length) return total;

      const { count } = await this.purging(tx =>
        tx.auditLog.deleteMany({ where: { id: { in: batch.map(row => row.id) } } }),
      );

      total += count;

      if (batch.length < PURGE_BATCH) return total;
    }
  }

  /**
   * Runs the work in a transaction that has declared itself a retention purge.
   *
   * `SET LOCAL` so the declaration dies with the transaction: on a pooled connection a plain `SET`
   * would leave the next statement — on anybody's request — able to delete audit rows.
   */
  private async purging<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.database.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL circl.retention_purge = 'on'");

      return work(tx);
    });
  }

  /** The first entry in the trail, which is where the chain starts. */
  private async earliest(): Promise<Date | null> {
    const first = await this.database.auditLog.findFirst({
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true },
    });

    // A moment before it, because the lower bound is exclusive and the first row has to be inside.
    return first ? new Date(first.occurredAt.getTime() - 1) : null;
  }

  /**
   * The rows in `(from, to]`, in the chain's order, capped.
   *
   * Ordered by `(occurredAt, id)` so the order is total: two entries recorded in the same
   * millisecond would otherwise come back in whatever order the plan produced, and the hash would
   * depend on the query plan rather than on the rows.
   */
  private async rowsIn(from: Date, to: Date): Promise<{ rows: ChainRow[]; to: Date }> {
    const rows = await this.database.auditLog.findMany({
      where: { occurredAt: { gt: from, lte: to } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: AuditChainService.MAX_SEGMENT_ROWS,
      select: ROW_SELECT,
    });

    if (rows.length < AuditChainService.MAX_SEGMENT_ROWS) return { rows, to };

    /**
     * A capped window ends at its last row rather than at the cutoff, and the next pass carries on
     * from there — the lower bound is exclusive, so the range stays contiguous.
     *
     * The rows sharing that last timestamp are dropped first. Without that, a row with the same
     * millisecond and a higher id sits above the page and below the boundary: inside the segment's
     * range, outside the rows it hashed, and covered by nothing afterwards. Unless they are *all*
     * on the same millisecond, in which case dropping them would leave an empty window and seal
     * nothing for ever; fifty thousand entries in one millisecond is not a thing that happens, and
     * a loop that never ends is.
     */
    const edge = rows[rows.length - 1].occurredAt.getTime();
    const trimmed = rows.filter(row => row.occurredAt.getTime() < edge);

    return trimmed.length
      ? { rows: trimmed, to: trimmed[trimmed.length - 1].occurredAt }
      : { rows, to: rows[rows.length - 1].occurredAt };
  }
}

/** How many entries one purge transaction removes. Keeps a six-year backlog off one lock. */
const PURGE_BATCH = 5_000;

/** How many problems the thrown message names before it starts counting them instead. */
const PROBLEMS_IN_MESSAGE = 5;

/** What a verification run found. `detail` is written to be read in an alert, on a phone. */
export interface ChainProblem {
  kind: 'row' | 'segment' | 'link';
  segmentId: string;
  rowId?: string;
  detail: string;
}

const ROW_SELECT = {
  id: true,
  occurredAt: true,
  actorId: true,
  actorRole: true,
  actorSessionId: true,
  action: true,
  area: true,
  targetType: true,
  targetId: true,
  targetLabel: true,
  before: true,
  after: true,
  reasonCode: true,
  policySubtype: true,
  reason: true,
  metadata: true,
  ip: true,
  userAgent: true,
  requestId: true,
  idempotencyKey: true,
  hash: true,
} satisfies Prisma.AuditLogSelect;

type ChainRow = Prisma.AuditLogGetPayload<{ select: typeof ROW_SELECT }>;

/**
 * The stored row, put back into the shape its digest was computed from.
 *
 * `DbNull` reads back as `null` and the canonical form treats absent and null alike, so a row that
 * went in with `before` unset digests the same coming out. That is the one thing this function
 * exists to keep true.
 */
const digestOf = (row: ChainRow): string => rowDigest(row as unknown as AuditDigestInput);
