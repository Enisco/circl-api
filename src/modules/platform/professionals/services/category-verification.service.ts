import { Injectable } from '@nestjs/common';
import {
  CategoryVerification,
  CategoryVerificationStatus,
  NotificationKind,
  Prisma,
  TaxonomyKind,
} from '@prisma/client';
import { ApiErrorCode, ApiException } from '@/common';
import { PrismaService } from '@/infrastructure';
import { LISTING_ROUTE, ListingDocumentService, TaxonomyService } from '@/modules/platform/shared';
import { NotificationFeedService } from '../../notifications';
import { SubmitVerificationDto } from '../dtos/verification.dto';

/** The owner a verification's documents attach to. Not the listing: the record is the person's. */
export const VERIFICATION_DOCUMENT_OWNER = 'CATEGORY_VERIFICATION';

/** §2.4: one to five files, the same as the listing documents this reuses. */
export const MAX_VERIFICATION_DOCUMENTS = 5;

/** What the member is told, rather than a reviewer's name (v2 §2.5). */
export const CHECKED_BY = 'Circl Trust & Safety';

/** The word for a record that does not exist. One vocabulary rather than a null and five strings. */
export const NOT_SUBMITTED = 'NOT_SUBMITTED' as const;

/** Every answer the gate can give about a professional and a category. */
export type VerificationState = CategoryVerificationStatus | typeof NOT_SUBMITTED;

/** What the gate decided, and enough to say why (v2 §5.4). */
export interface GateDecision {
  /** Whether this category or subcategory needs a verification at all. */
  gated: boolean;
  categoryCode: string;
  subcategoryCode: string | null;
  status: VerificationState;
  /** True only for `APPROVED`, or for work that is not gated. Anything else is not permission. */
  mayPublish: boolean;
  /** The reviewer's words, for a decline the member has to be able to act on. */
  note: string | null;
}

/**
 * Category verification: did a reviewer read this person's documents for this field of work (§2).
 *
 * **One record per `(professional, category)`.** That is the structural change of v2, and
 * everything else follows from it: one approval covers every service that professional ever lists
 * in that category, a service's blocked-ness is *derived* from this record rather than stored
 * beside it, and approving a category publishes every waiting service in it at once.
 *
 * Keyed on the **user**, not the listing. A licence check belongs to the person who holds the
 * licence: it survives a profile being rebuilt, it can be submitted before the category is even on
 * their profile (§2.4), and it is independent of which categories they currently display (§2.6).
 *
 * Never confused with `TrustCheck`. That asks whether somebody is who they say they are; this asks
 * whether they may practise in one field. A member verified for Immigration who also sells web
 * design must not appear to have had the web design checked.
 */
@Injectable()
export class CategoryVerificationService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly documents: ListingDocumentService,
    private readonly notifications: NotificationFeedService,
  ) {}

  // ─── The gate ──────────────────────────────────────────────────────────────

  /**
   * Whether this category or subcategory needs a verification (§3.2).
   *
   * > A service requires verification **iff** its subcategory has `requiresVerification: true`,
   * > or — where the service has no subcategory — its category does.
   *
   * Computed here on every write even though the client computes it too. The client's copy is a
   * latency optimisation so a chip can be locked without a round trip; it is never the boundary. A
   * stale build, a replayed request or a modified client must not be able to publish into
   * regulated work.
   */
  async isGated(categoryCode: string, subcategoryCode?: string | null): Promise<boolean> {
    if (subcategoryCode) {
      const child = await this.taxonomy.get(TaxonomyKind.PROFESSION_SUBCATEGORY, subcategoryCode);

      return requiresVerification(child?.metadata);
    }

    const category = await this.taxonomy.get(TaxonomyKind.PROFESSION, categoryCode);

    return requiresVerification(category?.metadata);
  }

  /**
   * What a professional may do in one category, with the reason attached.
   *
   * The one place that decides, so the service writer, the service reader and the admin portal all
   * read the same answer. An **unknown status is not permission**: a state that shipped after this
   * build is one it must not treat as approved, and that is the direction to be wrong in.
   */
  async gate(
    userId: string,
    categoryCode: string,
    subcategoryCode?: string | null,
  ): Promise<GateDecision> {
    const gated = await this.isGated(categoryCode, subcategoryCode);
    const record = await this.database.categoryVerification.findUnique({
      where: { userId_categoryCode: { userId, categoryCode } },
      select: { status: true, decisionNote: true, expiresAt: true },
    });
    /**
     * A lapsed approval is **not** permission, whatever the column still says.
     *
     * `verifications.expire` flips the stored status nightly, and this does not wait for it: an
     * approval that ran out at midnight must stop publishing at midnight rather than at three in
     * the morning. The job exists so the reviewer's queue and the member's own screen agree with
     * the gate — not as the thing that enforces it.
     */
    const status: VerificationState = record ? effectiveStatus(record) : NOT_SUBMITTED;

    return {
      gated,
      categoryCode,
      subcategoryCode: subcategoryCode ?? null,
      status,
      mayPublish: !gated || status === CategoryVerificationStatus.APPROVED,
      note: record?.decisionNote ?? null,
    };
  }

  /**
   * Refuses the write where the category is gated and the professional has no live submission.
   *
   * `PENDING` is **not** a refusal (§5.5): the service is created and sits invisible until a
   * reviewer gets to it. The four states that are refused are the ones where nothing is in
   * progress — never submitted, declined, revoked, expired — because in each of those the only way
   * forward is for the member to submit documents.
   */
  async assertMayWrite(
    userId: string,
    categoryCode: string,
    subcategoryCode?: string | null,
  ): Promise<GateDecision> {
    const decision = await this.gate(userId, categoryCode, subcategoryCode);

    if (!decision.gated) return decision;
    if (
      decision.status === CategoryVerificationStatus.APPROVED ||
      decision.status === CategoryVerificationStatus.PENDING
    ) {
      return decision;
    }

    throw ApiException.forbidden(
      ApiErrorCode.VERIFICATION_REQUIRED,
      'This kind of work is regulated, so it has to be verified before you can offer it. Send us your registration or licence and we will check it.',
      {
        // In `data`, never in `details` (§5.5): the client reads this in preference to the category
        // on the form, because on an edit the one being objected to need not be the one on screen.
        data: {
          categoryCode: decision.categoryCode,
          subcategoryCode: decision.subcategoryCode,
          verificationStatus: decision.status,
          note: decision.note,
        },
      },
    );
  }

  // ─── Submitting ────────────────────────────────────────────────────────────

  /**
   * Submits, or resubmits, documents for one category (§2.4).
   *
   * Deliberately independent of everything else: it does **not** require a listing to hold the
   * category, and it does not require a service to exist in it. A professional should be able to
   * get approved ahead of needing it, which is also what makes "categories are freely editable"
   * safe — holding a category grants nothing, only this does.
   *
   * The same call is how a resubmission works. The previous documents are superseded rather than
   * deleted, so the record of what a decision was made on survives the next submission (§2.9's
   * ninety-day retention, which already does this for listing documents).
   */
  async submit(userId: string, dto: SubmitVerificationDto): Promise<CategoryVerification> {
    const category = await this.taxonomy.get(TaxonomyKind.PROFESSION, dto.categoryCode);

    if (!category) {
      throw ApiException.unprocessable(
        ApiErrorCode.UNKNOWN_TAXONOMY_CODE,
        'That is not a category we know.',
        { details: [{ field: 'categoryCode', message: 'Unknown category.' }] },
      );
    }

    if (!category.isActive) {
      throw ApiException.unprocessable(
        ApiErrorCode.CATEGORY_RETIRED,
        `${category.label} is no longer offered, so there is nothing to verify for it.`,
        { details: [{ field: 'categoryCode', message: 'This category has been retired.' }] },
      );
    }

    await this.assertChildren(dto.categoryCode, dto.subcategoryCodes ?? []);

    const existing = await this.database.categoryVerification.findUnique({
      where: { userId_categoryCode: { userId, categoryCode: dto.categoryCode } },
    });

    if (existing?.status === CategoryVerificationStatus.PENDING) {
      throw ApiException.conflict(
        ApiErrorCode.VERIFICATION_ALREADY_PENDING,
        'We already have your documents for this and a reviewer is looking at them.',
        { data: { categoryCode: dto.categoryCode, submittedAt: existing.submittedAt } },
      );
    }

    // `effectiveStatus`, not the column: a licence that has run out is exactly the case a
    // resubmission is for, and refusing it with "there is nothing to submit" would strand them.
    if (existing && effectiveStatus(existing) === CategoryVerificationStatus.APPROVED) {
      throw ApiException.conflict(
        ApiErrorCode.VERIFICATION_ALREADY_APPROVED,
        'You are already verified for this. There is nothing to submit.',
        { data: { categoryCode: dto.categoryCode, decidedAt: existing.decidedAt } },
      );
    }

    // Validated and content-checked before anything is written, so a refusal half way through
    // cannot leave documents attached to a submission that does not exist (§5.9's rule).
    const ids = this.documents.assertCount({
      documentIds: dto.documentIds,
      needsApproval: true,
      field: 'documentIds',
    });
    const prepared = await this.documents.prepare({
      documentIds: ids,
      uploaderId: userId,
      listingId: existing?.id,
      field: 'documentIds',
    });

    return this.database.$transaction(async tx => {
      const record = await tx.categoryVerification.upsert({
        where: { userId_categoryCode: { userId, categoryCode: dto.categoryCode } },
        create: {
          userId,
          categoryCode: dto.categoryCode,
          status: CategoryVerificationStatus.PENDING,
          submittedForSubcategories: dto.subcategoryCodes ?? [],
          note: dto.note ?? null,
        },
        update: {
          status: CategoryVerificationStatus.PENDING,
          submittedForSubcategories: dto.subcategoryCodes ?? [],
          note: dto.note ?? null,
          submittedAt: new Date(),
          // The previous decision goes with the previous submission: a record that kept a decline
          // beside a pending resubmission would show a member the old reason as if it still stood.
          decidedAt: null,
          decidedById: null,
          decisionNote: null,
          licenceSeen: null,
          checkedBy: null,
          expiresAt: null,
        },
      });

      /**
       * The documents already on the record are superseded, not deleted.
       *
       * §2.9's ninety days: an appeal has to be about the evidence that was actually looked at, so
       * the files that informed the last decision stay attached and stop being the current
       * submission. `retention.purge-documents` removes them when the window closes.
       */
      await tx.media.updateMany({
        where: {
          ownerType: VERIFICATION_DOCUMENT_OWNER,
          ownerId: record.id,
          supersededAt: null,
          id: { notIn: prepared.map(file => file.id) },
        },
        data: { supersededAt: new Date() },
      });

      await Promise.all(
        prepared.map((file, index) =>
          tx.media.update({
            where: { id: file.id },
            data: {
              ownerType: VERIFICATION_DOCUMENT_OWNER,
              ownerId: record.id,
              position: index,
              attachedAt: new Date(),
              expiresAt: null,
            },
          }),
        ),
      );

      return record;
    });
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  /** Every record, all states, with their documents. The owner's own view (§2.5). */
  async forOwner(userId: string): Promise<Array<CategoryVerification & { documentCount: number }>> {
    const records = await this.database.categoryVerification.findMany({
      where: { userId },
      orderBy: { submittedAt: 'desc' },
    });

    if (!records.length) return [];

    const counts = await this.database.media.groupBy({
      by: ['ownerId'],
      where: {
        ownerType: VERIFICATION_DOCUMENT_OWNER,
        ownerId: { in: records.map(record => record.id) },
        supersededAt: null,
      },
      _count: { _all: true },
    });
    const byId = new Map(counts.map(row => [row.ownerId, row._count._all]));

    return records.map(record => ({ ...record, documentCount: byId.get(record.id) ?? 0 }));
  }

  /** The documents on one record, for its owner or a reviewer. Never a URL (§2.4). */
  async documentsFor(verificationId: string) {
    return this.database.media.findMany({
      where: {
        ownerType: VERIFICATION_DOCUMENT_OWNER,
        ownerId: verificationId,
        supersededAt: null,
      },
      orderBy: { position: 'asc' },
      select: { id: true, fileName: true, mimeType: true, byteSize: true, pageCount: true },
    });
  }

  /**
   * What a visitor may know: the approved categories, and nothing else (§2.5).
   *
   * A pending or declined verification is private to its owner. Somebody learning that a
   * professional was declined is a disclosure we have no right to make, and one that would be read
   * as a warning about the person rather than as the absence of a decision.
   */
  async approvedFor(userIds: string[]): Promise<Map<string, CategoryVerification[]>> {
    if (!userIds.length) return new Map();

    const rows = await this.database.categoryVerification.findMany({
      // Live approvals only. A chip saying somebody is verified when their registration ran out
      // last month is the one claim on this screen that has to be true.
      where: { userId: { in: userIds }, ...liveApproval() },
      orderBy: { decidedAt: 'desc' },
    });
    const byUser = new Map<string, CategoryVerification[]>();

    for (const row of rows) {
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
    }

    return byUser;
  }

  /** Which of these categories the professional is approved for. Used by the service reader. */
  async approvedCategories(userId: string): Promise<Set<string>> {
    const rows = await this.database.categoryVerification.findMany({
      where: { userId, ...liveApproval() },
      select: { categoryCode: true },
    });

    return new Set(rows.map(row => row.categoryCode));
  }

  /** Every state, by category, for a professional. One query behind the service list's statuses. */
  async statesFor(userId: string): Promise<Map<string, GateDecision['status']>> {
    const rows = await this.database.categoryVerification.findMany({
      where: { userId },
      select: { categoryCode: true, status: true, expiresAt: true },
    });

    return new Map(rows.map(row => [row.categoryCode, effectiveStatus(row)]));
  }

  /** The notes, by category, so a blocked service can carry the reviewer's words. */
  async notesFor(userId: string): Promise<Map<string, string | null>> {
    const rows = await this.database.categoryVerification.findMany({
      where: { userId },
      select: { categoryCode: true, decisionNote: true },
    });

    return new Map(rows.map(row => [row.categoryCode, row.decisionNote]));
  }

  // ─── Lapsing ───────────────────────────────────────────────────────────────

  /**
   * Lapses approvals whose renewal date has passed (`verifications.expire`).
   *
   * The gate already treats one as lapsed the moment it runs out, so this job is not what makes a
   * lapsed approval stop working. What it does is make the **stored** status say so, which three
   * screens read directly: the reviewer's queue filters on the column, the member's own
   * verification panel renders it, and the service list derives its status from it. A record that
   * blocks like an expired one while reading `APPROVED` everywhere is the kind of disagreement
   * somebody opens a support thread about.
   *
   * Each member is told once, with the count of what went out of sight with it. A licence that
   * lapsed quietly is a professional wondering why their enquiries stopped.
   */
  async runExpiry(): Promise<number> {
    const due = await this.database.categoryVerification.findMany({
      where: { status: CategoryVerificationStatus.APPROVED, expiresAt: { lte: new Date() } },
      select: { id: true, userId: true, categoryCode: true },
    });

    if (!due.length) return 0;

    const { count } = await this.database.categoryVerification.updateMany({
      where: { id: { in: due.map(row => row.id) } },
      data: { status: CategoryVerificationStatus.EXPIRED },
    });

    const labels = await this.taxonomy.labels(TaxonomyKind.PROFESSION);

    for (const row of due) {
      const label = labels.get(row.categoryCode) ?? row.categoryCode;
      // visibility: the member's own count of their own services, for the notice telling them
      // what went out of sight. Filtering it by public visibility would answer a different
      // question — "how many were visible before this" — and understate what they have lost.
      const affected = await this.database.professionalService.count({
        where: { categoryCode: row.categoryCode, listing: { userId: row.userId, deletedAt: null } },
      });

      this.notifications.raise({
        userId: row.userId,
        kind: NotificationKind.VERIFICATION,
        categoryCode: 'ACCOUNT',
        title: `Your ${label} verification has expired`,
        body: affected
          ? `Send us your current registration to put ${affected === 1 ? 'your service' : `your ${affected} services`} back up.`
          : 'Send us your current registration when you are ready to offer this work again.',
        route: LISTING_ROUTE.view,
      });
    }

    return count;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Every code has to be a child of that category, or the record says something untrue (§2.4). */
  private async assertChildren(categoryCode: string, subcategoryCodes: string[]): Promise<void> {
    for (const code of subcategoryCodes) {
      const child = await this.taxonomy.get(TaxonomyKind.PROFESSION_SUBCATEGORY, code);

      if (
        !child ||
        (child.metadata as { parentCode?: string } | null)?.parentCode !== categoryCode
      ) {
        throw ApiException.unprocessable(
          ApiErrorCode.SUBCATEGORY_MISMATCH,
          'One of those is not a kind of work in that category.',
          {
            details: [
              { field: 'subcategoryCodes', message: `${code} is not under ${categoryCode}.` },
            ],
            data: { categoryCode, subcategoryCode: code },
          },
        );
      }
    }
  }
}

/**
 * The status a record actually has, with its renewal date applied.
 *
 * An approval with a date in the past is `EXPIRED` whether or not the nightly job has reached it
 * yet. Every read of the status goes through here so there is one answer rather than one per
 * caller, which is the same reason the service's own status is derived in one place (§5.4).
 */
export const effectiveStatus = (record: {
  status: CategoryVerificationStatus;
  expiresAt: Date | null;
}): CategoryVerificationStatus =>
  record.status === CategoryVerificationStatus.APPROVED &&
  record.expiresAt &&
  record.expiresAt.getTime() <= Date.now()
    ? CategoryVerificationStatus.EXPIRED
    : record.status;

/**
 * The same rule as a `where`, for the queries that must not return a lapsed approval.
 *
 * A function rather than a constant: `new Date()` in a module-level object is the moment the
 * process booted, so a long-running server would keep serving an approval that lapsed this
 * afternoon.
 */
const liveApproval = (): Prisma.CategoryVerificationWhereInput => ({
  status: CategoryVerificationStatus.APPROVED,
  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
});

/** The gate flag, read defensively: anything other than a literal `true` is not a gate. */
const requiresVerification = (metadata: unknown): boolean =>
  (metadata as { requiresVerification?: unknown } | null)?.requiresVerification === true;
