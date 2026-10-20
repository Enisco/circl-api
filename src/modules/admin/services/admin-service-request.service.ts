import { Injectable } from '@nestjs/common';
import {
  CategoryVerificationStatus,
  ListingVerificationStatus,
  NotificationKind,
  Prisma,
  ServiceRequestOfferStatus,
  ServiceRequestState,
  TaxonomyKind,
} from '@prisma/client';
import { ApiErrorCode, ApiException, buildPageMeta, money } from '@/common';
import { PrismaService } from '@/infrastructure';
import {
  ACTIVE_AUTHOR,
  CityService,
  MediaService,
  PUBLIC_VISIBILITY,
  TaxonomyService,
  toCityView,
  toTermView,
} from '@/modules/platform/shared';
import { NotificationFeedService } from '@/modules/platform/notifications';
import { ACCEPTANCE_CAP, OFFER_TTL_HOURS } from '@/modules/platform/professionals';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import {
  ListServiceRequestsDto,
  OPEN_REQUEST_STATES,
  OfferRequestDto,
  SearchProfessionalsDto,
  SendOutcomeDto,
  SetRequestCategoryDto,
} from '../dtos/admin-service-request.dto';
import { toMemberRef } from '../serializers/admin-member.serializer';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';

/** The sorts the queue offers. An allowlist, so `sort` cannot name a column. */
export const REQUEST_SORTS = ['createdAt', 'urgency'] as const;

/** What a staff list needs of a request. The member's words travel in full: they are the request. */
const REQUEST_SELECT = {
  id: true,
  description: true,
  state: true,
  urgency: true,
  budget: true,
  budgetText: true,
  currency: true,
  categoryCode: true,
  adminCategoryCode: true,
  note: true,
  outcomeSentAt: true,
  createdAt: true,
  updatedAt: true,
  city: { select: { id: true, name: true, region: true } },
  user: { select: caseMemberSelect },
} satisfies Prisma.ServiceRequestSelect;

type RequestRow = Prisma.ServiceRequestGetPayload<{ select: typeof REQUEST_SELECT }>;

/**
 * The staff half of "let Circl handle it" (§3).
 *
 * A queue, a category, a search, an offer and an outcome — in that order, because that is the
 * order somebody works a request in. Nothing here ranks professionals or picks one: the search
 * narrows, and a person decides. That is the whole feature, and anything that scored candidates
 * would be rebuilding the matcher this replaced.
 */
@Injectable()
export class AdminServiceRequestService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly cities: CityService,
    private readonly taxonomy: TaxonomyService,
    private readonly notifications: NotificationFeedService,
    private readonly audit: AuditService,
  ) {}

  // ─── The queue ─────────────────────────────────────────────────────────────

  async list(query: ListServiceRequestsDto) {
    query.assertDepth();

    const states = query.state?.length ? query.state : OPEN_REQUEST_STATES;
    const where: Prisma.ServiceRequestWhereInput = {
      state: { in: states },
      ...(query.urgency?.length ? { urgency: { in: query.urgency } } : {}),
      ...(query.cityIds?.length ? { cityId: { in: query.cityIds } } : {}),
      ...(query.categories?.length
        ? {
            OR: [
              { adminCategoryCode: { in: query.categories } },
              { adminCategoryCode: null, categoryCode: { in: query.categories } },
            ],
          }
        : {}),
      ...(query.uncategorised === 'true' ? { adminCategoryCode: null } : {}),
      ...(query.q ? { description: { contains: query.q, mode: 'insensitive' } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows, waiting] = await this.database.$transaction([
      this.database.serviceRequest.count({ where }),
      this.database.serviceRequest.findMany({
        where,
        select: REQUEST_SELECT,
        orderBy:
          query.sortField([...REQUEST_SORTS], 'createdAt') === 'urgency'
            ? // Prisma sorts an enum by its declared order, which is most-urgent-first here —
              // stated rather than assumed, because the day somebody reorders `BriefUrgency` this
              // becomes a sort that quietly means something else.
              [{ urgency: 'asc' }, { createdAt: 'desc' }]
            : [{ createdAt: query.order === 'asc' ? 'asc' : 'desc' }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
      // Counted whatever the filters, so the badge does not move as somebody switches tabs.
      this.database.serviceRequest.count({
        where: { state: ServiceRequestState.SUBMITTED },
      }),
    ]);

    const labels = await this.taxonomy.labels(TaxonomyKind.PROFESSION);
    const counts = await this.offerCounts(rows.map(row => row.id));

    return {
      data: rows.map(row => this.toRow(row, labels, counts.get(row.id))),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        unread: waiting,
      }),
    };
  }

  /** One request, with every offer on it and what each professional said. */
  async detail(id: string) {
    const row = await this.database.serviceRequest.findUnique({
      where: { id },
      select: REQUEST_SELECT,
    });

    if (!row) throw ApiException.notFound('No such request.');

    const [labels, offers] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.database.serviceRequestOffer.findMany({
        where: { requestId: id },
        orderBy: { offeredAt: 'asc' },
        select: {
          id: true,
          status: true,
          offeredAt: true,
          respondedAt: true,
          expiresAt: true,
          conversationId: true,
          listingId: true,
          offeredById: true,
          professional: { select: caseMemberSelect },
        },
      }),
    ]);

    const counts = await this.offerCounts([id]);

    return {
      ...this.toRow(row, labels, counts.get(id)),
      /** Who was asked and what they said — the half the member never sees. */
      offers: offers.map(offer => ({
        id: offer.id,
        professional: toMemberRef(offer.professional, this.media.sign),
        listingId: offer.listingId,
        status: offer.status,
        offeredAt: offer.offeredAt.toISOString(),
        respondedAt: offer.respondedAt?.toISOString() ?? null,
        expiresAt: offer.expiresAt.toISOString(),
        conversationId: offer.conversationId,
      })),
    };
  }

  // ─── The category ──────────────────────────────────────────────────────────

  /**
   * Record what kind of help this is.
   *
   * Written to its own column, beside the member's guess rather than over it. The member may have
   * said nothing, or said something wrong; both are useful to the next person to read the row, and
   * neither is improved by being overwritten with Circl's answer.
   */
  async setCategory(actor: AdminPrincipal, id: string, dto: SetRequestCategoryDto) {
    const request = await this.require(id);

    await this.taxonomy.assertValid(TaxonomyKind.PROFESSION, dto.categoryCode, 'categoryCode');

    await this.audit.mutate(
      {
        action: 'service_request.category_set' as const,
        targetType: 'SERVICE_REQUEST' as const,
        targetId: id,
        before: { adminCategoryCode: request.adminCategoryCode },
        after: { adminCategoryCode: dto.categoryCode },
        metadata: { memberGuess: request.categoryCode },
      },
      tx =>
        tx.serviceRequest.update({
          where: { id },
          data: { adminCategoryCode: dto.categoryCode },
          select: { id: true },
        }),
    );

    return this.detail(id);
  }

  // ─── The search ────────────────────────────────────────────────────────────

  /**
   * Professionals who could actually take this on.
   *
   * Scoped, not scored, and **not filtered by verification** — that is the product owner's call
   * (20 Oct) and it is the right one. A request names a profession at most, never a subcategory,
   * so there is no honest way to tell from it whether the work is regulated: "Immigration" covers
   * both help with visa paperwork and IAA-regulated advice. Filtering the whole profession
   * whenever one of its subcategories is gated hid every unverified tradesperson from a request
   * about a dripping tap, because gas work is gated.
   *
   * So the facts travel instead of a filter: `verifiedInCategory` per row,
   * `meta.hasRegulatedWork` for the profession, and a person decides. That person deciding is the
   * whole of what this feature has over Browse.
   *
   * The ordering is the only opinion the server has, and it is "most recently updated listing
   * first" rather than anything that could be mistaken for a recommendation.
   */
  async searchProfessionals(id: string, query: SearchProfessionalsDto) {
    query.assertDepth();

    const request = await this.require(id);
    const categoryCode = query.categoryCode ?? request.adminCategoryCode ?? request.categoryCode;
    const regulated = categoryCode ? await this.hasRegulatedWork(categoryCode) : false;

    const where: Prisma.ProfessionalListingWhereInput = {
      user: {
        ...ACTIVE_AUTHOR,
        id: { not: request.userId },
      },
      deletedAt: null,
      ...PUBLIC_VISIBILITY,
      isAcceptingWork: true,
      verificationStatus: { not: ListingVerificationStatus.DRAFT },
      ...(categoryCode ? { categories: { some: { code: categoryCode } } } : {}),
      ...(query.cityId ? { cityId: query.cityId } : {}),
      ...(query.q
        ? {
            OR: [
              { professionTitle: { contains: query.q, mode: 'insensitive' } },
              { user: { firstName: { contains: query.q, mode: 'insensitive' } } },
              { user: { lastName: { contains: query.q, mode: 'insensitive' } } },
              { services: { some: { name: { contains: query.q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.professionalListing.count({ where }),
      this.database.professionalListing.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
        select: {
          id: true,
          userId: true,
          professionTitle: true,
          isAcceptingWork: true,
          city: { select: { id: true, name: true, region: true } },
          categories: { select: { code: true } },
          user: { select: caseMemberSelect },
        },
      }),
    ]);

    // Who already has an offer, so the portal can say "offered" rather than letting somebody
    // offer it twice and be told nothing happened.
    const already = await this.database.serviceRequestOffer.findMany({
      where: { requestId: id, professionalId: { in: rows.map(row => row.userId) } },
      select: { professionalId: true, status: true },
    });
    const offered = new Map(already.map(row => [row.professionalId, row.status] as const));
    const labels = await this.taxonomy.labels(TaxonomyKind.PROFESSION);
    const verified = await this.verifiedIn(
      categoryCode,
      rows.map(row => row.userId),
    );

    return {
      data: rows.map(row => ({
        professionalId: row.userId,
        listingId: row.id,
        professional: toMemberRef(row.user, this.media.sign),
        professionTitle: row.professionTitle,
        category: toTermView(row.categories[0]?.code ?? null, labels),
        city: toCityView(row.city),
        acceptingWork: row.isAcceptingWork,
        offerStatus: offered.get(row.userId) ?? null,
        /**
         * Whether they hold a live approval in the category being searched.
         *
         * The fact staff judge on, now that nothing filters on it. False where the category is
         * unknown, which is honest: nobody is verified in nothing.
         */
        verifiedInCategory: verified.has(row.userId),
      })),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        categoryCode: categoryCode ?? null,
        /**
         * "This profession contains regulated work", not "this list was filtered".
         *
         * Renamed from `gatedCategory`, which described a gate that no longer exists and would
         * have read to the next person as though the list had been narrowed.
         */
        hasRegulatedWork: regulated,
      }),
    };
  }

  // ─── The offer ─────────────────────────────────────────────────────────────

  /**
   * Offer the request to several professionals at once.
   *
   * An offer, not an assignment: nothing is given to anybody, and each of them still chooses.
   * Offering to somebody who already has an offer on this request is skipped rather than refused —
   * a staff member who double-taps has made no mistake worth a red box, and the unique index
   * behind it means the second write could not have landed anyway.
   */
  async offer(actor: AdminPrincipal, id: string, dto: OfferRequestDto) {
    const request = await this.require(id);

    /**
     * Only a withdrawal stops this.
     *
     * `NO_MATCH` deliberately does not: offering a closed request to somebody new **is** the
     * re-offer, and it moves the request back to `MATCHING` below. Refusing it would have meant
     * staff first changing a state through a superseded endpoint to do the obvious thing, which
     * is how a flow ends up with a step nobody can explain. A request the member withdrew is
     * different — that was their decision, not a dead end of ours.
     */
    if (request.state === ServiceRequestState.CANCELLED) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'The member withdrew this request.',
        { data: { state: request.state } },
      );
    }

    const accepted = await this.database.serviceRequestOffer.count({
      where: { requestId: id, status: ServiceRequestOfferStatus.ACCEPTED },
    });

    if (accepted >= ACCEPTANCE_CAP) {
      throw ApiException.conflict(
        ApiErrorCode.SERVICE_REQUEST_FILLED,
        `Three professionals have already taken this on.`,
        { data: { cap: ACCEPTANCE_CAP } },
      );
    }

    // Deduplicated, because the same id twice is a double-tap rather than two people — and the
    // existence check below would otherwise read it as an unknown id and refuse the lot.
    const professionalIds = [...new Set(dto.professionalIds)];

    if (professionalIds.includes(request.userId)) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'That is the member who raised this request.',
        {
          details: [
            { field: 'professionalIds', message: 'A member cannot be offered their own request.' },
          ],
        },
      );
    }

    /**
     * The same rules the search applies, applied again here — and verification is not one of
     * them.
     *
     * The re-check exists because the search is a convenience, not a gate: these ids arrive in a
     * request body, and nothing stops a portal, a mistake or a terminal sending one that never
     * appeared in it. What it checks is whether somebody *can be worked with* — a live listing,
     * taking work, still on the platform — and not whether staff should have chosen them. That
     * second judgement is the staff member's, and verification is shown to them rather than
     * enforced against them (product owner, 20 Oct).
     */
    const eligible = await this.database.professionalListing.findMany({
      where: {
        userId: { in: professionalIds },
        deletedAt: null,
        ...PUBLIC_VISIBILITY,
        isAcceptingWork: true,
        verificationStatus: { not: ListingVerificationStatus.DRAFT },
        user: { ...ACTIVE_AUTHOR, isAnonymised: false },
      },
      select: { id: true, userId: true },
    });
    const listingFor = new Map(eligible.map(row => [row.userId, row.id] as const));

    if (eligible.length !== professionalIds.length) {
      const missing = professionalIds.filter(who => !listingFor.has(who));

      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'One of those professionals cannot take this on: they are not listed, not taking work, ' +
          'or no longer on the platform.',
        {
          details: [{ field: 'professionalIds', message: 'Not eligible for this request.' }],
          data: { ineligible: missing },
        },
      );
    }

    // Who already had one before this call, so only the people actually being asked are told.
    // `offered` already reports this to staff; the notification has to agree with it, or a second
    // press of the button buzzes somebody about work they were offered yesterday.
    const alreadyOffered = new Set(
      (
        await this.database.serviceRequestOffer.findMany({
          where: { requestId: id, professionalId: { in: professionalIds } },
          select: { professionalId: true },
        })
      ).map(row => row.professionalId),
    );

    const expiresAt = new Date(Date.now() + OFFER_TTL_HOURS * 3_600_000);

    const created = await this.audit.mutate(
      {
        action: 'service_request.offered' as const,
        targetType: 'SERVICE_REQUEST' as const,
        targetId: id,
        before: { state: request.state },
        after: { state: ServiceRequestState.MATCHING },
        metadata: { professionalIds, expiresAt: expiresAt.toISOString() },
      },
      async tx => {
        // Re-read inside the write: the count above this is a courtesy that gives staff a clear
        // message, and this is the one that holds. Offers sent to a request that filled while the
        // portal was open are notifications a professional cannot act on.
        const takenOn = await tx.serviceRequestOffer.count({
          where: { requestId: id, status: ServiceRequestOfferStatus.ACCEPTED },
        });

        if (takenOn >= ACCEPTANCE_CAP) {
          throw ApiException.conflict(
            ApiErrorCode.SERVICE_REQUEST_FILLED,
            'Three professionals have already taken this on.',
            { data: { cap: ACCEPTANCE_CAP } },
          );
        }

        const result = await tx.serviceRequestOffer.createMany({
          data: professionalIds.map(professionalId => ({
            requestId: id,
            professionalId,
            listingId: listingFor.get(professionalId) ?? null,
            offeredById: actor.id,
            expiresAt,
          })),
          skipDuplicates: true,
        });

        // Offers are out, so the member's screen stops saying nobody has read it — and a request
        // that had been closed as "nobody available" is open again, which is what the member
        // needs to see. Not from `MATCHED`: somebody has taken that one on, and a fourth offer
        // does not undo it.
        if (
          request.state === ServiceRequestState.SUBMITTED ||
          request.state === ServiceRequestState.NO_MATCH
        ) {
          await tx.serviceRequest.update({
            where: { id },
            data: { state: ServiceRequestState.MATCHING },
          });
        }

        return result;
      },
    );

    // Read back rather than counted: each professional's notification points at *their* offer,
    // and `createMany` does not return rows.
    const sent = await this.database.serviceRequestOffer.findMany({
      where: {
        requestId: id,
        professionalId: { in: professionalIds.filter(who => !alreadyOffered.has(who)) },
      },
      select: { id: true, professionalId: true },
    });

    await this.tellProfessionals(id, sent);

    return { ...(await this.detail(id)), offered: created.result.count };
  }

  /** Take an outstanding offer back. Only a pending one: an answer is not undone. */
  async withdrawOffer(actor: AdminPrincipal, id: string, offerId: string) {
    const offer = await this.database.serviceRequestOffer.findUnique({
      where: { id: offerId },
      select: { id: true, requestId: true, status: true, professionalId: true },
    });

    if (!offer || offer.requestId !== id) throw ApiException.notFound('No such offer.');

    if (offer.status !== ServiceRequestOfferStatus.PENDING) {
      throw ApiException.conflict(
        ApiErrorCode.ALREADY_DECIDED,
        'That offer has already been answered.',
        { data: { status: offer.status } },
      );
    }

    await this.audit.mutate(
      {
        action: 'service_request.offer_withdrawn' as const,
        targetType: 'SERVICE_REQUEST' as const,
        targetId: id,
        before: { status: offer.status },
        after: { status: ServiceRequestOfferStatus.REVOKED },
        metadata: { offerId, professionalId: offer.professionalId },
      },
      async tx => {
        /**
         * Guarded on the status, not just checked above it.
         *
         * A professional accepting between the read and the write is a narrow window and a bad
         * outcome: an unguarded update would stamp `REVOKED` over their acceptance and leave the
         * thread they had already been introduced in belonging to nothing.
         */
        const { count } = await tx.serviceRequestOffer.updateMany({
          where: { id: offerId, status: ServiceRequestOfferStatus.PENDING },
          data: { status: ServiceRequestOfferStatus.REVOKED },
        });

        if (!count) {
          throw ApiException.conflict(
            ApiErrorCode.ALREADY_DECIDED,
            'That offer was answered while you were looking at it.',
          );
        }

        return { id: offerId };
      },
    );

    return this.detail(id);
  }

  // ─── The outcome ───────────────────────────────────────────────────────────

  /**
   * Tell the member how it went.
   *
   * The "nobody available" one matters more than the good one. A request that goes quiet is worse
   * for a member than one that was refused: they are left wondering whether to go and find
   * somebody themselves, and nothing on their screen answers that. So `NONE` is a first-class
   * outcome here rather than an absence, and it closes the request and revokes anything still out.
   */
  async sendOutcome(actor: AdminPrincipal, id: string, dto: SendOutcomeDto) {
    const request = await this.require(id);

    if (request.state === ServiceRequestState.CANCELLED) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'The member withdrew this request.',
        { data: { state: request.state } },
      );
    }

    const accepted = await this.database.serviceRequestOffer.count({
      where: { requestId: id, status: ServiceRequestOfferStatus.ACCEPTED },
    });

    if (dto.outcome === 'FOUND' && accepted === 0) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Nobody has accepted this request yet, so there is nothing to tell the member about.',
        { details: [{ field: 'outcome', message: 'No acceptances.' }] },
      );
    }

    /**
     * And the other way round, which is worse.
     *
     * "We could not find anybody" sent after somebody accepted tells a member nothing was found
     * while the professional who took it on is sitting in a thread with them, waiting. The member
     * is then being contradicted by their own inbox.
     */
    if (dto.outcome === 'NONE' && accepted > 0) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        accepted === 1
          ? 'Somebody has already taken this on, so the member cannot be told nobody was found.'
          : `${accepted} professionals have already taken this on, so the member cannot be told ` +
            'nobody was found.',
        {
          details: [{ field: 'outcome', message: 'There are acceptances on this request.' }],
          data: { accepted },
        },
      );
    }

    const state =
      dto.outcome === 'FOUND' ? ServiceRequestState.MATCHED : ServiceRequestState.NO_MATCH;

    await this.audit.mutate(
      {
        action: 'service_request.outcome_sent' as const,
        targetType: 'SERVICE_REQUEST' as const,
        targetId: id,
        before: { state: request.state, note: request.note },
        after: { state, note: dto.note ?? null },
        metadata: { outcome: dto.outcome, accepted },
      },
      async tx => {
        if (dto.outcome === 'NONE') {
          await tx.serviceRequestOffer.updateMany({
            where: { requestId: id, status: ServiceRequestOfferStatus.PENDING },
            data: { status: ServiceRequestOfferStatus.REVOKED },
          });
        }

        return tx.serviceRequest.update({
          where: { id },
          data: {
            state,
            note: dto.note ?? request.note,
            outcomeSentAt: new Date(),
            outcomeById: actor.id,
          },
          select: { id: true },
        });
      },
    );

    this.notifications.raise({
      userId: request.userId,
      kind: NotificationKind.SERVICE_REQUEST,
      categoryCode: 'BOOKINGS',
      title:
        dto.outcome === 'FOUND'
          ? accepted === 1
            ? 'Someone is taking on your request'
            : `${accepted} professionals are taking on your request`
          : 'We could not find anybody for your request',
      body:
        dto.outcome === 'FOUND'
          ? 'They will message you here.'
          : (dto.note ?? 'Have a look through Browse — there may be somebody we missed.'),
      // The request, never the conversation: the other outcome is that there is no conversation.
      target: { type: 'SERVICE_REQUEST', id },
      route: `/service-requests/${id}`,
      metadata: { serviceRequestId: id, outcome: dto.outcome },
    });

    return this.detail(id);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Whether this profession contains regulated work.
   *
   * Read from the **subcategories**, which is where the flag lives: Professionals v2 moved it
   * down a level, so `HEALTHCARE` carries nothing while `HEALTH_DOCTOR` and six siblings carry
   * `requiresVerification`.
   *
   * True when **any** active subcategory of the profession is regulated — which is a statement
   * about the profession, not about the request. It is deliberately not a filter: a request names
   * a profession at most, so there is no way to tell from it whether *this* job is the regulated
   * kind, and gating the whole profession hid every unverified tradesperson from a request about
   * a dripping tap. Staff are shown it, with `verifiedInCategory` per person, and they decide.
   *
   * Read here rather than through `CategoryVerificationService`, which lives in
   * `ProfessionalsModule` — the admin surface imports only the core module on purpose, so an
   * admin-only process does not mount the member controllers.
   */
  private async hasRegulatedWork(categoryCode: string): Promise<boolean> {
    const subcategories = await this.taxonomy.list(TaxonomyKind.PROFESSION_SUBCATEGORY);

    return subcategories.some(term => {
      const metadata = term.metadata as
        | { parentCode?: unknown; requiresVerification?: unknown }
        | null;

      return metadata?.parentCode === categoryCode && metadata?.requiresVerification === true;
    });
  }

  /**
   * Who, of these people, holds a live approval in this category.
   *
   * "Live" means `APPROVED` and not past its renewal date. An approval that lapsed last month is
   * not a fact staff should be shown as current — the renewal date is the whole reason regulated
   * categories have one, and `expiresAt: null` means it does not lapse at all.
   *
   * One query for the page rather than one per row, and it answers the question the portal was
   * otherwise asking separately — which only worked for staff who also held `content:read`.
   */
  private async verifiedIn(
    categoryCode: string | null | undefined,
    userIds: string[],
  ): Promise<Set<string>> {
    if (!categoryCode || !userIds.length) return new Set();

    const rows = await this.database.categoryVerification.findMany({
      where: {
        categoryCode,
        userId: { in: userIds },
        status: CategoryVerificationStatus.APPROVED,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { userId: true },
    });

    return new Set(rows.map(row => row.userId));
  }

  private async require(id: string) {
    const request = await this.database.serviceRequest.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        state: true,
        note: true,
        description: true,
        categoryCode: true,
        adminCategoryCode: true,
      },
    });

    if (!request) throw ApiException.notFound('No such request.');

    return request;
  }

  /** Offered / accepted / declined, per request, for the queue's own columns. */
  private async offerCounts(ids: string[]) {
    if (!ids.length) return new Map<string, Record<string, number>>();

    const grouped = await this.database.serviceRequestOffer.groupBy({
      by: ['requestId', 'status'],
      where: { requestId: { in: ids } },
      _count: { _all: true },
    });

    const counts = new Map<string, Record<string, number>>();

    for (const row of grouped) {
      const existing = counts.get(row.requestId) ?? {};

      existing[row.status] = row._count._all;
      counts.set(row.requestId, existing);
    }

    return counts;
  }

  private toRow(row: RequestRow, labels: Map<string, string>, counts?: Record<string, number>) {
    return {
      id: row.id,
      member: toMemberRef(row.user, this.media.sign),
      /** In full, never truncated: the member's own words are the request. */
      description: row.description,
      state: row.state,
      urgency: row.urgency,
      budget: money(row.budget, row.currency),
      /** What they typed, where it was not a figure. Shown as typed and parsed by nothing. */
      budgetText: row.budgetText,
      /** Circl's decision, and the member's guess, kept apart on purpose. */
      category: toTermView(row.adminCategoryCode, labels),
      memberCategory: toTermView(row.categoryCode, labels),
      city: toCityView(row.city),
      note: row.note,
      outcomeSentAt: row.outcomeSentAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      counts: {
        offered: Object.values(counts ?? {}).reduce((total, count) => total + count, 0),
        pending: counts?.[ServiceRequestOfferStatus.PENDING] ?? 0,
        accepted: counts?.[ServiceRequestOfferStatus.ACCEPTED] ?? 0,
        declined: counts?.[ServiceRequestOfferStatus.DECLINED] ?? 0,
        expired: counts?.[ServiceRequestOfferStatus.EXPIRED] ?? 0,
      },
    };
  }

  /**
   * The professionals, told there is work waiting.
   *
   * Without the member's name or their words: an offer is a question put to somebody who has not
   * agreed to anything yet, and the request itself is one tap away in their own inbox.
   */
  private async tellProfessionals(
    requestId: string,
    offers: Array<{ id: string; professionalId: string }>,
  ): Promise<void> {
    for (const offer of offers) {
      this.notifications.raise({
        userId: offer.professionalId,
        kind: NotificationKind.SERVICE_REQUEST,
        categoryCode: 'BOOKINGS',
        title: 'Circl has a request for you',
        body: 'Somebody asked us to find them help. Have a look and say whether it is for you.',
        /**
         * Their offer, not the request.
         *
         * The request belongs to the member who raised it and answers 404 to everybody else, so
         * a professional routed at it lands on a screen they cannot read. Every other
         * notification in this feature targets the request because every other one goes to the
         * member whose request it is.
         */
        target: { type: 'SERVICE_REQUEST_OFFER', id: offer.id },
        route: '/professionals/offers',
        metadata: { serviceRequestId: requestId, offerId: offer.id },
      });
    }
  }
}
