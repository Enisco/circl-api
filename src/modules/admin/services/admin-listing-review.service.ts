import { Injectable } from '@nestjs/common';
import {
  ContentVisibilityState,
  ListingReviewState,
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  Prisma,
  ReportTargetType,
  TaxonomyKind,
} from '@prisma/client';
import { ApiErrorCode, ApiException, buildPageMeta, toJson } from '@/common';
import { PrismaService } from '@/infrastructure';
import {
  ContentSafetyService,
  LISTING_ROUTE,
  ListingDocumentService,
  ListingReviewService,
  MediaService,
  TaxonomyService,
} from '@/modules/platform/shared';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import {
  DecideListingReviewDto,
  ListListingReviewsDto,
  SetGatedProfessionsDto,
} from '../dtos/admin-listing-review.dto';
import { toMemberRef } from '../serializers/admin-member.serializer';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';
import { staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';
import { AdminMemberActionService } from './admin-member-action.service';

/**
 * §2.9: approving listings in gated professions.
 *
 * A queue of its own rather than a tab of the flagged-content one, because the question is
 * different and so are the answers. Nothing is wrong with these listings and nobody is accused of
 * anything — a reviewer is deciding whether this member may offer immigration advice, or mind
 * children, or work on somebody's gas, and the two buttons are "publish it" and "don't", not
 * "remove it" and "warn them".
 *
 * The decision writes four things in one transaction: the listing's workflow state, the content's
 * visibility (through the same §6.5 column every browse path already filters on), the queue item,
 * and a `ModerationAction` so the trail survives the next edit. The member is told outside it,
 * because a notification that fails must not roll back an approval.
 */
@Injectable()
export class AdminListingReviewService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly taxonomy: TaxonomyService,
    private readonly safety: ContentSafetyService,
    private readonly actions: AdminMemberActionService,
    private readonly reviews: ListingReviewService,
    private readonly documents: ListingDocumentService,
    private readonly audit: AuditService,
  ) {}

  // ─── Read ──────────────────────────────────────────────────────────────────

  async list(actor: AdminPrincipal, query: ListListingReviewsDto) {
    const states = query.state?.length ? query.state : [ListingReviewState.PENDING];
    const where: Prisma.ProfessionalListingWhereInput = {
      deletedAt: null,
      reviewState: { in: states },
      ...(query.categoryCode ? { categories: { some: { code: query.categoryCode } } } : {}),
      // Live while it waits: the grandfathered half of the queue (see the backfill in
      // `20261011152501_listing_review`). Expressed as the visibility the member actually has
      // rather than as a flag, so it stays true if a staff member hides one by hand.
      //
      // `q` searches the **profession title and the member's name**, which is how a reviewer looks
      // for one: "the electrician from Tuesday". It was accepted and never applied, so the search
      // box returned the whole queue and read as a box that does nothing.
      ...(query.q
        ? {
            OR: [
              { professionTitle: { contains: query.q, mode: Prisma.QueryMode.insensitive } },
              { user: { firstName: { contains: query.q, mode: Prisma.QueryMode.insensitive } } },
              { user: { lastName: { contains: query.q, mode: Prisma.QueryMode.insensitive } } },
              { user: { username: { contains: query.q, mode: Prisma.QueryMode.insensitive } } },
            ],
          }
        : {}),
    };

    if (query.mine) {
      const claimed = await this.database.moderationQueueItem.findMany({
        where: {
          type: ModerationQueueType.PROFESSIONAL_REVIEW,
          assignedToId: actor.id,
          state: { not: ModerationQueueState.RESOLVED },
        },
        select: { targetId: true },
      });

      where.id = { in: claimed.map(item => item.targetId) };
    }

    const [total, rows] = await this.database.$transaction([
      this.database.professionalListing.count({ where }),
      this.database.professionalListing.findMany({
        where,
        include: {
          city: { select: { id: true, name: true, region: true } },
          categories: { select: { code: true, isPrimary: true } },
          user: { select: { ...caseMemberSelect, createdAt: true } },
        },
        // Oldest submission first. A member waiting to be allowed to work is waiting on us.
        orderBy: [{ reviewSubmittedAt: 'asc' }, { createdAt: 'asc' }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    const [labels, items, documentCounts] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.itemsFor(rows.map(row => row.id)),
      this.documents.countsFor(rows.map(row => row.id)),
    ]);
    const staff = await this.staffFor([...items.values()]);

    return {
      data: rows.map(row => ({
        ...this.toRow(row, labels, items.get(row.id) ?? null, staff),
        documentCount: documentCounts.get(row.id) ?? 0,
      })),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        pendingCount: await this.database.professionalListing.count({
          where: { reviewState: ListingReviewState.PENDING, deletedAt: null },
        }),
      }),
    };
  }

  /** One listing, with everything a reviewer needs to decide without opening four other screens. */
  async detail(id: string) {
    const listing = await this.database.professionalListing.findUnique({
      where: { id },
      include: {
        city: { select: { id: true, name: true, region: true } },
        categories: { select: { code: true, isPrimary: true } },
        services: { select: { id: true, name: true, description: true, isActive: true } },
        user: { select: { ...caseMemberSelect, createdAt: true } },
      },
    });

    if (!listing) throw ApiException.notFound('That listing could not be found.');

    const [labels, items, safety, strikes, history, documents] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.itemsFor([listing.id]),
      this.database.contentSafety.findUnique({
        where: {
          targetType_targetId: {
            targetType: ReportTargetType.PROFESSIONAL_LISTING,
            targetId: listing.id,
          },
        },
        select: { tier: true, finalScore: true, category: true, heldReason: true },
      }),
      this.database.strike.count({
        where: { userId: listing.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      this.database.moderationAction.findMany({
        where: {
          targetType: ReportTargetType.PROFESSIONAL_LISTING,
          targetId: listing.id,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.documents.current(listing.id),
    ]);

    const item = items.get(listing.id) ?? null;
    const staff = await this.staffFor([
      ...(item ? [item] : []),
      ...history.map(entry => ({ assignedToId: entry.actorId, decidedById: entry.actorId })),
    ]);
    const gated = await this.gatedCodes(listing.categories.map(category => category.code));

    return {
      ...this.toRow(listing, labels, item, staff),
      about: listing.about,
      experienceLevel: listing.experienceLevel,
      yearsExperience: listing.yearsExperience,
      deliveryMode: listing.deliveryMode,
      pictures: {
        photoUrl: listing.photoKey ? this.media.sign(listing.photoKey) : null,
        coverUrl: listing.coverKey ? this.media.sign(listing.coverKey) : null,
      },
      services: listing.services,
      // What the member agreed to when they created it. With no credential checks (D13) this is
      // the whole of what Circl holds, and saying so is better than implying more.
      consent: {
        accepted: listing.consentAccepted,
        acceptedAt: listing.consentAcceptedAt?.toISOString() ?? null,
        version: listing.consentVersion,
      },
      // Which of this listing's professions need approving. `credentialBodies` used to be here, so
      // a reviewer could check a registration number against the right register by hand — the
      // portal no longer reads it and that approach has been dropped in favour of the documents
      // below, which are the evidence. The flag is still on the taxonomy for the app.
      gatedCategories: gated.map(code => ({ code, label: labels.get(code) ?? code })),
      /**
       * The current submission's supporting documents (§2.9). Open one with
       * `GET admin/professional-reviews/:id/documents/:documentId`, which streams the bytes
       * through this API rather than handing out a presigned URL.
       *
       * `[]` for a listing that was already live when approval started: there was nothing to ask
       * for at the time. Declining with the suggested message is how a reviewer asks.
       */
      documents: documents.map(row => this.documents.toView(row)),
      documentCount: documents.length,
      author: {
        ...toMemberRef(listing.user, this.media.sign),
        activeStrikes: strikes,
        accountAgeDays: Math.floor((Date.now() - listing.user.createdAt.getTime()) / 86_400_000),
      },
      risk: safety
        ? {
            tier: safety.tier,
            finalScore: safety.finalScore,
            category: safety.category,
            heldReason: safety.heldReason,
          }
        : null,
      history: history.map(entry => ({
        id: entry.id,
        decision: entry.decision,
        reason: entry.reason,
        at: entry.createdAt.toISOString(),
        actor: staff.get(entry.actorId) ?? null,
      })),
    };
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  /** Takes the review, so two people do not decide the same listing. */
  async claim(actor: AdminPrincipal, id: string) {
    const item = await this.itemOrThrow(id);

    if (item.state === ModerationQueueState.RESOLVED) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'This review has already been decided.',
      );
    }

    if (item.assignedToId && item.assignedToId !== actor.id) {
      throw ApiException.conflict(
        ApiErrorCode.CLAIMED_BY_OTHER,
        'Somebody else is already reviewing this listing.',
        { data: { assignedToId: item.assignedToId } },
      );
    }

    await this.database.moderationQueueItem.update({
      where: { id: item.id },
      data: { assignedToId: actor.id, state: ModerationQueueState.IN_REVIEW },
    });

    return this.detail(id);
  }

  /**
   * Approve or decline.
   *
   * A decline needs a message to the member, not only an internal reason. Everywhere else in the
   * portal `memberMessage` is optional because the action speaks for itself — content comes down,
   * a warning arrives. Here the member is being told they may not do the work they signed up to
   * do, and "not approved" on its own gives them nothing to fix and nothing to appeal.
   */
  async decide(actor: AdminPrincipal, id: string, dto: DecideListingReviewDto) {
    const reason = dto.assertReasoned();
    const listing = await this.database.professionalListing.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        professionTitle: true,
        reviewState: true,
        deletedAt: true,
      },
    });

    if (!listing || listing.deletedAt) {
      throw ApiException.notFound('That listing could not be found.');
    }

    if (listing.reviewState === ListingReviewState.NOT_REQUIRED) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'This listing is not in a profession that needs approving.',
      );
    }

    const approving = dto.outcome === ListingReviewState.APPROVED;

    if (!approving && !dto.memberMessage) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'Tell the member what to change.',
        {
          details: [
            {
              field: 'memberMessage',
              message: 'Required on a decline: they cannot fix what they have not been told.',
            },
          ],
        },
      );
    }

    const item = await this.itemOrThrow(id);

    if (item.state === ModerationQueueState.RESOLVED) {
      throw ApiException.conflict(
        ApiErrorCode.ALREADY_DECIDED,
        'This review has already been decided.',
        { data: { decision: item.decision, decidedAt: item.decidedAt?.toISOString() ?? null } },
      );
    }

    // R6's cousin: whoever claimed it is the one who decides it. Not a conflict rule — just the
    // same "do not let two people act on one item" the rest of the queue enforces.
    if (item.assignedToId && item.assignedToId !== actor.id) {
      throw ApiException.conflict(
        ApiErrorCode.CLAIMED_BY_OTHER,
        'Somebody else is reviewing this listing.',
        { data: { assignedToId: item.assignedToId } },
      );
    }

    const decision = approving ? ModerationDecision.APPROVE : ModerationDecision.REJECT;
    const now = new Date();

    const { auditId } = await this.audit.mutate(
      {
        action: approving ? 'listing.review_approved' : 'listing.review_declined',
        targetType: 'CONTENT',
        targetId: listing.id,
        before: { reviewState: listing.reviewState },
        after: { reviewState: dto.outcome },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
        metadata: { memberId: listing.userId, memberMessage: dto.memberMessage ?? null },
      },
      async tx => {
        await tx.professionalListing.update({
          where: { id: listing.id },
          data: {
            reviewState: dto.outcome,
            reviewDecidedAt: now,
            reviewDecidedById: actor.id,
            reviewNote: dto.memberMessage ?? null,
          },
        });

        // The visibility the member and the public see, through the one column every read path
        // already filters on. `applyDecision` mirrors it onto the listing row as well.
        await this.safety.applyDecision(tx, {
          targetType: ReportTargetType.PROFESSIONAL_LISTING,
          targetId: listing.id,
          state: approving ? ContentVisibilityState.VISIBLE : ContentVisibilityState.REJECTED,
          decision,
          reviewerId: actor.id,
        });

        await tx.moderationQueueItem.update({
          where: { id: item.id },
          data: {
            state: ModerationQueueState.RESOLVED,
            assignedToId: actor.id,
            decision,
            decisionNote: reason.note,
            decidedById: actor.id,
            decidedAt: now,
          },
        });

        // Outlives the next edit, which clears the safety row's own reviewer. Without this, a
        // listing approved on Monday and edited on Tuesday has no record that anybody ever
        // approved it.
        await tx.moderationAction.create({
          data: {
            actorId: actor.id,
            targetType: ReportTargetType.PROFESSIONAL_LISTING,
            targetId: listing.id,
            decision,
            reason: reason.note,
            metadata: {
              reviewOutcome: dto.outcome,
              memberMessage: dto.memberMessage ?? null,
            },
          },
        });
      },
    );

    // Outside the transaction: a notification that fails must not undo the decision it describes.
    this.actions.notifyMember(listing.userId, {
      title: approving
        ? 'Your professional listing is approved'
        : 'Your professional listing was not approved',
      body: approving
        ? `${listing.professionTitle} is now live on Circl.`
        : (dto.memberMessage ??
          'Open your listing to see what needs changing, then save it to send it back to us.'),
      // An approval opens the listing; a rejection opens the form, because the body tells them to
      // change something and a read-only screen is where that instruction dies. See LISTING_ROUTE.
      route: approving ? LISTING_ROUTE.view : LISTING_ROUTE.edit,
    });

    return { data: await this.detail(id), auditId };
  }

  // ─── One document's bytes ──────────────────────────────────────────────────

  /**
   * Streams a supporting document to a reviewer, and records that they looked (§2.9).
   *
   * Through the API rather than as a presigned URL, deliberately. A presigned URL is a bearer
   * token for somebody's qualification certificate: it works for anybody holding it, outlives the
   * session that minted it, and ends up in browser history and any proxy between. Every byte of
   * this goes through the staff guard stack instead.
   */
  async document(actor: AdminPrincipal, listingId: string, documentId: string) {
    const listing = await this.database.professionalListing.findUnique({
      where: { id: listingId },
      select: { id: true, deletedAt: true },
    });

    if (!listing || listing.deletedAt) {
      throw ApiException.notFound('That listing could not be found.');
    }

    const file = await this.documents.read(listingId, documentId);

    await this.recordView(actor, listingId, documentId);

    return file;
  }

  /**
   * One audit entry per staff member per document per fifteen minutes.
   *
   * Without the throttle, a reviewer paging through a six-page PDF writes six entries, and a
   * viewer that re-requests on focus writes dozens — which buries the fact that somebody opened a
   * member's certificate under the noise of how their PDF viewer works. The window is what makes
   * "who looked at my documents" answerable, which is the question this exists for.
   *
   * Written outside the audit service's `mutate` because nothing is mutating: this is a read that
   * has to leave a trace.
   */
  private async recordView(actor: AdminPrincipal, listingId: string, documentId: string) {
    const since = new Date(Date.now() - 15 * 60 * 1000);
    const recent = await this.database.auditLog.findFirst({
      where: {
        action: 'listing.document_viewed',
        actorId: actor.id,
        targetId: listingId,
        occurredAt: { gte: since },
        metadata: { path: ['documentId'], equals: documentId },
      },
      select: { id: true },
    });

    if (recent) return;

    await this.audit.record(this.database, {
      action: 'listing.document_viewed',
      targetType: 'CONTENT',
      targetId: listingId,
      metadata: { documentId },
    });
  }

  // ─── Which professions are gated (§2.9) ────────────────────────────────────

  /**
   * Every profession, with the flag and the consequence of changing it.
   *
   * The counts are the point. "Gate `TRADES_REPAIRS`" reads very differently when it says 340
   * listings will be queued, and an operator who cannot see that before they press the button
   * finds out by reading the queue afterwards.
   */
  async categories() {
    const [terms, listings, pending] = await Promise.all([
      this.database.taxonomyTerm.findMany({
        where: { kind: TaxonomyKind.PROFESSION },
        orderBy: { sort: 'asc' },
        select: { code: true, label: true, isActive: true, metadata: true },
      }),
      this.database.professionalListingCategory.groupBy({
        by: ['code'],
        _count: { listingId: true },
        where: { listing: { deletedAt: null } },
      }),
      this.database.professionalListingCategory.groupBy({
        by: ['code'],
        _count: { listingId: true },
        where: { listing: { deletedAt: null, reviewState: ListingReviewState.PENDING } },
      }),
    ]);

    const liveCount = new Map(listings.map(row => [row.code, row._count.listingId]));
    const pendingCount = new Map(pending.map(row => [row.code, row._count.listingId]));

    return terms.map(term => {
      const metadata = (term.metadata ?? {}) as Record<string, unknown>;

      return {
        code: term.code,
        label: term.label,
        isActive: term.isActive,
        /** Whether listings in this profession wait for approval. The operator owns this. */
        requiresReview: metadata.requiresReview === true,
        /** Whether a regulator exists. A fact about the world, and not the same question. */
        isRegulated: metadata.isRegulated === true,
        listings: liveCount.get(term.code) ?? 0,
        pendingReviews: pendingCount.get(term.code) ?? 0,
      };
    });
  }

  /**
   * Rewrites the gated set, and applies what that means to listings already in those professions.
   *
   * A configuration change with consequences, and both halves are the point:
   *
   * - **Newly gated** professions apply to accounts created afterwards only. Nothing that already
   *   exists changes state or visibility: these members are trading, some mid-job, and a settings
   *   change must not put a working professional into a queue they never chose to enter, with
   *   documents nobody asked them for.
   * - **Newly ungated** listings are released. A hold with no release is how content ends up
   *   invisible for ever with nobody able to say why, and switching a profession off is the most
   *   likely way to create a crop of them at once.
   *
   * Listings already approved or declined in a still-gated profession are left exactly as they
   * are. Re-gating a profession is not a reason to re-decide the listings somebody already read.
   */
  async setGated(actor: AdminPrincipal, dto: SetGatedProfessionsDto) {
    const reason = dto.assertReasoned();
    const terms = await this.database.taxonomyTerm.findMany({
      where: { kind: TaxonomyKind.PROFESSION },
      select: { code: true, metadata: true },
    });

    const known = new Set(terms.map(term => term.code));
    const asked = [...new Set(dto.codes)];
    const unknown = asked.filter(code => !known.has(code));

    if (unknown.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        `Not a profession: ${unknown.join(', ')}.`,
        {
          details: unknown.map(code => ({
            field: 'codes',
            message: `${code} is not a profession.`,
          })),
        },
      );
    }

    const before = terms
      .filter(term => ((term.metadata ?? {}) as Record<string, unknown>).requiresReview === true)
      .map(term => term.code);
    const wanted = new Set(asked);
    const gating = asked.filter(code => !before.includes(code));
    const ungating = before.filter(code => !wanted.has(code));

    if (!gating.length && !ungating.length) {
      // Nothing to do, and said rather than written: an audit entry for a change that changed
      // nothing is noise in the one place that should only hold decisions.
      return {
        data: { categories: await this.categories(), applied: EMPTY_CHANGE },
        auditId: null,
      };
    }

    const applied = { gated: gating, ungated: ungating, listingsReleased: 0 };

    const { auditId } = await this.audit.mutate(
      {
        action: 'professions.gate_changed',
        targetType: 'CONFIG',
        targetId: 'PROFESSION.requiresReview',
        before: { gated: before },
        after: { gated: asked },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
        metadata: { gating, ungating },
      },
      async tx => {
        for (const term of terms) {
          const metadata = { ...((term.metadata ?? {}) as Record<string, unknown>) };
          const next = wanted.has(term.code);

          if ((metadata.requiresReview === true) === next) continue;

          // Merged, not replaced. The generic taxonomy endpoint writes `metadata` wholesale, which
          // for this one key would take `isRegulated` and `credentialBodies` with it.
          metadata.requiresReview = next;

          await tx.taxonomyTerm.update({
            where: { kind_code: { kind: TaxonomyKind.PROFESSION, code: term.code } },
            data: { metadata: toJson(metadata) },
          });
        }

        // Turning a profession **on** deliberately does nothing to the listings that already
        // exist (BACKEND-NOTES-NEW-ACCOUNTS-ONLY, 2026-10-12). It applies to accounts created
        // afterwards, and only those.
        //
        // This used to queue every live listing in the newly gated profession and leave it
        // visible — the "grandfathered" state. Two things were wrong with it. It put a working
        // professional into a review queue they never chose to enter, on the strength of a
        // settings change, with documents they were never asked for at signup; and it created a
        // `PENDING` listing that was publicly visible, so `PENDING` meant "hidden" for a new
        // account and "live" for an old one. Every reader of that column then needed to know
        // which kind it was looking at, which is how `isLiveWhileWaiting` came to exist.
        //
        // Now there is one meaning: a `PENDING` listing is hidden, always.

        if (ungating.length) {
          const held = await tx.professionalListing.findMany({
            where: {
              deletedAt: null,
              reviewState: { not: ListingReviewState.NOT_REQUIRED },
              categories: { some: { code: { in: ungating } } },
            },
            select: { id: true, categories: { select: { code: true } } },
          });

          for (const listing of held) {
            // Only if **nothing** gated is left on it. A listing in both IMMIGRATION and
            // TRADES_REPAIRS that loses the second still needs approving for the first, and
            // releasing it here would publish an unapproved immigration adviser.
            const stillGated = listing.categories.some(category => wanted.has(category.code));

            if (stillGated) continue;

            // Counted only when it actually became public. An approved listing was already live,
            // so including it would report a release that changed nothing for anybody — and this
            // number is what the portal shows staff as the consequence of their change.
            const released = await this.reviews.release(tx, listing.id);

            if (released) applied.listingsReleased += 1;
          }
        }
      },
    );

    // The version stamp, which invalidates every process's taxonomy cache and the clients' ETag in
    // one write. Without it the app would keep warning members about a profession that is no
    // longer gated — and, worse, keep not warning them about one that now is.
    await this.taxonomy.bumpVersion();

    return { data: { categories: await this.categories(), applied }, auditId };
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

  private async itemOrThrow(listingId: string) {
    const item = await this.database.moderationQueueItem.findUnique({
      where: {
        type_targetType_targetId: {
          type: ModerationQueueType.PROFESSIONAL_REVIEW,
          targetType: ReportTargetType.PROFESSIONAL_LISTING,
          targetId: listingId,
        },
      },
    });

    if (!item) {
      throw ApiException.notFound('There is no open review for that listing.');
    }

    return item;
  }

  private async itemsFor(listingIds: string[]) {
    if (!listingIds.length) return new Map<string, QueueItemRow>();

    const items = await this.database.moderationQueueItem.findMany({
      where: {
        type: ModerationQueueType.PROFESSIONAL_REVIEW,
        targetType: ReportTargetType.PROFESSIONAL_LISTING,
        targetId: { in: listingIds },
      },
      select: {
        id: true,
        targetId: true,
        state: true,
        assignedToId: true,
        decidedById: true,
        decidedAt: true,
        decision: true,
      },
    });

    return new Map(items.map(item => [item.targetId, item]));
  }

  /** The staff rows behind every assignee and decider in one go, rather than per row. */
  private async staffFor(
    items: Array<{ assignedToId?: string | null; decidedById?: string | null }>,
  ) {
    const ids = [
      ...new Set(
        items
          .flatMap(item => [item.assignedToId, item.decidedById])
          .filter((id): id is string => !!id),
      ),
    ];

    if (!ids.length) return new Map<string, ReturnType<typeof toStaffRef>>();

    const people = await this.database.user.findMany({
      where: { id: { in: ids } },
      select: staffRefSelect,
    });

    return new Map(people.map(person => [person.id, toStaffRef(person, this.media.sign)]));
  }

  private async gatedCodes(codes: string[]): Promise<string[]> {
    const gated: string[] = [];

    for (const code of codes) {
      const term = await this.taxonomy.get(TaxonomyKind.PROFESSION, code);

      if (term?.metadata?.requiresReview === true) gated.push(code);
    }

    return gated;
  }

  private toRow(
    listing: {
      id: string;
      professionTitle: string;
      reviewState: ListingReviewState;
      reviewSubmittedAt: Date | null;
      reviewDecidedAt: Date | null;
      reviewNote: string | null;
      visibilityState: ContentVisibilityState;
      createdAt: Date;
      city: { id: string; name: string; region: string | null } | null;
      categories: Array<{ code: string; isPrimary: boolean }>;
      user: Parameters<typeof toMemberRef>[0] & { createdAt: Date };
    },
    labels: Map<string, string>,
    item: QueueItemRow | null,
    staff: Map<string, ReturnType<typeof toStaffRef>>,
  ) {
    const primary =
      listing.categories.find(category => category.isPrimary) ?? listing.categories[0] ?? null;

    return {
      id: listing.id,
      professionTitle: listing.professionTitle,
      member: toMemberRef(listing.user, this.media.sign),
      city: listing.city ? { id: listing.city.id, name: listing.city.name } : null,
      category: primary
        ? { code: primary.code, label: labels.get(primary.code) ?? primary.code }
        : null,
      categories: listing.categories.map(category => ({
        code: category.code,
        label: labels.get(category.code) ?? category.code,
      })),
      reviewState: listing.reviewState,
      // `isLiveWhileWaiting` is gone: a PENDING listing is hidden, always. The state it described
      // cannot occur now that gating a profession leaves existing listings alone.
      visibilityState: listing.visibilityState,
      submittedAt: listing.reviewSubmittedAt?.toISOString() ?? null,
      decidedAt: listing.reviewDecidedAt?.toISOString() ?? null,
      memberMessage: listing.reviewNote,
      createdAt: listing.createdAt.toISOString(),
      queueItemId: item?.id ?? null,
      assignedTo: item?.assignedToId ? (staff.get(item.assignedToId) ?? null) : null,
      decidedBy: item?.decidedById ? (staff.get(item.decidedById) ?? null) : null,
    };
  }
}

const EMPTY_CHANGE = { gated: [], ungated: [], listingsReleased: 0 };

interface QueueItemRow {
  id: string;
  targetId: string;
  state: ModerationQueueState;
  assignedToId: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  decision: ModerationDecision | null;
}
