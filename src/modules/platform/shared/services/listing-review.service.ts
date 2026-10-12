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
import { PrismaService } from '@/infrastructure';
import { ContentSafetyService } from './content-safety.service';
import { isReachable } from './content-visibility';
import { ListingDocumentService } from './listing-document.service';
import { HELD_REASON } from './safety-scoring';
import { QueueDeadlineService } from './queue-deadline.service';
import { TaxonomyService } from './taxonomy.service';

type Tx = Prisma.TransactionClient;

/**
 * Where a review notification should land in the app.
 *
 * Routing in the client is on `target.type`, and there is no target type for a listing or a
 * review — so these rows carry a `route` instead, which the app follows when it recognises it
 * (`NotificationDestination.resolve`). Both paths are declared routes in the mobile build
 * (`lib/core/router.dart`), and the distinction between them is the point: an approval is news, so
 * it opens the listing, while a rejection or a refused document needs the **form**, because
 * nothing can be fixed from a read-only screen.
 *
 * Kept here rather than inline because two sections raise these rows — the reviewer's decision and
 * the infected-document job — and the one that drifts is the one that sends somebody nowhere.
 */
export const LISTING_ROUTE = {
  /** The member's own listing, read-only. */
  view: '/professionals/me',
  /** The form that holds the documents step, where a rejection is acted on. */
  edit: '/professionals/me/edit',
} as const;

/** The listing row as the hold or the release left it, for a caller holding a staler copy. */
type HeldRow = Awaited<ReturnType<Tx['professionalListing']['update']>>;

/**
 * Approval for listings in gated professions (§2.9).
 *
 * Some things a member can offer on Circl are not a matter of taste. Immigration advice given
 * without IAA regulation is a criminal offence; unauthorised investment advice is another; a
 * childminder without Ofsted registration is a safeguarding problem, not a listing problem. The
 * platform's audience is largely people who need exactly that advice and have the least room to
 * absorb being wrong about who gave it. So a listing in one of those professions waits for a human
 * before anybody can find it.
 *
 * Which professions those are is **data** — `TaxonomyTerm.metadata.requiresReview` on the
 * `PROFESSION` vocabulary — so Trust & Safety can gate or ungate one from the portal without a
 * release, and the app reads the flag off `GET /taxonomy` instead of shipping its own copy of the
 * list.
 *
 * The hold itself is the §6.5 machinery, not a parallel one: `PENDING_APPROVAL` on the content's
 * own `visibility_state`, which every browse, search, Smart Match and direct-link path already
 * excludes. A second column would have meant adding a second condition to fifteen queries and
 * being wrong about one of them.
 *
 * In `shared` rather than in the professionals section, because both sides need the same two
 * primitives and neither may own them. The member write path holds a listing when it is created or
 * edited; the portal holds and releases whole professions at once when Trust & Safety changes which
 * ones are gated. A second copy of either would be a second place for a column to be forgotten —
 * and these two in particular are a hold and its release, which is the pair that must not drift.
 */
@Injectable()
export class ListingReviewService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly safety: ContentSafetyService,
    private readonly deadlines: QueueDeadlineService,
    private readonly documents: ListingDocumentService,
  ) {}

  /** The gated codes among these, in the order given. Empty means nothing here needs approving. */
  async gatedCodes(codes: string[]): Promise<string[]> {
    const gated: string[] = [];

    for (const code of codes) {
      const term = await this.taxonomy.get(TaxonomyKind.PROFESSION, code);

      if (term?.metadata?.requiresReview === true) gated.push(code);
    }

    return gated;
  }

  /**
   * Whether this write has to go back to a human, and why.
   *
   * The two cases that are easy to get wrong are both here. An **approved** listing that rewrites
   * its own title or its about paragraph goes back in the queue: approval was of what it said, and
   * treating it as a permanent licence to say anything afterwards would make the review a
   * formality anybody could walk past. A **rejected** listing goes back in the queue on any edit,
   * because fixing it and resubmitting is the whole point of telling the member what was wrong.
   */
  async verdictFor(input: {
    codes: string[];
    reviewState: ListingReviewState;
    copyChanged: boolean;
    categoriesChanged: boolean;
    /** Whether the supporting documents are a different set to the ones that were approved. */
    documentsChanged: boolean;
    /**
     * The gated codes the listing already carried, for a listing that has never been reviewed.
     * Omitted on create, where there is nothing before.
     */
    gatedBefore?: string[];
  }): Promise<{ needsApproval: boolean; gated: string[] }> {
    const gated = await this.gatedCodes(input.codes);

    if (!gated.length) return { needsApproval: false, gated };

    // A listing that has never needed a review is one of the accounts approval does not apply to
    // (BACKEND-NOTES-NEW-ACCOUNTS-ONLY, rule 3): it existed before its profession was gated, and
    // it stays `NOT_REQUIRED` through ordinary edits.
    //
    // This is the case that was wrong. `settled` only ever answered true for an `APPROVED`
    // listing, so a grandfathered one in a now-gated profession was pulled into review by **any**
    // edit at all — changing a price or a phone number would have taken a working professional's
    // listing down and asked them for documents nobody had ever requested. The settings change was
    // careful not to do that; the next edit did it anyway.
    //
    // What does send it to review is **adding** a gated profession it did not have, which is the
    // one case where the member is newly asking to do the thing that needs approving.
    //
    // Kept as a backstop rather than as live behaviour. Since
    // BACKEND-NOTES-PROFESSION-LOCK (2026-10-12) a live listing's professions cannot change at
    // all — `update` refuses with `PROFESSION_LOCKED` before reaching here — so the bypass this
    // branch was closing (register unrestricted, go live, add restricted) is shut one layer
    // earlier. It stays because `NOT_REQUIRED` is also reachable from a *declined* listing that
    // was released when its profession was ungated, and because a second answer to "is this
    // newly asking for approval" costs nothing and the wrong answer here publishes an unapproved
    // adviser.
    if (input.reviewState === ListingReviewState.NOT_REQUIRED) {
      const before = new Set(input.gatedBefore ?? []);
      const added = gated.filter(code => !before.has(code));

      return { needsApproval: added.length > 0, gated };
    }

    const settled =
      input.reviewState === ListingReviewState.APPROVED &&
      !input.copyChanged &&
      !input.categoriesChanged &&
      // The documents are part of what was approved — a reviewer read *those* papers. Without
      // this, a member approved on a genuine certificate could swap it for anything afterwards and
      // stay approved and live: the same hole as letting an approved listing rewrite its own about
      // paragraph, one field across.
      !input.documentsChanged;

    return { needsApproval: !settled, gated };
  }

  /**
   * Puts the listing in the queue and marks the row.
   *
   * The hold is applied by `assess` at the call site — it is the same write as the content scan and
   * belongs in the same transaction as the listing — so this is the bookkeeping either side of it:
   * the workflow state the member and the reviewer both read, and the reviewer's way in.
   */
  async hold(
    tx: Tx,
    listing: { id: string; userId: string; professionTitle: string },
    gated: string[],
  ): Promise<HeldRow> {
    const now = new Date();

    // Returned, not discarded. The caller holds a row it read before the hold — and before
    // `assess` mirrored the visibility onto it — so handing back the current one is what stops the
    // response telling the member their listing is live while the database says it is held.
    const updated = await tx.professionalListing.update({
      where: { id: listing.id },
      data: {
        reviewState: ListingReviewState.PENDING,
        reviewSubmittedAt: now,
        // The previous decision is cleared, not kept: it was about a listing that said something
        // else. `ModerationAction` is where the trail of who decided what survives.
        reviewDecidedAt: null,
        reviewDecidedById: null,
        reviewNote: null,
      },
    });

    // A listing review is never urgent by nature — nothing is wrong with the listing — so the band
    // is NORMAL and the clock is the ordinary one.
    const stamp = await this.deadlines.stamp({ type: ModerationQueueType.PROFESSIONAL_REVIEW });

    // Reset rather than refreshed. The generic `enqueueForReview` deliberately does not reopen an
    // item somebody already decided — §6.6's reasoning, and right for a flag. This is the opposite
    // case: a resubmission after a decline *is* new work, and leaving the item RESOLVED would mean
    // a member who fixed their listing waits for a review nobody can see is outstanding.
    await tx.moderationQueueItem.upsert({
      where: {
        type_targetType_targetId: {
          type: ModerationQueueType.PROFESSIONAL_REVIEW,
          targetType: ReportTargetType.PROFESSIONAL_LISTING,
          targetId: listing.id,
        },
      },
      create: {
        type: ModerationQueueType.PROFESSIONAL_REVIEW,
        targetType: ReportTargetType.PROFESSIONAL_LISTING,
        targetId: listing.id,
        subjectUserId: listing.userId,
        summary: listing.professionTitle,
        payload: { gatedCategories: gated },
        ...stamp,
      },
      update: {
        state: ModerationQueueState.PENDING,
        summary: listing.professionTitle,
        payload: { gatedCategories: gated },
        assignedToId: null,
        decision: null,
        decisionNote: null,
        decidedById: null,
        decidedAt: null,
        // A resubmission is new work, so its clock restarts. Unlike the content scanner's items,
        // where an edit must not reset a reviewer's deadline, here the previous round was
        // *finished* — the member was told what to change and has changed it.
        ...stamp,
      },
    });

    // ── And actually hold it ──────────────────────────────────────────────────
    //
    // The hold used to be left entirely to `assess`, which applies `PENDING_APPROVAL` through the
    // §6.5 column. That works on a create and on an edit that changed the listing's words — and
    // silently does nothing on an edit that did not, because `assess` skips a re-scan when the
    // content hash is unchanged (§6.2 step 2, and rightly: every price change would otherwise
    // re-queue the post for a human).
    //
    // The case that exposed it: swapping an approved listing's **documents**. Nothing scannable
    // changes, so the hash matches, so `assess` returns early — and the listing went to `PENDING`
    // in the workflow while staying publicly visible. A member approved on a genuine certificate
    // could replace it and remain live, which is the hole this method exists to close.
    //
    // So a hold is a hold: this makes sure the content is at least held, and never weakens a
    // stronger one. A listing a scanner held or a staff member hid stays where it is — those are
    // not reachable, and overwriting `HELD` with `PENDING_APPROVAL` would quietly downgrade
    // somebody else's decision.
    const safety = await tx.contentSafety.findUnique({
      where: {
        targetType_targetId: {
          targetType: ReportTargetType.PROFESSIONAL_LISTING,
          targetId: listing.id,
        },
      },
      select: { visibilityState: true },
    });

    if (!safety || isReachable(safety.visibilityState)) {
      await tx.contentSafety.updateMany({
        where: {
          targetType: ReportTargetType.PROFESSIONAL_LISTING,
          targetId: listing.id,
        },
        data: {
          visibilityState: ContentVisibilityState.PENDING_APPROVAL,
          heldReason: HELD_REASON.AWAITING_APPROVAL,
          heldAt: now,
          limitedAt: null,
        },
      });

      await this.safety.mirror(
        tx,
        ReportTargetType.PROFESSIONAL_LISTING,
        listing.id,
        ContentVisibilityState.PENDING_APPROVAL,
      );

      return tx.professionalListing.update({
        where: { id: listing.id },
        data: { visibilityState: ContentVisibilityState.PENDING_APPROVAL },
      });
    }

    return updated;
  }

  /**
   * Lets a listing out of the gate because it is no longer in one.
   *
   * A member who swaps `IMMIGRATION` for `TRANSLATION` is no longer asking to do the thing that
   * needed approving, and must not be left held for a review that will never come. This is the
   * release half of the hold, and the reason it is written next to it: a hold with no release is
   * how content ends up invisible for ever with nobody able to say why.
   *
   * Only releases a hold this feature applied. A listing that is also held by a scanner, or hidden
   * by a staff member, stays where it is — ungating a profession is not a way to launder a hold.
   */
  async release(tx: Tx, listingId: string): Promise<HeldRow & { published: boolean }> {
    const [safety, current] = await Promise.all([
      tx.contentSafety.findUnique({
        where: {
          targetType_targetId: {
            targetType: ReportTargetType.PROFESSIONAL_LISTING,
            targetId: listingId,
          },
        },
        select: { visibilityState: true, heldReason: true },
      }),
      // visibility: the listing's own review state, to decide whether this feature is what is
      // holding it down. No reader is being served.
      tx.professionalListing.findUnique({
        where: { id: listingId },
        select: { reviewState: true },
      }),
    ]);

    // Whether what is keeping this listing down is the one *this* feature put there. A listing a
    // scanner held, or a staff member hid, stays exactly where it is: ungating a profession must
    // not be a way to launder a hold somebody else applied.
    //
    // Two shapes count, not one. The obvious one is a listing still waiting. The other is a
    // listing this feature **declined** — `reviewState: REJECTED` with the safety row rejected to
    // match, which only this flow writes for a listing. Leaving those out meant ungating a
    // profession reset their review state to `NOT_REQUIRED` and left them invisible, with no
    // review left to appeal and no way back: hidden for ever with nobody able to say why, which
    // is the exact failure the comment above this method warns about.
    const waiting =
      safety?.visibilityState === ContentVisibilityState.PENDING_APPROVAL &&
      safety.heldReason === HELD_REASON.AWAITING_APPROVAL;
    const declinedByUs =
      current?.reviewState === ListingReviewState.REJECTED &&
      safety?.visibilityState === ContentVisibilityState.REJECTED;
    const ours = waiting || declinedByUs;

    const updated = await tx.professionalListing.update({
      where: { id: listingId },
      data: {
        reviewState: ListingReviewState.NOT_REQUIRED,
        reviewSubmittedAt: null,
        reviewDecidedAt: null,
        reviewDecidedById: null,
        reviewNote: null,
        // Set here as well as through `mirror` below, so the row handed back to the caller is the
        // released one: `mirror` writes with raw SQL, which this `update`'s return value cannot
        // see, and the caller serialises what it is given.
        ...(ours ? { visibilityState: ContentVisibilityState.VISIBLE } : {}),
      },
    });

    await tx.moderationQueueItem.updateMany({
      where: {
        type: ModerationQueueType.PROFESSIONAL_REVIEW,
        targetType: ReportTargetType.PROFESSIONAL_LISTING,
        targetId: listingId,
        state: { not: ModerationQueueState.RESOLVED },
      },
      data: {
        state: ModerationQueueState.RESOLVED,
        decision: ModerationDecision.NO_ACTION,
        decisionNote: 'No longer in a profession that needs approving.',
        decidedAt: new Date(),
      },
    });

    if (!ours) return { ...updated, published: false };

    // Written directly rather than through `applyDecision`, which records a reviewer: nobody
    // reviewed this. The member changed their own category, and crediting a staff member who was
    // not there would put a name on a decision they did not make.
    await tx.contentSafety.updateMany({
      where: { targetType: ReportTargetType.PROFESSIONAL_LISTING, targetId: listingId },
      data: {
        visibilityState: ContentVisibilityState.VISIBLE,
        heldReason: null,
        heldAt: null,
        limitedAt: null,
        // Cleared with the hold, and this is the part that is easy to miss: `reviewedById` is one
        // of the two things that makes a later re-scan refuse to publish a row (§6.6's
        // `heldByHuman`). A decline's reviewer left behind on a released listing would have the
        // next scan of it quietly pull it back out of reach.
        reviewedAt: null,
        reviewedById: null,
        reviewDecision: null,
      },
    });

    await this.safety.mirror(
      tx,
      ReportTargetType.PROFESSIONAL_LISTING,
      listingId,
      ContentVisibilityState.VISIBLE,
    );

    return { ...updated, published: true };
  }

  /**
   * What the owner is told about their own listing.
   *
   * `isPublic` is separate from `state` because a hold can come from somewhere else: a listing
   * can be `APPROVED` here and still invisible because a scanner or a staff member is holding it,
   * and a member reading "approved" needs to know whether anyone can actually see it.
   *
   * It is no longer the grandfathering flag it was. A `PENDING` listing is hidden, always
   * (BACKEND-NOTES-NEW-ACCOUNTS-ONLY): approval applies to accounts created after a profession was
   * gated, so there is no such thing as live-while-waiting.
   */
  async ownerView(listing: {
    id: string;
    reviewState: ListingReviewState;
    reviewSubmittedAt: Date | null;
    reviewDecidedAt: Date | null;
    reviewNote: string | null;
    visibilityState: ContentVisibilityState;
  }): Promise<{
    state: ListingReviewState;
    isPublic: boolean;
    submittedAt: string | null;
    decidedAt: string | null;
    note: string | null;
    message: string | null;
    documents: Array<{ id: string; fileName: string; mimeType: string; sizeBytes: number }>;
  } | null> {
    if (listing.reviewState === ListingReviewState.NOT_REQUIRED) return null;

    const isPublic = listing.visibilityState === ContentVisibilityState.VISIBLE;
    // What they sent, so the resubmission form opens on their current documents rather than empty
    // — which would make "update and resubmit" mean "upload everything again".
    const documents = await this.documents.current(listing.id);

    return {
      state: listing.reviewState,
      isPublic,
      submittedAt: listing.reviewSubmittedAt?.toISOString() ?? null,
      decidedAt: listing.reviewDecidedAt?.toISOString() ?? null,
      note: listing.reviewNote,
      message: REVIEW_MESSAGE[listing.reviewState]?.(isPublic) ?? null,
      documents: documents.map(row => this.documents.toMemberView(row)),
    };
  }
}

/**
 * The sentence the member reads. Owned by the server, per 0.4 — and deliberately not an accusation
 * on the pending states: the overwhelming majority of these are approved.
 */
const REVIEW_MESSAGE: Partial<Record<ListingReviewState, (isPublic: boolean) => string>> = {
  [ListingReviewState.PENDING]: isPublic =>
    isPublic
      ? 'Your listing is live while our team reviews it, because this kind of work is regulated. We will be in touch if anything is missing.'
      : 'Our team is checking this listing because this kind of work is regulated. It usually takes a day or two, and it goes live as soon as it is approved.',
  [ListingReviewState.APPROVED]: () => 'Approved. Your listing is live.',
  [ListingReviewState.REJECTED]: () =>
    'This listing was not approved, so it is not visible to others. Make the changes below and save to send it back to us.',
};
