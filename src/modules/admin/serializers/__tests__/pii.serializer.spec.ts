import { contactHash, maskEmail, maskIp, maskPhone } from '../pii.serializer';
import { ageBandOf } from '../admin-member.serializer';

const DOT = '•';

/**
 * Masking is the one code path every member list and detail response goes through (S8.1), so these
 * are the assertions that the portal cannot leak a contact detail by accident. Each case is a shape
 * somebody will actually send: an address with a dot in the mailbox, a domain with two suffixes, a
 * number stored with spaces in it, an IPv6 session.
 */
describe('PII masking', () => {
  describe('maskEmail', () => {
    it('keeps the first letter of the mailbox, the first of the domain and the suffix', () => {
      expect(maskEmail('alice@gmail.com')).toBe(`a${DOT.repeat(3)}@g${DOT.repeat(3)}.com`);
    });

    it('hides the length of the mailbox, which is identifying on its own', () => {
      expect(maskEmail('a@gmail.com')).toBe(maskEmail('alexandrina@gmail.com'));
    });

    it('keeps a two-part public suffix whole', () => {
      expect(maskEmail('sam@mail.co.uk')).toBe(`s${DOT.repeat(3)}@m${DOT.repeat(3)}.co.uk`);
    });

    it('does not mistake a dot in the mailbox for the domain', () => {
      expect(maskEmail('first.last@example.test')).toBe(`f${DOT.repeat(3)}@e${DOT.repeat(3)}.test`);
    });

    it('takes the last @, so a quoted address cannot smuggle the domain through', () => {
      expect(maskEmail('a@b@example.test')).toBe(`a${DOT.repeat(3)}@e${DOT.repeat(3)}.test`);
    });

    it('reveals nothing at all for something that is not an address', () => {
      expect(maskEmail('not-an-address')).toBe(DOT.repeat(3));
      expect(maskEmail(null)).toBe('');
    });
  });

  describe('maskPhone', () => {
    it('keeps the dialling code and the last three digits', () => {
      expect(maskPhone('+44', '7911123456')).toBe(`+44 ${DOT.repeat(4)} ${DOT.repeat(3)} 456`);
    });

    it('counts digits, not characters, so stored spacing does not change the answer', () => {
      expect(maskPhone('+44', '7911 123 456')).toBe(maskPhone('+44', '7911123456'));
    });

    it('is null where there is no number, rather than a mask of nothing', () => {
      expect(maskPhone('+44', null)).toBeNull();
      expect(maskPhone(null, null)).toBeNull();
    });
  });

  describe('maskIp', () => {
    it('reduces IPv4 to its /24', () => {
      expect(maskIp('81.2.69.142')).toBe('81.2.69.x');
    });

    it('keeps only the routing prefix of IPv6', () => {
      expect(maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3:x');
    });

    it('gives nothing away about a value it cannot parse', () => {
      expect(maskIp('garbage')).toBe('x');
      expect(maskIp(null)).toBe('');
    });
  });

  describe('contactHash', () => {
    it('is stable across case and surrounding space, so a candidate can be confirmed', () => {
      expect(contactHash(' Alice@Gmail.com ')).toBe(contactHash('alice@gmail.com'));
    });

    it('is null for nothing, rather than the hash of an empty string', () => {
      expect(contactHash(null)).toBeNull();
    });
  });
});

describe('ageBandOf', () => {
  const bands = [
    { code: 'AGE_18_24', minAge: 18, maxAge: 24 },
    { code: 'AGE_25_34', minAge: 25, maxAge: 34 },
    { code: 'AGE_45_PLUS', minAge: 45, maxAge: null },
  ];

  const at = new Date('2026-06-15T00:00:00Z');

  it('places somebody inside a band', () => {
    expect(ageBandOf(new Date('1998-01-01'), bands, at)).toBe('AGE_25_34');
  });

  it('counts a birthday that has not happened yet as the younger age', () => {
    // Turns 25 in December, so on 15 June they are still 24.
    expect(ageBandOf(new Date('2001-12-01'), bands, at)).toBe('AGE_18_24');
  });

  it('counts a birthday today as having happened', () => {
    expect(ageBandOf(new Date('2001-06-15'), bands, at)).toBe('AGE_25_34');
  });

  it('handles the open-ended band', () => {
    expect(ageBandOf(new Date('1950-01-01'), bands, at)).toBe('AGE_45_PLUS');
  });

  it('is null with no birth date, and null for an age no band covers', () => {
    expect(ageBandOf(null, bands, at)).toBeNull();
    // 35–44 is deliberately missing from the list above: a gap in the vocabulary must show as a
    // gap rather than being folded into a neighbouring column.
    expect(ageBandOf(new Date('1986-01-01'), bands, at)).toBeNull();
  });
});
