import { Injectable } from '@nestjs/common';
import { TrustCheckStatus, TrustCheckType } from '@prisma/client';
import { PrismaService } from '@/infrastructure';

export interface TrustCheckView {
  check: TrustCheckType;
  status: TrustCheckStatus;
  /** When this check last moved, which is what the Trust Centre row renders under the status. */
  updatedAt: string | null;
  /** Why it needs attention, in words the member can act on. Null unless there is something to say. */
  note: string | null;
  verifiedAt?: string;
  submittedAt?: string;
  expiresAt?: string;
  documentType?: string;
  categoryCode?: string;
  checkedBy?: string;
  reference?: string;
  rejectionReason?: string;
}

/** `GET /api/v1/verification/status` (2.7.1). */
@Injectable()
export class VerificationService {
  /** Every check the app can display, so the stepper renders from data. */
  private static readonly ALL_CHECKS: TrustCheckType[] = [
    TrustCheckType.EMAIL,
    TrustCheckType.IDENTITY,
    TrustCheckType.RIGHT_TO_WORK,
    TrustCheckType.CREDENTIAL,
  ];

  constructor(private readonly database: PrismaService) {}

  async status(userId: string) {
    const held = await this.database.trustCheck.findMany({ where: { userId } });
    const byCheck = new Map(held.map(row => [row.check, row] as const));

    const checks: TrustCheckView[] = VerificationService.ALL_CHECKS.map(check => {
      const row = byCheck.get(check);

      if (!row) {
        return { check, status: TrustCheckStatus.NOT_STARTED, updatedAt: null, note: null };
      }

      return {
        check,
        status: row.status,
        updatedAt: row.updatedAt.toISOString(),
        note: row.rejectionReason ?? null,
        ...(row.verifiedAt ? { verifiedAt: row.verifiedAt.toISOString() } : {}),
        ...(row.submittedAt ? { submittedAt: row.submittedAt.toISOString() } : {}),
        ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
        ...(row.documentType ? { documentType: row.documentType } : {}),
        ...(row.categoryCode ? { categoryCode: row.categoryCode } : {}),
        ...(row.checkedBy ? { checkedBy: row.checkedBy } : {}),
        ...(row.reference ? { reference: row.reference } : {}),
        ...(row.rejectionReason ? { rejectionReason: row.rejectionReason } : {}),
      };
    });

    return {
      checks,
      // No case is open, because no case can be opened in this release.
      case: null,
    };
  }

  /** The verified checks a member holds, for the shared author object (0.9). */
  async verifiedChecks(userId: string): Promise<TrustCheckType[]> {
    const rows = await this.database.trustCheck.findMany({
      where: { userId, status: TrustCheckStatus.VERIFIED },
      select: { check: true },
    });

    return rows.map(row => row.check);
  }

  /** The trust block on a professional profile (2.4). */
  async trustBlock(userId: string) {
    const rows = await this.database.trustCheck.findMany({
      where: { userId, status: TrustCheckStatus.VERIFIED },
      orderBy: { verifiedAt: 'asc' },
    });

    return {
      checks: rows.map(row => ({
        check: row.check,
        verifiedAt: row.verifiedAt?.toISOString() ?? null,
        checkedBy: row.checkedBy ?? 'Circl',
        ...(row.reference ? { reference: row.reference } : {}),
        ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
      })),
    };
  }

  /** Granted at signup and never re-verified (2.1.1). */
  async grantEmailCheck(userId: string): Promise<void> {
    // findFirst-then-write rather than upsert: the table's unique key includes the nullable `categoryCode` (credentials are scoped per profession), and Postgres treats those NULLs as distinct, so an upsert on it would never match an existing unscoped row.
    const existing = await this.database.trustCheck.findFirst({
      where: { userId, check: TrustCheckType.EMAIL, categoryCode: null },
      select: { id: true },
    });

    if (existing) {
      await this.database.trustCheck.update({
        where: { id: existing.id },
        data: { status: TrustCheckStatus.VERIFIED, verifiedAt: new Date() },
      });

      return;
    }

    await this.database.trustCheck
      .create({
        data: {
          userId,
          check: TrustCheckType.EMAIL,
          status: TrustCheckStatus.VERIFIED,
          verifiedAt: new Date(),
          checkedBy: 'Circl',
        },
      })
      // A concurrent signup path may have written it between the read and the write.
      .catch(() => undefined);
  }
}
