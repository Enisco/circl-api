import { AuditDigestInput, canonicalJson, rowDigest, segmentHash } from '../audit-digest.util';

/**
 * The digests, which have to mean the same thing in two places years apart: once on the write path
 * from the draft, and once in the verification job from the row Postgres hands back.
 *
 * So most of these are about the round trip rather than about hashing. The failure they exist to
 * catch is not "the hash is wrong" — any digest is self-consistent — it is a digest that changes
 * for a reason that is not somebody editing the trail, because that reads as tampering and sends
 * an engineer looking for an attacker who was never there.
 */
const entry = (over: Partial<AuditDigestInput> = {}): AuditDigestInput => ({
  id: '11111111-1111-1111-1111-111111111111',
  occurredAt: new Date('2026-10-13T09:00:00.000Z'),
  actorId: '22222222-2222-2222-2222-222222222222',
  actorRole: 'super_admin',
  action: 'member.suspended',
  area: 'MEMBERS',
  targetType: 'USER',
  targetId: '33333333-3333-3333-3333-333333333333',
  before: { status: 'ACTIVE' },
  after: { status: 'SUSPENDED' },
  reasonCode: 'POLICY_VIOLATION',
  metadata: { duration: '7d' },
  ip: '203.0.113.4',
  ...over,
});

describe('canonical JSON', () => {
  it('sorts keys, so two objects with the same contents are one digest', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('treats an absent field and a null field alike, because the column cannot tell them apart', () => {
    expect(canonicalJson({ a: 1, b: null })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('keeps array order, which is part of the content', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('writes a Date as the ISO string the driver stores it as', () => {
    expect(canonicalJson({ at: new Date('2026-01-01T00:00:00.000Z') })).toBe(
      '{"at":"2026-01-01T00:00:00.000Z"}',
    );
  });

  /**
   * The bug this caught, kept as a test.
   *
   * Prisma stores a `Date` inside a JSON column as `{"$type":"DateTime","value":"<iso>"}` and
   * hands it back that way. The draft side has a real `Date`. Two entries recording a corrected
   * date of birth were sealed, verified, and reported as no longer matching their own digest —
   * which is what tampering looks like, from a driver's spelling.
   */
  it('reads Prisma’s tagged scalars as the value, so a stored Date digests like a Date', () => {
    expect(canonicalJson({ at: { $type: 'DateTime', value: '2026-01-01T00:00:00.000Z' } })).toBe(
      canonicalJson({ at: new Date('2026-01-01T00:00:00.000Z') }),
    );
    expect(canonicalJson({ n: { $type: 'BigInt', value: '42' } })).toBe(canonicalJson({ n: 42n }));
  });

  /**
   * The same trap as the date, for the two other scalars JSON has no type for. A price in a
   * `before`/`after` payload is a `Decimal` going in and `{"$type":"Decimal","value":"1.50"}`
   * coming out, and media keys could be `Bytes`.
   */
  it('digests a Decimal and a Bytes value as the driver stores them', () => {
    const decimal = { toJSON: () => '1.50', toString: () => '1.50' };

    expect(canonicalJson({ price: decimal })).toBe(
      canonicalJson({ price: { $type: 'Decimal', value: '1.50' } }),
    );
    expect(canonicalJson({ blob: Buffer.from('hello') })).toBe(
      canonicalJson({ blob: { $type: 'Bytes', value: Buffer.from('hello').toString('base64') } }),
    );
  });

  it('does not mistake an ordinary two-key object for a tagged one', () => {
    expect(canonicalJson({ $type: 1, value: 2 })).toBe('{"$type":1,"value":2}');
    expect(canonicalJson({ type: 'DateTime', value: 'x' })).toBe('{"type":"DateTime","value":"x"}');
  });

  it('writes a number the one way both sides of the round trip write it', () => {
    expect(canonicalJson({ n: 1.5 })).toBe('{"n":1.5}');
    expect(canonicalJson({ n: 1e21 })).toBe('{"n":1e+21}');
  });

  it('survives unicode and a quote without changing shape', () => {
    expect(canonicalJson({ name: 'Zoë "the" O’Brien' })).toBe(
      JSON.stringify({ name: 'Zoë "the" O’Brien' }),
    );
  });
});

describe('a row’s digest', () => {
  it('is the same for the draft and for the row read back, including JSON key order', () => {
    const written = rowDigest(entry());
    const readBack = rowDigest(
      entry({
        // What Postgres gives back: jsonb has reordered the keys, and the fields the draft left
        // unset are explicit nulls.
        before: { status: 'ACTIVE' },
        after: { status: 'SUSPENDED' },
        metadata: { duration: '7d' },
        actorSessionId: null,
        targetLabel: null,
        policySubtype: null,
        reason: null,
        userAgent: null,
        requestId: null,
        idempotencyKey: null,
      }),
    );

    expect(readBack).toBe(written);
  });

  it('is 64 hex characters, which is what the column holds', () => {
    expect(rowDigest(entry())).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['the action', { action: 'member.reactivated' }],
    ['the actor', { actorId: '44444444-4444-4444-4444-444444444444' }],
    ['the target', { targetId: '55555555-5555-5555-5555-555555555555' }],
    ['the reason', { reasonCode: 'SPAM' }],
    ['what changed', { after: { status: 'ACTIVE' } }],
    ['the timestamp', { occurredAt: new Date('2026-10-13T09:00:00.001Z') }],
    ['the id', { id: '66666666-6666-6666-6666-666666666666' }],
    ['who it was recorded against', { ip: '203.0.113.5' }],
  ])('changes when %s changes', (_what, over) => {
    expect(rowDigest(entry(over))).not.toBe(rowDigest(entry()));
  });
});

describe('a segment’s hash', () => {
  it('covers the previous segment, so a link cannot be re-pointed', () => {
    expect(segmentHash('aa', ['one', 'two'])).not.toBe(segmentHash('bb', ['one', 'two']));
  });

  it('covers the order of the rows in it', () => {
    expect(segmentHash(null, ['one', 'two'])).not.toBe(segmentHash(null, ['two', 'one']));
  });

  /**
   * The count is in the hash for this case alone.
   *
   * Without it, "ab" + "c" and "a" + "bc" hash alike, which means the boundary between two
   * segments could be moved to swallow a deleted row and nothing would notice. A chain whose cuts
   * can be re-made is not a chain.
   */
  it('covers how many rows there were, so the boundary cannot be re-cut', () => {
    expect(segmentHash(null, ['a', 'b'])).not.toBe(segmentHash(null, ['a\nb']));
  });

  /**
   * The genesis is written as an empty predecessor, and that is safe rather than overlooked: a
   * real `prevHash` is sixty-four hex characters, so no segment in the chain can ever present the
   * empty string and be mistaken for the first one.
   */
  it('treats the genesis as an empty predecessor, which no real segment can be', () => {
    expect(segmentHash(null, ['a'])).toBe(segmentHash('', ['a']));
  });
});
