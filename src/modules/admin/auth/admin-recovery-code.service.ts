import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'crypto';
import { PrismaService } from '@/infrastructure';
import { AdminPasswordService } from './admin-password.service';

/** Ten codes, ten characters each: about fifty bits, which is plenty for a single-use secret. */
const CODE_COUNT = 10;
const CODE_LENGTH = 10;
/** Crockford-style base32 without the characters people misread: no I, L, O, U, 0 or 1. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

@Injectable()
export class AdminRecoveryCodeService {
  constructor(
    private readonly database: PrismaService,
    private readonly passwords: AdminPasswordService,
  ) {}

  /**
   * Issues a fresh set and invalidates whatever came before.
   *
   * Returns the codes in the clear exactly once — this is the only moment they exist outside
   * somebody's notebook. Stored as argon2id hashes, because that is what they are: a credential
   * that gets written down and photographed.
   */
  async issue(userId: string, tx?: Prisma.TransactionClient): Promise<string[]> {
    const client = tx ?? this.database;
    const codes = Array.from({ length: CODE_COUNT }, () => this.generate());

    await client.adminRecoveryCode.deleteMany({ where: { userId } });
    await client.adminRecoveryCode.createMany({
      data: await Promise.all(
        codes.map(async code => ({ userId, codeHash: await this.passwords.hash(this.normalise(code)) })),
      ),
    });

    return codes;
  }

  /**
   * Spends a code if it matches an unused one.
   *
   * Compared against each unused hash in turn rather than looked up: a hash cannot be searched
   * for. Ten argon2 verifications is slow by design, and this path is rate-limited, so the cost is
   * the point rather than a problem.
   */
  async consume(userId: string, presented: string): Promise<boolean> {
    const candidate = this.normalise(presented);

    if (!candidate) return false;

    const unused = await this.database.adminRecoveryCode.findMany({
      where: { userId, usedAt: null },
      select: { id: true, codeHash: true },
    });

    for (const row of unused) {
      if (!(await this.passwords.verify(row.codeHash, candidate))) continue;

      // Conditional on still being unused, so two simultaneous attempts cannot both spend it.
      const spent = await this.database.adminRecoveryCode.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });

      return spent.count === 1;
    }

    return false;
  }

  async remainingCount(userId: string): Promise<number> {
    return this.database.adminRecoveryCode.count({ where: { userId, usedAt: null } });
  }

  /** `XXXXX-XXXXX`: the hyphen is for reading it off paper, and is optional on the way back in. */
  private generate(): string {
    const body = Array.from(
      { length: CODE_LENGTH },
      () => ALPHABET[randomInt(ALPHABET.length)],
    ).join('');

    return `${body.slice(0, 5)}-${body.slice(5)}`;
  }

  /**
   * Codes are matched however they were typed: upper or lower case, hyphen or not. Somebody
   * reading one off a photograph at a bad moment should not be refused over punctuation.
   */
  private normalise(code: string): string {
    return code.replace(/[^0-9a-z]/gi, '').toUpperCase();
  }
}
