import { AuditChainService } from '../audit-chain.service';

/**
 * The six-year purge (S11.4), against a clock this test owns.
 *
 * It cannot be proved end-to-end: the rule is six years and no database anybody can test against
 * holds six years of audit rows. So the database is a stub here and what is checked is the
 * decisions — how far the purge is allowed to reach, whether it records what it removed, and
 * whether it declares itself to the append-only trigger. The live checks in
 * `admin-audit.e2e.cjs` cover the parts that can be reached without a time machine.
 */
type Segment = {
  id: string;
  seq: bigint;
  hash: string;
  fromOccurredAt: Date;
  toOccurredAt: Date;
};

const at = (iso: string) => new Date(iso);

/**
 * A database that answers only the questions `purge` asks, and records what it was told to do.
 *
 * Hand-written rather than a mocking library: what matters is that `SET LOCAL` precedes every
 * delete, and a stub that records the order of calls says that plainly.
 */
const stub = (segments: Segment[], entries: Date[]) => {
  const calls: string[] = [];
  const deleted: { entries: number; upTo?: Date; segmentsUpToSeq?: bigint } = { entries: 0 };
  const truncations: Array<Record<string, unknown>> = [];
  let declared = false;
  let remaining = [...entries];

  const database = {
    auditChainSegment: {
      findFirst: ({ where, orderBy }: any) => {
        const sorted = [...segments].sort((left, right) =>
          orderBy?.seq === 'desc' ? Number(right.seq - left.seq) : Number(left.seq - right.seq),
        );
        const bound = where?.toOccurredAt?.lte as Date | undefined;
        const match = bound ? sorted.find(segment => segment.toOccurredAt <= bound) : sorted[0];

        return Promise.resolve(match ?? null);
      },
      count: ({ where }: any) =>
        Promise.resolve(segments.filter(segment => segment.seq <= where.seq.lte).length),
      deleteMany: ({ where }: any) => {
        calls.push(declared ? 'segments(purging)' : 'segments(undeclared)');
        deleted.segmentsUpToSeq = where.seq.lte;

        return Promise.resolve({ count: 1 });
      },
    },
    auditChainTruncation: {
      create: ({ data }: any) => {
        calls.push('truncation');
        truncations.push(data);

        return Promise.resolve(data);
      },
    },
    auditLog: {
      findMany: ({ where, take }: any) => {
        const bound = where.occurredAt.lte as Date;

        deleted.upTo = bound;

        return Promise.resolve(
          remaining
            .filter(entry => entry <= bound)
            .slice(0, take)
            .map((entry, index) => ({ id: `${entry.toISOString()}#${index}` })),
        );
      },
      deleteMany: ({ where }: any) => {
        calls.push(declared ? 'entries(purging)' : 'entries(undeclared)');

        const count = where.id.in.length;

        remaining = remaining.slice(count);
        deleted.entries += count;

        return Promise.resolve({ count });
      },
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const previous = declared;
      const result = await work(database);

      declared = previous;

      return result;
    },
    $executeRawUnsafe: (sql: string) => {
      if (sql.includes('circl.retention_purge')) declared = true;

      return Promise.resolve(0);
    },
  };

  return { database, calls, deleted, truncations };
};

const service = (database: unknown) =>
  new AuditChainService(database as never, { forgetTip: () => undefined } as never);

describe('the six-year audit purge', () => {
  const boundary = at('2032-01-01T00:00:00.000Z');

  it('removes whole sealed stretches, and nothing past the one it may remove', async () => {
    const { database, deleted, truncations } = stub(
      [
        {
          id: 'one',
          seq: 1n,
          hash: 'aaa',
          fromOccurredAt: at('2025-01-01T00:00:00.000Z'),
          toOccurredAt: at('2025-01-02T00:00:00.000Z'),
        },
        {
          id: 'two',
          seq: 2n,
          hash: 'bbb',
          fromOccurredAt: at('2025-01-02T00:00:00.000Z'),
          toOccurredAt: at('2031-12-31T00:00:00.000Z'),
        },
        {
          id: 'three',
          seq: 3n,
          hash: 'ccc',
          fromOccurredAt: at('2031-12-31T00:00:00.000Z'),
          toOccurredAt: at('2032-06-01T00:00:00.000Z'),
        },
      ],
      [at('2025-01-01T12:00:00.000Z'), at('2030-01-01T00:00:00.000Z')],
    );
    const result = await service(database).purge(boundary);

    // The newest stretch that ends before the boundary — not the boundary itself, because the
    // stretch that straddles it is removed whole or not at all.
    expect(deleted.upTo).toEqual(at('2031-12-31T00:00:00.000Z'));
    expect(result.segments).toBe(2);
    expect(result.rows).toBe(2);
    expect(truncations[0]).toMatchObject({
      removedHash: 'bbb',
      upToOccurredAt: at('2031-12-31T00:00:00.000Z'),
      segmentsRemoved: 2,
      rowsRemoved: 2,
    });
  });

  it('records what it removed before it removes it, so the chain is never short of its reason', async () => {
    const { database, calls } = stub(
      [
        {
          id: 'one',
          seq: 1n,
          hash: 'aaa',
          fromOccurredAt: at('2025-01-01T00:00:00.000Z'),
          toOccurredAt: at('2025-01-02T00:00:00.000Z'),
        },
      ],
      [at('2025-01-01T12:00:00.000Z')],
    );

    await service(database).purge(boundary);

    expect(calls).toEqual(['entries(purging)', 'truncation', 'segments(purging)']);
  });

  /**
   * The one that would be a silent catastrophe.
   *
   * The append-only trigger refuses a DELETE unless the transaction has declared itself a purge.
   * If this job stopped declaring, every delete would throw, the run would be FAILED, and that is
   * loud. The real risk is the opposite: declaring it outside a transaction, where on a pooled
   * connection it would leave the *next* request able to delete audit rows. Hence `SET LOCAL`, and
   * hence this: the declaration and the delete are in one transaction, and the delete is after it.
   */
  it('declares itself a purge inside the transaction that deletes', async () => {
    const { database, calls } = stub(
      [
        {
          id: 'one',
          seq: 1n,
          hash: 'aaa',
          fromOccurredAt: at('2025-01-01T00:00:00.000Z'),
          toOccurredAt: at('2025-01-02T00:00:00.000Z'),
        },
      ],
      [at('2025-01-01T12:00:00.000Z')],
    );

    await service(database).purge(boundary);

    expect(calls.filter(call => call.includes('undeclared'))).toEqual([]);
  });

  it('reaches only as far as the chain starts when no stretch is old enough', async () => {
    const { database, deleted, truncations } = stub(
      [
        {
          id: 'one',
          seq: 1n,
          hash: 'aaa',
          // Sealed from before the boundary, ending after it: the rows inside are protected, the
          // ones below the start are covered by nothing and go.
          fromOccurredAt: at('2031-06-01T00:00:00.000Z'),
          toOccurredAt: at('2033-01-01T00:00:00.000Z'),
        },
      ],
      [at('2030-01-01T00:00:00.000Z')],
    );
    const result = await service(database).purge(boundary);

    expect(deleted.upTo).toEqual(at('2031-06-01T00:00:00.000Z'));
    expect(result.segments).toBe(0);
    expect(result.removedHash).toBeNull();
    // Nothing was removed from the chain, so there is nothing to explain.
    expect(truncations).toEqual([]);
  });

  it('purges to the boundary when nothing has been sealed at all', async () => {
    const { database, deleted } = stub([], [at('2030-01-01T00:00:00.000Z')]);

    await service(database).purge(boundary);

    expect(deleted.upTo).toEqual(boundary);
  });

  /**
   * The ordinary case, and the one the first version got wrong.
   *
   * A chain sealed for the first time last week starts *after* a six-year boundary. Reaching "as
   * far as the chain starts" then means reaching into last week, so the bound has to be the
   * earlier of the two — and the rows below the chain that are past their six years still go.
   */
  it('still purges past the boundary when the chain itself began after it', async () => {
    const { database, deleted, truncations } = stub(
      [
        {
          id: 'one',
          seq: 1n,
          hash: 'aaa',
          fromOccurredAt: at('2032-06-01T00:00:00.000Z'),
          toOccurredAt: at('2032-06-02T00:00:00.000Z'),
        },
      ],
      [at('2020-01-01T00:00:00.000Z'), at('2032-07-01T00:00:00.000Z')],
    );
    const result = await service(database).purge(boundary);

    expect(deleted.upTo).toEqual(boundary);
    // The backdated entry goes; the one from after the boundary is not in reach.
    expect(result.rows).toBe(1);
    expect(result.segments).toBe(0);
    expect(truncations).toEqual([]);
  });
});
