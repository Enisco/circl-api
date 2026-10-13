import { createHash } from 'crypto';

/**
 * The digests S11.3 is built on: one per audit row, chained one per sealed segment.
 *
 * It lives in `common` rather than beside the audit service because the trail has **three**
 * writers: the admin module's `AuditService`, and two member-side paths that must not import admin
 * code — a message escalation (§6.8) and the member data-export job (§13.7), both of which write
 * their row directly. A digest only one of the three computes would leave whole classes of entry
 * uncovered for ever: the segment hash would still catch an edit to one, but nothing would say
 * which row it was.
 *
 * Everything here is pure and synchronous, which is the point — the row digest is computed on the
 * write path of every admin mutation, and the verification job recomputes the same digest from the
 * row Postgres hands back. The two have to agree byte for byte years apart, so the canonical form
 * is written out explicitly rather than left to `JSON.stringify` on an object literal: key order
 * there follows insertion order, and a refactor that moves one field up the object would change
 * every digest from that deploy onward and read as the whole trail being tampered with.
 */

/**
 * **Changing anything in this file invalidates every seal already written.**
 *
 * The canonical form is a wire format with six years of history on the other end of it: a segment
 * sealed last year was hashed over digests computed by *this* code, so a change to how a value is
 * written makes those segments stop verifying — which looks exactly like somebody editing the
 * trail. A deliberate change has to come with a re-seal: drop the segments inside a transaction
 * that declares `circl.retention_purge`, and let `audit.verify-chain` rebuild them from the rows.
 */

/** The fields a row's digest covers. Anything not here is not evidence of what happened. */
export interface AuditDigestInput {
  id: string;
  occurredAt: Date;
  actorId?: string | null;
  actorRole?: string | null;
  actorSessionId?: string | null;
  action: string;
  area: string;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  before?: unknown;
  after?: unknown;
  reasonCode?: string | null;
  policySubtype?: string | null;
  reason?: string | null;
  metadata?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  idempotencyKey?: string | null;
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Anything that knows its own JSON form — `Decimal`, most notably — but is not a plain object. */
const hasJson = (value: unknown): value is { toJSON: () => unknown } =>
  typeof (value as { toJSON?: unknown })?.toJSON === 'function';

/** `{"$type":"DateTime","value":…}` and its siblings: how Prisma spells a scalar JSON cannot hold. */
const isTagged = (value: unknown): value is { $type: string; value: unknown } => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const keys = Object.keys(value);

  return (
    keys.length === 2 &&
    keys.includes('$type') &&
    keys.includes('value') &&
    typeof (value as { $type: unknown }).$type === 'string'
  );
};

/**
 * Canonical JSON: object keys sorted, `undefined` and `null` treated as the same absence.
 *
 * The absence rule exists because of the round trip. A draft field left `undefined` is stored as
 * SQL NULL and comes back as `null`, so a canonical form that distinguished the two would make
 * every row fail its own verification. A `Date` inside `before`/`after` is written as an ISO
 * string by the driver and must be canonicalised the same way here, for the same reason.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === undefined || value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(',')}]`;

  /**
   * Prisma's own tagging, undone.
   *
   * A `Date` inside a JSON column is **stored** as `{"$type":"DateTime","value":"<iso>"}` and comes
   * back in that shape, because Prisma's protocol tags the scalars JSON has no type for. The draft
   * side has a real `Date`, so without this the two forms disagree and every entry carrying a date
   * — a corrected date of birth, for instance — fails its own digest and reads as tampered with.
   * Found exactly that way: two entries in a sealed stretch, both `member.updated` on
   * `dateOfBirth`.
   *
   * Unwrapped to the value rather than hashed as the wrapper, so the digest is about the instant
   * and not about how a driver version chose to spell it.
   */
  if (isTagged(value)) return canonicalJson(value.value);

  /**
   * The other scalars JSON cannot hold, written the way the driver writes them.
   *
   * `Decimal` is tagged `{"$type":"Decimal","value":"1.50"}` and `Bytes` as base64, so a price or a
   * key in a `before`/`after` payload has the same two forms a date had — a real object going in and
   * a tagged string coming out. Bytes needs its own line because `Buffer.toJSON()` is
   * `{type:'Buffer',data:[…]}`, which is not what is stored; everything else with a `toJSON`,
   * `Decimal` included, already produces the string inside the tag.
   */
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString('base64'));
  if (hasJson(value)) return canonicalJson(value.toJSON());

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // Sorted by key, so two objects with the same contents in a different order are one digest.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      // An absent field and a field set to null are the same fact, and jsonb does not record which
      // one the caller wrote.
      .filter(([, entry]) => entry !== undefined && entry !== null)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);

    return `{${entries.join(',')}}`;
  }

  // Numbers go through `JSON.stringify` rather than `String`, so `1e21` is written the one way
  // both sides of the round trip write it.
  return JSON.stringify(value);
};

/**
 * One row's digest.
 *
 * The field list is written out in a fixed order and read by name, so it is independent of how
 * either the draft object or the Prisma row happens to be shaped.
 */
export const rowDigest = (row: AuditDigestInput): string =>
  sha256(
    canonicalJson({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      actorId: row.actorId,
      actorRole: row.actorRole,
      actorSessionId: row.actorSessionId,
      action: row.action,
      area: row.area,
      targetType: row.targetType,
      targetId: row.targetId,
      targetLabel: row.targetLabel,
      before: row.before,
      after: row.after,
      reasonCode: row.reasonCode,
      policySubtype: row.policySubtype,
      reason: row.reason,
      metadata: row.metadata,
      ip: row.ip,
      userAgent: row.userAgent,
      requestId: row.requestId,
      idempotencyKey: row.idempotencyKey,
    }),
  );

/**
 * One segment's hash: the previous segment's hash, then every row digest in the range.
 *
 * Joined with a newline and prefixed with the count. The count is in the hash because without it
 * two different splits of the same rows could produce the same string — a chain whose boundaries
 * can be moved without detection is a chain that can be re-cut around a deleted row.
 */
export const segmentHash = (prevHash: string | null, digests: string[]): string =>
  sha256([prevHash ?? '', String(digests.length), ...digests].join('\n'));
