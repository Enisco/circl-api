import { Injectable } from '@nestjs/common';
import {
  CategoryVerificationStatus,
  ContentVisibilityState,
  Prisma,
  ServiceOwnerState,
  TaxonomyKind,
} from '@prisma/client';
import { ApiErrorCode, ApiException, PageMeta, buildPageMeta } from '@/common';
import { PrismaService } from '@/infrastructure';
import {
  LISTING_ROUTE,
  ListingDocumentService,
  MediaService,
  TaxonomyService,
} from '@/modules/platform/shared';
import { VERIFICATION_DOCUMENT_OWNER } from '@/modules/platform/professionals';
import { AuditService } from '../audit/audit.service';
import { AdminMemberActionService } from './admin-member-action.service';
import { AdminPrincipal } from '../common/admin-principal';
import {
  DecideVerificationDto,
  ListVerificationsDto,
  RevokeVerificationDto,
  SetVerificationExpiryDto,
} from '../dtos/admin-verification.dto';
import { toMemberRef } from '../serializers/admin-member.serializer';

/** What the member is told checked their licence. Never a reviewer's name. */
const CHECKED_BY = 'Circl Trust & Safety';

/**
 * The review queue of Professionals v2 (§12), and the thing that replaced "a listing awaiting
 * approval".
 *
 * A row here is a **`(professional, category)` verification**: did a reviewer read this person's
 * documents for this field of work. One professional may have several, in different states,
 * independently — approved for Immigration, declined for Legal, nothing at all for Trades.
 *
 * Three consequences a reviewer has to be able to see, and which this service is shaped around:
 *
 *  - **An approval publishes every waiting service in that category at once.** Nothing walks them:
 *    a service's status is derived from this record, so the decision is the publication.
 *  - **A revocation suspends them all**, which is why every write here counts the services it will
 *    affect and says so. A reviewer should not learn the size of what they did from the support
 *    queue.
 *  - **The note reaches the member verbatim.** It is the only thing that tells somebody what to
 *    fix, so it is never templated or summarised on the way out.
 */
@Injectable()
export class AdminVerificationService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly documents: ListingDocumentService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
    private readonly actions: AdminMemberActionService,
  ) {}

  // ─── The queue ─────────────────────────────────────────────────────────────

  async list(query: ListVerificationsDto): Promise<{ data: unknown[]; meta: PageMeta }> {
    const where: Prisma.CategoryVerificationWhereInput = {
      ...(query.status?.length ? { status: { in: query.status } } : {}),
      ...(query.categoryCode ? { categoryCode: query.categoryCode } : {}),
      ...(query.memberId ? { userId: query.memberId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.database.categoryVerification.findMany({
        where,
        include: VERIFICATION_INCLUDE,
        // Oldest submission first within a state, which is the order a queue is worked in. A
        // reviewer opening the screen should see what has been waiting longest.
        orderBy: [{ submittedAt: 'asc' }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
      this.database.categoryVerification.count({ where }),
    ]);

    const labels = await this.taxonomy.labels(TaxonomyKind.PROFESSION);
    const documents = await this.documentCounts(rows.map(row => row.id));
    const waiting = await this.waitingCounts(rows);

    return {
      data: rows.map(row => this.toRow(row, labels, documents, waiting)),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total),
    };
  }

  /** One record, with the documents listed and the subcategories it was submitted under. */
  async detail(id: string) {
    const row = await this.record(id);
    const [labels, subcategoryLabels, documents, waiting] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.taxonomy.labels(TaxonomyKind.PROFESSION_SUBCATEGORY),
      this.database.media.findMany({
        where: {
          ownerType: VERIFICATION_DOCUMENT_OWNER,
          ownerId: id,
          supersededAt: null,
        },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          fileName: true,
          mimeType: true,
          byteSize: true,
          pageCount: true,
          scanStatus: true,
        },
      }),
      this.waitingCounts([row]),
    ]);

    return {
      ...this.toRow(row, labels, new Map([[id, documents.length]]), waiting),
      submittedForSubcategories: row.submittedForSubcategories.map(code => ({
        code,
        label: subcategoryLabels.get(code) ?? code,
      })),
      /**
       * Metadata only, and **never a URL** (§2.4).
       *
       * The bytes come from `GET :id/documents/:documentId`, through the staff guard stack. A
       * presigned URL is a bearer token for somebody's qualification certificate: it works for
       * anybody holding it, outlives the session that minted it, and lands in browser history.
       */
      documents,
      memberNote: row.note,
    };
  }

  /** The file itself, streamed. Same rules as a listing document, and audited the same way. */
  async document(actor: AdminPrincipal, id: string, documentId: string) {
    await this.record(id);

    const file = await this.documents.read(id, documentId, VERIFICATION_DOCUMENT_OWNER);

    await this.recordView(actor, id, documentId);

    return file;
  }

  // ─── Deciding ──────────────────────────────────────────────────────────────

  /**
   * Approve or decline (§12).
   *
   * Approving takes `licenceSeen` — which licence or registration the reviewer actually held in
   * their hand. That is the mitigation for category-wide approval: an IAA registration unlocks
   * *Immigration solicitor* as well, and if that ever has to be narrowed, this is the field that
   * makes it a rule change rather than a data recovery (§2.3).
   *
   * Declining requires the note, because it is the only thing the member has to act on.
   */
  async decide(actor: AdminPrincipal, id: string, dto: DecideVerificationDto) {
    const row = await this.record(id);

    if (row.status === CategoryVerificationStatus.APPROVED && dto.decision === 'APPROVE') {
      throw ApiException.conflict(
        ApiErrorCode.ALREADY_DECIDED,
        'That is already approved. Revoke it first if you need to change it.',
        { data: { status: row.status, decidedAt: row.decidedAt } },
      );
    }

    const approving = dto.decision === 'APPROVE';

    if (!approving && !dto.note?.trim()) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'A decline needs a note. It is the only thing that tells them what to fix.',
        { details: [{ field: 'note', message: 'Required when declining.' }] },
      );
    }

    const affected = await this.countServices(row.userId, row.categoryCode);

    const { result } = await this.audit.mutate(
      {
        action: approving ? ('verification.approved' as const) : ('verification.rejected' as const),
        targetType: 'MEMBER' as const,
        targetId: row.userId,
        before: { status: row.status },
        after: {
          status: approving
            ? CategoryVerificationStatus.APPROVED
            : CategoryVerificationStatus.REJECTED,
          categoryCode: row.categoryCode,
        },
        reasonCode: dto.reasonCode,
        // The reviewer's words, in the trail as well as on the record: a decision somebody
        // complains about later is read from here.
        reason: dto.note ?? null,
        metadata: {
          verificationId: id,
          categoryCode: row.categoryCode,
          licenceSeen: dto.licenceSeen ?? null,
          submittedForSubcategories: row.submittedForSubcategories,
          // What this decision did to their services, recorded because the number is the thing
          // nobody can reconstruct afterwards.
          servicesAffected: affected,
        },
      },
      tx =>
        tx.categoryVerification.update({
          where: { id },
          data: {
            status: approving
              ? CategoryVerificationStatus.APPROVED
              : CategoryVerificationStatus.REJECTED,
            decidedAt: new Date(),
            decidedById: actor.id,
            decisionNote: dto.note ?? null,
            licenceSeen: dto.licenceSeen ?? null,
            checkedBy: CHECKED_BY,
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          },
          include: VERIFICATION_INCLUDE,
        }),
    );

    const labels = await this.taxonomy.labels(TaxonomyKind.PROFESSION);
    const label = labels.get(row.categoryCode) ?? row.categoryCode;

    /**
     * Tell them, outside the transaction — a notification that fails must not undo the decision.
     *
     * Not in the spec, and added anyway: a decision that publishes or blocks somebody's work and
     * waits for them to come looking is the thing support hears about first. The decline carries
     * the reviewer's words **verbatim**, because paraphrasing the one sentence that says what to
     * fix is how a member ends up resubmitting the same documents.
     */
    this.actions.notifyMember(row.userId, {
      title: approving
        ? `You are verified for ${label}`
        : `Your ${label} documents were not accepted`,
      body: approving
        ? affected
          ? `${affected === 1 ? 'Your service' : `Your ${affected} services`} in ${label} ${affected === 1 ? 'is' : 'are'} now live.`
          : `You can now publish services in ${label}.`
        : (dto.note?.trim() ??
          'Open your profile to see what needs changing, then send your documents again.'),
      route: LISTING_ROUTE.view,
    });

    return {
      ...this.toRow(result, labels, new Map(), new Map()),
      /**
       * What the decision did, in the response.
       *
       * Nothing walked those services — their status is derived from this record — so this is a
       * count rather than a report of work done. It is here because a reviewer who has just
       * published eleven services should be told that, and because the portal has to be able to
       * warn them before the next one.
       */
      servicesAffected: affected,
    };
  }

  /**
   * Withdraw an approval (§12). Every service in the category is suspended with it.
   *
   * The count comes back, and the portal is expected to warn with it **before** the call: "this
   * will take down eleven live services" is a thing a reviewer needs to know while they can still
   * change their mind.
   */
  async revoke(actor: AdminPrincipal, id: string, dto: RevokeVerificationDto) {
    const row = await this.record(id);

    if (row.status !== CategoryVerificationStatus.APPROVED) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'Only an approved verification can be revoked.',
        { data: { status: row.status } },
      );
    }

    const affected = await this.countServices(row.userId, row.categoryCode);

    const { result } = await this.audit.mutate(
      {
        action: 'verification.revoked' as const,
        targetType: 'MEMBER' as const,
        targetId: row.userId,
        before: { status: row.status, decidedAt: row.decidedAt?.toISOString() ?? null },
        after: { status: CategoryVerificationStatus.REVOKED, categoryCode: row.categoryCode },
        reasonCode: dto.reasonCode,
        reason: dto.note,
        metadata: {
          verificationId: id,
          categoryCode: row.categoryCode,
          servicesSuspended: affected,
        },
      },
      tx =>
        tx.categoryVerification.update({
          where: { id },
          data: {
            status: CategoryVerificationStatus.REVOKED,
            decidedAt: new Date(),
            decidedById: actor.id,
            decisionNote: dto.note,
          },
          include: VERIFICATION_INCLUDE,
        }),
    );

    const labels = await this.taxonomy.labels(TaxonomyKind.PROFESSION);
    const label = labels.get(row.categoryCode) ?? row.categoryCode;

    // The one notification nobody should have to discover for themselves: their work has just come
    // off the platform. The reviewer's words go with it, unedited.
    this.actions.notifyMember(row.userId, {
      title: `Your ${label} verification has been withdrawn`,
      body: affected
        ? `${dto.note} ${affected === 1 ? 'Your service' : `Your ${affected} services`} in ${label} ${affected === 1 ? 'is' : 'are'} no longer visible.`
        : dto.note,
      route: LISTING_ROUTE.view,
    });

    return { ...this.toRow(result, labels, new Map(), new Map()), servicesSuspended: affected };
  }

  /**
   * Set or clear the expiry (§12).
   *
   * A licence with a renewal date is the normal case in regulated work. Clearing it is sending
   * `null`, which is a different answer from omitting the field — one says "this does not lapse"
   * and the other says nothing at all.
   */
  async setExpiry(actor: AdminPrincipal, id: string, dto: SetVerificationExpiryDto) {
    const row = await this.record(id);
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'An expiry in the past would suspend their services immediately. Revoke it instead if that is what you mean.',
        { details: [{ field: 'expiresAt', message: 'Must be in the future.' }] },
      );
    }

    const { result } = await this.audit.mutate(
      {
        action: 'verification.expiry_set' as const,
        targetType: 'MEMBER' as const,
        targetId: row.userId,
        before: { expiresAt: row.expiresAt?.toISOString() ?? null },
        after: { expiresAt: expiresAt?.toISOString() ?? null },
        metadata: { verificationId: id, categoryCode: row.categoryCode },
      },
      tx =>
        tx.categoryVerification.update({
          where: { id },
          data: { expiresAt },
          include: VERIFICATION_INCLUDE,
        }),
    );

    const labels = await this.taxonomy.labels(TaxonomyKind.PROFESSION);

    return this.toRow(result, labels, new Map(), new Map());
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async record(id: string) {
    const row = await this.database.categoryVerification.findUnique({
      where: { id },
      include: VERIFICATION_INCLUDE,
    });

    if (!row) throw ApiException.notFound('That verification could not be found.');

    return row;
  }

  /**
   * How many of their services this category decides.
   *
   * Counted rather than derived from a stored flag, because there is no stored flag — which is the
   * point of §5.4. `LIVE` only: a draft or a hidden service is not something a decision takes down
   * or puts up.
   */
  private async countServices(userId: string, categoryCode: string): Promise<number> {
    return this.database.professionalService.count({
      where: {
        categoryCode,
        ownerState: ServiceOwnerState.LIVE,
        visibilityState: ContentVisibilityState.VISIBLE,
        listing: { userId, deletedAt: null },
      },
    });
  }

  private async documentCounts(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();

    const rows = await this.database.media.groupBy({
      by: ['ownerId'],
      where: { ownerType: VERIFICATION_DOCUMENT_OWNER, ownerId: { in: ids }, supersededAt: null },
      _count: { _all: true },
    });

    return new Map(rows.map(row => [row.ownerId ?? '', row._count._all]));
  }

  /** How many services each row would publish or suspend, for the queue's own warning. */
  private async waitingCounts(
    rows: Array<{ id: string; userId: string; categoryCode: string }>,
  ): Promise<Map<string, number>> {
    if (!rows.length) return new Map();

    const counted = await this.database.professionalService.groupBy({
      by: ['categoryCode'],
      where: {
        categoryCode: { in: rows.map(row => row.categoryCode) },
        ownerState: ServiceOwnerState.LIVE,
        listing: { userId: { in: rows.map(row => row.userId) }, deletedAt: null },
      },
      _count: { _all: true },
    });
    const byCategory = new Map(counted.map(row => [row.categoryCode ?? '', row._count._all]));

    return new Map(rows.map(row => [row.id, byCategory.get(row.categoryCode) ?? 0]));
  }

  private toRow(
    row: Prisma.CategoryVerificationGetPayload<{ include: typeof VERIFICATION_INCLUDE }>,
    labels: Map<string, string>,
    documents: Map<string, number>,
    waiting: Map<string, number>,
  ) {
    return {
      id: row.id,
      member: toMemberRef(row.user, this.media.sign),
      category: { code: row.categoryCode, label: labels.get(row.categoryCode) ?? row.categoryCode },
      status: row.status,
      submittedAt: row.submittedAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      note: row.decisionNote,
      licenceSeen: row.licenceSeen,
      checkedBy: row.checkedBy,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      submittedForSubcategories: row.submittedForSubcategories,
      documentCount: documents.get(row.id) ?? 0,
      /** What a decision here would publish or take down. The warning the portal renders. */
      servicesInCategory: waiting.get(row.id) ?? 0,
    };
  }

  /**
   * One audit entry per staff member per document per fifteen minutes.
   *
   * The same throttle the listing documents use, for the same reason: a reviewer paging through a
   * six-page PDF writes six entries and a viewer that re-requests on focus writes dozens, which
   * buries the fact that somebody opened a member's licence under how their PDF viewer works.
   */
  private async recordView(actor: AdminPrincipal, id: string, documentId: string) {
    const since = new Date(Date.now() - 15 * 60 * 1000);
    const recent = await this.database.auditLog.findFirst({
      where: {
        action: 'verification.document_viewed',
        actorId: actor.id,
        targetId: id,
        occurredAt: { gte: since },
        metadata: { path: ['documentId'], equals: documentId },
      },
      select: { id: true },
    });

    if (recent) return;

    await this.audit.record(this.database, {
      action: 'verification.document_viewed',
      targetType: 'CONTENT',
      targetId: id,
      metadata: { documentId },
    });
  }
}

const VERIFICATION_INCLUDE = {
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      username: true,
      avatarKey: true,
      profileImageUrl: true,
      isAnonymised: true,
      status: true,
    },
  },
} satisfies Prisma.CategoryVerificationInclude;
