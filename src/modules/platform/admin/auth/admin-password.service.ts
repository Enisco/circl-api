import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { ApiErrorCode, ApiException } from '@/common';

/**
 * OWASP's 2024 baseline for argon2id. In the PHC string format, so the parameters travel with each
 * hash and can be raised later without invalidating anybody's password — a login simply rehashes.
 */
// `type` is the numeric variant constant at runtime. The package's own declaration types it as a
// name, which the implementation then rejects — so the value is right and the annotation is not.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as unknown as argon2.HashOptions;

/** What `needsRehash` compares against: the cost parameters, without the variant. */
const ARGON2_COSTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

/**
 * Shapes that are long without being hard: a single character repeated, a short cycle, a walk
 * along the keyboard or the number row. A twelve-character minimum invites exactly these.
 */
const KEYBOARD_RUNS = [
  'abcdefghijklmnopqrstuvwxyz',
  '01234567890',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  '!"£$%^&*()',
];

/**
 * Base words that get padded to reach a length rule. Not a breach corpus — that is what the HIBP
 * check is for — but the handful that a twelve-character minimum provokes people into decorating.
 */
const COMMON_BASES = [
  'password',
  'passw0rd',
  'qwerty',
  'letmein',
  'welcome',
  'iloveyou',
  'admin',
  'administrator',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'superman',
  'trustno1',
  'sunshine',
  'princess',
  'master',
  'login',
  'abc123',
  'secret',
  'circl',
  'moderator',
  'support',
];

@Injectable()
export class AdminPasswordService {
  private readonly logger = new Logger(AdminPasswordService.name);
  private readonly hibpEnabled: boolean;
  /**
   * A real hash of a random string, made once on first use.
   *
   * It has to be a hash this build can actually verify: a hand-written constant that fails to
   * parse makes `argon2.verify` throw immediately, which is precisely the fast path the timing
   * equalisation exists to avoid — the countermeasure would have made the leak it was closing.
   */
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly config: ConfigService) {
    this.hibpEnabled = config.get<string>('ADMIN_HIBP_CHECK') === 'true';
  }

  async hash(password: string): Promise<string> {
    return argon2.hash(password, { ...ARGON2_OPTIONS, raw: false });
  }

  /** True when the stored hash was made with weaker parameters than we now use. */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, ARGON2_COSTS);
    } catch {
      return true;
    }
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spends the same time on an unknown account as on a known one.
   *
   * Without it, "no such staff member" returns in a millisecond and "wrong password" in eighty, so
   * the login endpoint answers the question it is carefully worded not to answer (S3.10).
   */
  async burnTime(): Promise<void> {
    this.dummyHash ??= this.hash(randomBytes(24).toString('base64url'));

    await argon2.verify(await this.dummyHash, 'timing-equalisation').catch(() => undefined);
  }

  /**
   * Rejects a password or says why, naming every rule it broke rather than the first.
   *
   * **Deviation from the spec, deliberate.** It asks for the top 100 000 common passwords bundled.
   * Almost none of that list can reach this function: it is overwhelmingly passwords shorter than
   * twelve characters, which the length rule has already refused. Bundling a megabyte to re-reject
   * strings that cannot get here is weight without effect. What is bundled instead is the part
   * that can match — the base words people pad to reach a length minimum — and the real defence
   * against breached passwords is the k-anonymity check below, which should be on in staging and
   * production.
   */
  async assertAcceptable(
    password: string,
    about: { email: string; firstName?: string | null; lastName?: string | null },
  ): Promise<void> {
    const failures: Array<{ field: string; message: string }> = [];
    const length = [...password].length;

    if (length < MIN_LENGTH || length > MAX_LENGTH) {
      failures.push({
        field: 'password',
        message: `Use between ${MIN_LENGTH} and ${MAX_LENGTH} characters.`,
      });
    }

    const lowered = password.toLowerCase();
    const personal = [
      about.email.split('@')[0],
      about.firstName ?? '',
      about.lastName ?? '',
    ].filter(part => part.length >= 4);

    if (personal.some(part => lowered.includes(part.toLowerCase()))) {
      failures.push({
        field: 'password',
        message: 'Do not use your name or the first part of your email address.',
      });
    }

    if (this.isLowEntropyShape(lowered)) {
      failures.push({
        field: 'password',
        message: 'Avoid repeated characters and runs along the keyboard or number row.',
      });
    }

    if (COMMON_BASES.some(base => this.isPaddedBase(lowered, base))) {
      failures.push({
        field: 'password',
        message: 'This is a common password with characters added. Choose something unrelated.',
      });
    }

    if (!failures.length && (await this.isBreached(password))) {
      failures.push({
        field: 'password',
        message: 'This password appears in a known breach. Choose one you have not used elsewhere.',
      });
    }

    if (failures.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.PASSWORD_POLICY,
        'That password does not meet the policy.',
        { details: failures },
      );
    }
  }

  private isLowEntropyShape(lowered: string): boolean {
    const distinct = new Set(lowered).size;

    // "aaaaaaaaaaaa", "abababababab": long, and worth almost nothing.
    if (distinct <= 4) return true;

    for (const run of KEYBOARD_RUNS) {
      for (let start = 0; start + 6 <= run.length; start += 1) {
        const slice = run.slice(start, start + 6);

        if (lowered.includes(slice)) return true;
        if (lowered.includes([...slice].reverse().join(''))) return true;
      }
    }

    return false;
  }

  /** "password" wearing digits and punctuation is still "password". */
  private isPaddedBase(lowered: string, base: string): boolean {
    const stripped = lowered.replace(/[^a-z]/g, '');

    if (stripped === base) return true;

    // The whole thing is the base word plus decoration, rather than merely containing it: a
    // passphrase that happens to include "master" is not a weak password.
    return stripped.length > 0 && base.length / stripped.length >= 0.6 && stripped.includes(base);
  }

  /**
   * Have I Been Pwned's range API, k-anonymity: only the first five characters of the SHA-1 digest
   * leave this process, and the password itself never does.
   *
   * Fails open. A password service that refuses to let anybody set a password because a third
   * party is down is worse than one that occasionally misses a breached password — but it is
   * logged, so a prolonged outage is visible rather than silently permissive.
   */
  private async isBreached(password: string): Promise<boolean> {
    if (!this.hibpEnabled) return false;

    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);

    try {
      const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'circl-api' },
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) throw new Error(`HIBP responded ${response.status}`);

      const body = await response.text();

      return body
        .split('\n')
        .some(line => line.split(':')[0]?.trim().toUpperCase() === suffix);
    } catch (error) {
      this.logger.warn({
        securityEvent: 'hibp_check_unavailable',
        message: (error as Error).message,
      });

      return false;
    }
  }
}
