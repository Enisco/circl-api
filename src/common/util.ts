import * as bcrypt from 'bcryptjs';
import { ulid } from 'ulid';
import { v4 as uuidv4 } from 'uuid';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { fixedOtp } from './constants/dev-otp.constant';

export class Util {
  static generateHash = async (plainText: string): Promise<string> => {
    const salt = await bcrypt.genSalt(10);

    return await bcrypt.hash(plainText, salt);
  };

  static validateHash = async (plainText: string, hash: string): Promise<boolean> => {
    return bcrypt.compare(plainText, hash);
  };

  /**
   * SHA-256 hex, for secrets that are already random.
   *
   * Not interchangeable with `generateHash`: bcrypt is for things a person chose, where slowness
   * is the point. For a token the server generated, slowness buys nothing — and bcrypt actively
   * breaks it, because bcrypt reads only the first 72 bytes. Two refresh JWTs for the same session
   * share a header and the start of their payload, so they agreed on those 72 bytes and an old
   * token kept validating after rotation had supposedly replaced it (B3).
   */
  static tokenHash = (token: string): string =>
    createHash('sha256').update(token, 'utf8').digest('hex');

  /** Compares two hex digests without leaking, through timing, how much of one was right. */
  static hashesMatch = (a: string | null | undefined, b: string | null | undefined): boolean => {
    if (!a || !b || a.length !== b.length) return false;

    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  };

  static randomBytes = (len = 16) => {
    return randomBytes(len).toString('hex');
  };

  static generateOtp(length = 6): string {
    // Outside production, a known code — there is no mail provider yet, so a random one is a code
    // nobody can read. Deliberately here, where the code is *made*, rather than as a branch in the
    // comparison: see `dev-otp.constant.ts`.
    const fixed = fixedOtp(length);

    if (fixed) return fixed;

    const digits = '0123456789';
    let otp = '';
    const bytes = randomBytes(length);

    for (let i = 0; i < length; i++) {
      otp += digits[bytes[i] % 10];
    }

    return otp;
  }

  static generateUlid = (prefix?: string) => {
    return `${prefix ? prefix + '-' : ''}${ulid()}`;
  };

  static generateUuid = () => uuidv4();

  static isEmpty = (value: unknown): boolean => {
    return (
      value === null ||
      value === undefined ||
      (typeof value === 'object' && Object.keys(value).length === 0) ||
      (typeof value === 'string' && value === '' && value.trim().length === 0)
    );
  };

  static randomCode = (len = 6) => {
    return Math.random()
      .toString(36)
      .slice(2, 2 + len);
  };

  static randomNumber = (n = 4) => {
    const min = Math.pow(10, n - 1);
    const max = Math.pow(10, n) - 1;

    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  static roundTo = (num: number, nrdecimals: number) => {
    const n = Number(num.toFixed(nrdecimals));

    return n > num ? Number((n - 1 / Math.pow(10, nrdecimals)).toFixed(nrdecimals)) : n;
  };

  static randomFromInterval = (min: number, max: number, precision = 2): number => {
    const random = Math.random() * (max - min) + min;

    return parseFloat(random.toFixed(precision));
  };

  static randomString = (len = 10) => {
    const p = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    return [...Array(len)].reduce(a => a + p[~~(Math.random() * p.length)], '');
  };

  static slugify(str: string): string {
    return str.toLowerCase().replace(/\s+/g, '-');
  }

  static parseDurationToSeconds(input: string): number {
    const normalizedInput = input?.trim();

    if (!normalizedInput) {
      throw new Error('Duration input is required');
    }

    const match = normalizedInput.match(/^(\d+)(ms|s|m|h|d)$/i);

    if (!match) {
      throw new Error(`Unsupported duration format: ${normalizedInput}`);
    }

    const value = Number(match[1]);
    const unit = match[2].toLowerCase();

    const multipliers: Record<string, number> = {
      ms: 1 / 1000,
      s: 1,
      m: 60,
      h: 60 * 60,
      d: 24 * 60 * 60,
    };

    return Math.max(1, Math.floor(value * multipliers[unit]));
  }
}
