import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { NobleCryptoPlugin, ScureBase32Plugin, generateSecret, generateURI, verify } from 'otplib';

const ISSUER = 'Circl Admin';
/** RFC 6238 defaults, and what every authenticator app assumes: SHA-1, six digits, 30 seconds. */
const DIGITS = 6;
const PERIOD = 30;
/**
 * One step either side, in seconds, for a phone clock that drifts or a code typed as it rolls over.
 * Expressed as a tolerance rather than a step count because that is what the library takes.
 */
const TOLERANCE: [number, number] = [PERIOD, PERIOD];
const SECRET_BYTES = 20;

export interface EncryptedSecret {
  ciphertext: string;
  keyId: string;
}

export interface TotpCheck {
  valid: boolean;
  /** Which 30-second step the code belonged to, so a used one cannot be used again. */
  step: number | null;
}

/**
 * The second factor.
 *
 * Secrets are encrypted at rest with a key that is not in the database, so a dump of the database
 * is not a set of working authenticators. The key id is stored beside each secret, which is what
 * makes rotating the key a background re-encryption rather than a migration that has to decrypt
 * everything at once.
 */
@Injectable()
export class AdminTotpService {
  private readonly base32 = new ScureBase32Plugin();
  private readonly crypto = new NobleCryptoPlugin();
  private readonly key: Buffer;
  private readonly keyId: string;

  constructor(config: ConfigService) {
    this.key = Buffer.from(config.getOrThrow<string>('ADMIN_TOTP_ENC_KEY'), 'base64');
    this.keyId = config.getOrThrow<string>('ADMIN_TOTP_ENC_KEY_ID');
  }

  /** A fresh base32 secret, for enrolment. Never stored in the clear. */
  newSecret(): string {
    return generateSecret({ length: SECRET_BYTES, base32: this.base32, crypto: this.crypto });
  }

  /** The `otpauth://` URI an authenticator app scans. */
  uri(secret: string, email: string): string {
    return generateURI({
      secret,
      label: email,
      issuer: ISSUER,
      digits: DIGITS,
      period: PERIOD,
    });
  }

  /**
   * Checks a code and says which step it came from.
   *
   * The step matters as much as the verdict: a code is valid for thirty seconds, so the same six
   * digits read off a screen can be replayed inside its own window. Recording the step used and
   * refusing anything not later than it closes that (S3.7).
   */
  async check(secret: string, code: string, lastUsedStep: bigint | null): Promise<TotpCheck> {
    const result = await verify({
      secret,
      token: code.replace(/\s/g, ''),
      base32: this.base32,
      crypto: this.crypto,
      digits: DIGITS,
      period: PERIOD,
      epochTolerance: TOLERANCE,
      // The library's own replay bound: any step at or below this is refused. Passing it here
      // rather than comparing afterwards means the check happens inside the window arithmetic,
      // where an off-by-one between "accepted" and "recorded" cannot open a gap.
      ...(lastUsedStep !== null ? { afterTimeStep: Number(lastUsedStep) } : {}),
    }).catch(() => ({ valid: false }) as const);

    if (!result.valid) return { valid: false, step: null };

    return { valid: true, step: (result as { timeStep?: number }).timeStep ?? null };
  }

  /** AES-256-GCM. The IV and tag travel with the ciphertext; none of it is a secret on its own. */
  encrypt(secret: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

    return {
      ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64'),
      keyId: this.keyId,
    };
  }

  decrypt(stored: string): string {
    const raw = Buffer.from(stored, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);

    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}
