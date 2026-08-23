import { Injectable } from '@nestjs/common';
import { TrustCheckStatus, TrustCheckType } from '@prisma/client';
import { PrismaService } from '@/infrastructure';

export interface TrustCheckView {
  check: TrustCheckType;
  status: TrustCheckStatus;
  verifiedAt?: string;
  submittedAt?: string;
  expiresAt?: string;
  documentType?: string;
  categoryCode?: string;
  checkedBy?: string;
  reference?: string;
  rejectionReason?: string;
}

/**
 * `GET /api/v1/verification/status` (2.7.1).
 *
 * Verification does not ship in this release (D13, and confirmed by the product
 * owner). This endpoint ships anyway, returning every check as NOT_STARTED apart
 * from EMAIL, which is granted at signup — so the next release adds a flow rather
 * than a data model, and every surface that reads trust today reads the same
 * record it will read then.
 *
 * The three submit endpoints (identity, right to work, credential) are
 * deliberately not built. Their contract is in 2.7 of the spec.
 *
 * Paths are under /verification, not under Professionals, because trust checks
 * belong to the person (2.1.4). A member who verified their identity to use
 * Connect has verified their identity, full stop.
 */
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

      if (!row) return { check, status: TrustCheckStatus.NOT_STARTED };

      return {
        check,
        status: row.status,
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

  /**
   * The trust block on a professional profile (2.4).
   *
   * Each check carries its own provenance: who checked it and when. A trust chip
   * with no provenance is decoration. In this release that means exactly one
   * chip, EMAIL — the client renders one chip rather than an empty row pretending
   * to be a full one (D13).
   */
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

  /**
   * Granted at signup and never re-verified (2.1.1). Called from the auth flow
   * when an email is confirmed.
   */
  async grantEmailCheck(userId: string): Promise<void> {
    // findFirst-then-write rather than upsert: the table's unique key includes
    // the nullable `categoryCode` (credentials are scoped per profession), and
    // Postgres treats those NULLs as distinct, so an upsert on it would never
    // match an existing unscoped row.
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
      // A concurrent signup path may have written it between the read and the
      // write. Losing that race is fine; the row exists either way.
      .catch(() => undefined);
  }
}
