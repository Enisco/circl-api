import { createHash } from 'node:crypto';

/**
 * Masking, in one place, for every role (S8.1).
 *
 * Not "for every role except the ones with `members:pii_reveal`". There is one code path, and it
 * masks; the plaintext is served only by `POST admin/members/:id/reveal`, which writes an audit
 * entry naming the fields. The reason is the one thing a permission check cannot give you: a list
 * of two hundred members carries two hundred email addresses past somebody's eyes whether they
 * needed one or not, and an export of it carries them somewhere nobody is watching. Reveal makes
 * looking a deliberate act with a name attached to it.
 *
 * The bullet is U+2022, not an asterisk: a masked value has to be obviously masked at a glance
 * rather than read as a value containing asterisks.
 */
const DOT = '•';

/**
 * `alice@gmail.com` becomes `a{DOT}{DOT}{DOT}@g{DOT}{DOT}{DOT}.com`.
 *
 * The first letter of the mailbox, the first letter of the domain and the public suffix. Enough for
 * a staff member reading a support thread to agree that the address the member quoted is the
 * address on the account, and not enough to write to it.
 *
 * Deliberately a fixed three bullets rather than one per hidden character: the length of an email
 * address is itself identifying when you already hold a list of candidates.
 */
export const maskEmail = (email: string | null | undefined): string => {
  if (!email) return '';

  const at = email.lastIndexOf('@');

  if (at < 1) return `${DOT.repeat(3)}`;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.indexOf('.');
  const maskedDomain =
    dot < 1
      ? `${domain.slice(0, 1)}${DOT.repeat(3)}`
      : `${domain.slice(0, 1)}${DOT.repeat(3)}${domain.slice(dot)}`;

  return `${local.slice(0, 1)}${DOT.repeat(3)}@${maskedDomain}`;
};

/**
 * `+44 7911 123 456` becomes `+44 {DOT}{DOT}{DOT}{DOT} {DOT}{DOT}{DOT} 456`.
 *
 * The last three digits, which is what somebody reads back over the phone to confirm they are
 * talking to the right account, and the dialling code, which is where the member is.
 */
export const maskPhone = (
  diallingCode: string | null | undefined,
  phoneNumber: string | null | undefined,
): string | null => {
  if (!phoneNumber) return null;

  const digits = phoneNumber.replace(/\D/g, '');
  const last = digits.slice(-3);
  const prefix = diallingCode ? `${diallingCode} ` : '';

  return `${prefix}${DOT.repeat(4)} ${DOT.repeat(3)} ${last}`;
};

/**
 * `81.2.69.142` becomes `81.2.69.x` — the /24, which is a network rather than a device.
 *
 * Enough to see that two sessions came from the same place, or that one came from somewhere the
 * member has never been, without recording where a person was sitting. IPv6 keeps its first three
 * groups, which is the routing prefix and nothing of the interface.
 */
export const maskIp = (ip: string | null | undefined): string => {
  if (!ip) return '';

  if (ip.includes(':')) {
    return `${ip.split(':').slice(0, 3).join(':')}:x`;
  }

  const octets = ip.split('.');

  return octets.length === 4 ? `${octets.slice(0, 3).join('.')}.x` : 'x';
};

/**
 * A fingerprint of a contact value, for the `before`/`after` of an edit (S8.4).
 *
 * The audit entry stores the masked forms, which are what a reader needs, plus this — so an
 * investigator holding a candidate address can confirm it was the one without the trail having
 * stored a second copy of everybody's email address in a table nobody rotates.
 */
export const contactHash = (value: string | null | undefined): string | null =>
  value ? createHash('sha256').update(value.trim().toLowerCase()).digest('hex') : null;
