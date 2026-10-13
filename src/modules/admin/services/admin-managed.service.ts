import { Injectable } from '@nestjs/common';
import {
  BriefState,
  BriefUrgency,
  JobState,
  ManagedRequestClosedReason,
  ManagedRequestState,
  NotificationKind,
  Prisma,
  SystemMessageType,
  TaxonomyKind,
} from '@prisma/client';
import { ApiErrorCode, ApiException, buildPageMeta } from '@/common';
import { PrismaService } from '@/infrastructure';
import { CityService, MediaService, TaxonomyService } from '@/modules/platform/shared';
import { ConversationFactoryService } from '@/modules/platform/messaging';
import { NotificationFeedService } from '@/modules/platform/notifications';
import { BookingService } from '@/modules/platform/professionals';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import { AdminAssigneeService } from './admin-assignee.service';
import {
  BRIEF_SORTS,
  ListBriefsDto,
  ListManagedRequestsDto,
  OPEN_MANAGED_STATES,
  PlaceBriefDto,
  UpdateBriefDto,
  UpdateManagedRequestDto,
} from '../dtos/admin-managed.dto';
import { CityRefView, CodeView } from '../serializers/admin-content.serializer';
import { toMemberRef } from '../serializers/admin-member.serializer';
import { caseMemberSelect } from '../serializers/admin-report-case.serializer';
import { StaffRefView, staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';

/**
 * §7.7's two state machines, written out.
 *
 * A managed request moves forward only: `OPEN → IN_PROGRESS → CLOSED`, and closed is final. A
 * brief is looser because a placement can fail — `PLACED → OPEN` exists so staff can place it
 * again — and that one transition is the only one that needs a permission of its own.
 */
const REQUEST_TRANSITIONS: Record<ManagedRequestState, ManagedRequestState[]> = {
  OPEN: [ManagedRequestState.IN_PROGRESS, ManagedRequestState.CLOSED],
  IN_PROGRESS: [ManagedRequestState.OPEN, ManagedRequestState.CLOSED],
  // Final. A member whose request was closed and who comes back raises a new one, which is the
  // honest record: two requests, two outcomes, rather than one row that was reopened and whose
  // closing reason now describes something that did not end.
  CLOSED: [],
};

const BRIEF_TRANSITIONS: Record<BriefState, BriefState[]> = {
  // A draft is the member's own, before they send it. Staff never see one in the pipeline, and
  // listing it here rather than leaving the record incomplete is what makes the table exhaustive:
  // the day `DRAFT` reaches this service, it is refused rather than crashing on a missing key.
  DRAFT: [BriefState.OPEN, BriefState.CLOSED],
  OPEN: [BriefState.MATCHED, BriefState.CLOSED],
  MATCHED: [BriefState.OPEN, BriefState.CLOSED],
  PLACED: [BriefState.OPEN, BriefState.CLOSED],
  CLOSED: [],
};

/** Most urgent first, on the enum's own order rather than alphabetically. */
const URGENCY_ORDER: BriefUrgency[] = [
  BriefUrgency.ASAP,
  BriefUrgency.THIS_WEEK,
  BriefUrgency.THIS_MONTH,
  BriefUrgency.FLEXIBLE,
];

/**
 * §5.16: the support pipeline — managed requests and briefs.
 *
 * Two kinds of work that look alike and are not. A **managed request** is a member asking Circl to
 * do something for them — set up their shop, find them a professional — and it is a job with an
 * owner and an ending. A **brief** is the professional side of one of those: a description of the
 * work, a shortlist computed from it, and a placement.
 *
 * What makes this a pipeline rather than a list is the two things a pipeline needs and a list does
 * not: somebody's name on each row, and a reason it ended. Both are new columns, and the closing
 * reason is required by §7.7 for a reason worth stating — "closed" with no reason makes the two
 * numbers this pipeline exists to produce (we placed them / we could not help) indistinguishable
 * from each other.
 *
 * The member hears about it. Every state change posts a system message into the thread they
 * already have open with the Circl team, and notifies them: a managed request is a promise that
 * somebody is dealing with it, and a pipeline that moves silently is one the member experiences as
 * nothing happening.
 */
/**
 * Booking states that need no releasing: nothing is live, so a brief can open again freely.
 *
 * `EXPIRED` is in here because an offer the professional never answered has lapsed on its own,
 * which is the same fact as a cancellation for this purpose.
 */
const RELEASED_STATES: JobState[] = [JobState.CANCELLED, JobState.EXPIRED];

@Injectable()
export class AdminManagedService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly cities: CityService,
    private readonly taxonomy: TaxonomyService,
    private readonly conversations: ConversationFactoryService,
    private readonly notifications: NotificationFeedService,
    private readonly bookings: BookingService,
    private readonly assignees: AdminAssigneeService,
    private readonly audit: AuditService,
  ) {}

  // ─── Managed requests ──────────────────────────────────────────────────────

  async listRequests(actor: AdminPrincipal, query: ListManagedRequestsDto) {
    query.assertDepth();

    const where: Prisma.ManagedRequestWhereInput = {
      state: { in: query.state?.length ? query.state : OPEN_MANAGED_STATES },
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.assignedToId ? { assignedToId: query.assignedToId } : {}),
      ...(query.unassigned ? { assignedToId: null } : {}),
      // The member's city, not the request's: a managed request has no city of its own, and
      // "which city is this work in" is a question about the person who asked.
      ...(query.cityIds?.length ? { user: { profile: { cityId: { in: query.cityIds } } } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.managedRequest.count({ where }),
      this.database.managedRequest.findMany({
        where,
        select: REQUEST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    const [staff, helpAreas] = await Promise.all([
      this.staffFor(rows.map(row => row.assignedToId)),
      this.taxonomy.labels(TaxonomyKind.STORE_HELP_AREA),
    ]);

    return {
      data: rows.map(row => this.toRequestRow(row, staff, helpAreas)),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        // The two numbers the pipeline's header shows, and they ignore the filters on purpose: a
        // badge that changes as somebody moves between tabs is not a badge.
        unassigned: await this.database.managedRequest.count({
          where: { state: { in: OPEN_MANAGED_STATES }, assignedToId: null },
        }),
        mine: await this.database.managedRequest.count({
          where: { state: { in: OPEN_MANAGED_STATES }, assignedToId: actor.id },
        }),
      }),
    };
  }

  async requestDetail(id: string) {
    const row = await this.database.managedRequest.findUnique({
      where: { id },
      select: REQUEST_SELECT,
    });

    if (!row) throw ApiException.notFound('No such managed request.');

    const staff = await this.staffFor([row.assignedToId]);
    const helpAreas = await this.taxonomy.labels(TaxonomyKind.STORE_HELP_AREA);
    const [store, brief, notes] = await Promise.all([
      row.storeId
        ? this.database.store.findUnique({
            where: { id: row.storeId },
            select: {
              id: true,
              name: true,
              typeCode: true,
              cityId: true,
              complianceState: true,
              visibilityState: true,
              createdAt: true,
            },
          })
        : Promise.resolve(null),
      row.briefId ? this.briefRow(row.briefId) : Promise.resolve(null),
      this.database.internalNote.findMany({
        where: { subjectType: 'MANAGED_REQUEST', subjectId: id, deletedAt: null },
        select: { id: true, body: true, isPinned: true, createdAt: true, authorId: true },
        orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
        take: 50,
      }),
    ]);

    const authors = await this.staffFor(notes.map(note => note.authorId));

    return {
      ...this.toRequestRow(row, staff, helpAreas),
      notes: row.notes,
      store,
      brief,
      // §5.16's `internalNotes`. Served here rather than left to `admin/notes?subjectType=…`
      // because a pipeline row is read once and the notes are the handover between two people
      // working the same request on different days.
      internalNotes: notes.map(note => ({
        id: note.id,
        body: note.body,
        isPinned: note.isPinned,
        author: authors.get(note.authorId) ?? null,
        createdAt: note.createdAt.toISOString(),
      })),
    };
  }

  /** §7.7: move it along, give it to somebody, or close it with a reason. */
  async updateRequest(actor: AdminPrincipal, id: string, dto: UpdateManagedRequestDto) {
    dto.assertSomething();

    const row = await this.database.managedRequest.findUnique({
      where: { id },
      select: { ...REQUEST_SELECT, userId: true },
    });

    if (!row) throw ApiException.notFound('No such managed request.');

    const state = dto.state ?? row.state;

    if (dto.state && dto.state !== row.state) {
      this.assertTransition(REQUEST_TRANSITIONS, row.state, dto.state, 'request');
    }

    if (state === ManagedRequestState.CLOSED && !(dto.closedReason ?? row.closedReason)) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Say why it is closing: a closed request with no reason cannot be reported on.',
        { details: [{ field: 'closedReason', message: 'closedReason is required to close.' }] },
      );
    }

    if (dto.assigneeId) {
      await this.assignees.assertHolds(dto.assigneeId, ['managed:manage'], 'assigneeId');
    }

    const now = new Date();
    const note = dto.note?.trim();

    const { result } = await this.audit.mutate(
      {
        action: 'managed.updated' as const,
        targetType: 'MANAGED_REQUEST' as const,
        targetId: id,
        before: { state: row.state, assignedToId: row.assignedToId },
        after: {
          state,
          assignedToId: dto.assigneeId === undefined ? row.assignedToId : dto.assigneeId,
          closedReason: dto.closedReason ?? row.closedReason,
        },
        metadata: { note: note ?? null },
      },
      tx =>
        tx.managedRequest.update({
          where: { id },
          data: {
            ...(dto.state ? { state: dto.state } : {}),
            ...(dto.assigneeId === undefined
              ? {}
              : {
                  assignedToId: dto.assigneeId,
                  assignedAt: dto.assigneeId ? now : null,
                }),
            ...(dto.closedReason ? { closedReason: dto.closedReason } : {}),
            ...(state === ManagedRequestState.CLOSED && !row.closedAt ? { closedAt: now } : {}),
            // Appended rather than replaced, with the date and the person: the notes column is the
            // running record of a job several people work on, and a `PATCH` that overwrote it
            // would lose the handover it exists to carry.
            ...(note
              ? {
                  notes: [row.notes, `[${now.toISOString().slice(0, 10)} ${actor.email}] ${note}`]
                    .filter(Boolean)
                    .join('\n'),
                }
              : {}),
          },
          select: { ...REQUEST_SELECT, userId: true },
        }),
    );

    if (dto.state && dto.state !== row.state) {
      await this.tellMemberAboutRequest(result, dto.state, dto.closedReason ?? row.closedReason);
    }

    return this.requestDetail(id);
  }

  // ─── Briefs ────────────────────────────────────────────────────────────────

  async listBriefs(query: ListBriefsDto) {
    query.assertDepth();

    const where: Prisma.ManagedBriefWhereInput = {
      ...(query.state?.length ? { state: { in: query.state } } : {}),
      ...(query.urgency?.length ? { urgency: { in: query.urgency } } : {}),
      ...(query.categories?.length ? { categoryCode: { in: query.categories } } : {}),
      ...(query.cityIds?.length ? { cityId: { in: query.cityIds } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.managedBrief.count({ where }),
      this.database.managedBrief.findMany({
        where,
        select: BRIEF_SELECT,
        orderBy:
          query.sortField([...BRIEF_SORTS], 'createdAt') === 'urgency'
            ? // Prisma sorts an enum by its declared order, which is most-urgent-first here —
              // stated rather than assumed, because the day somebody reorders the enum this
              // becomes a sort that quietly means something else.
              [{ urgency: 'asc' }, { createdAt: 'desc' }]
            : [{ createdAt: query.order === 'asc' ? 'asc' : 'desc' }],
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    const extras = await this.briefExtras(rows);

    return {
      data: rows.map(row => this.toBriefRow(row, extras)),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total, {
        urgencyOrder: URGENCY_ORDER,
      }),
    };
  }

  async briefDetail(id: string) {
    const row = await this.database.managedBrief.findUnique({
      where: { id },
      select: BRIEF_SELECT,
    });

    if (!row) throw ApiException.notFound('No such brief.');

    const [extras, matches, placedBy, conversation] = await Promise.all([
      this.briefExtras([row]),
      this.database.briefMatch.findMany({
        where: { briefId: id },
        orderBy: { rank: 'asc' },
        select: {
          listingId: true,
          rank: true,
          totalScore: true,
          ratingScore: true,
          distanceScore: true,
          priceScore: true,
          responseScore: true,
          priceForBrief: true,
          rationale: true,
          listing: {
            select: {
              professionTitle: true,
              isAcceptingWork: true,
              visibilityState: true,
              user: { select: caseMemberSelect },
            },
          },
        },
      }),
      row.placedById ? this.staffFor([row.placedById]) : Promise.resolve(new Map()),
      this.database.managedRequest.findFirst({
        where: { briefId: id },
        select: { conversationId: true, id: true },
      }),
    ]);

    return {
      ...this.toBriefRow(row, extras),
      /**
       * The Smart Match shortlist, with the four scores behind each rank.
       *
       * The breakdown is the point: a staff member placing a member with somebody is making a
       * recommendation in Circl's name, and "rank 1" with no reason is not something anybody can
       * stand behind. `acceptingWork` comes with it because placing against a professional who has
       * closed their books is a 422, and finding that out after choosing is a wasted decision.
       */
      matches: matches.map(match => ({
        listingId: match.listingId,
        professional: toMemberRef(match.listing.user, this.media.sign),
        professionTitle: match.listing.professionTitle,
        rank: match.rank,
        totalScore: match.totalScore,
        ratingScore: match.ratingScore,
        distanceScore: match.distanceScore,
        priceScore: match.priceScore,
        responseScore: match.responseScore,
        priceForBriefPence: match.priceForBrief,
        rationale: match.rationale,
        acceptingWork: match.listing.isAcceptingWork,
        visibilityState: match.listing.visibilityState,
      })),
      bookingId: row.bookingId,
      placedBy: row.placedById ? (placedBy.get(row.placedById) ?? null) : null,
      placedAt: row.placedAt?.toISOString() ?? null,
      conversationId: conversation?.conversationId ?? null,
      managedRequestId: conversation?.id ?? null,
    };
  }

  /**
   * Staff place the member with a professional (§5.16).
   *
   * The booking is created through `BookingService` on the member's behalf, exactly as if they had
   * chosen the professional themselves: same state (`PENDING_ACCEPTANCE`), same conversation, same
   * notification to the professional, same `NOT_ACCEPTING_WORK` refusal. That is what keeps
   * `PLACED` meaning "a booking exists" rather than "staff pressed a button", and it means the
   * professional's side of this is the flow they already know.
   *
   * What staff add is the record that it was **Circl** who chose: `placedById` and `placedAt`. The
   * difference matters the first time a placement goes badly.
   */
  async placeBrief(actor: AdminPrincipal, id: string, dto: PlaceBriefDto) {
    const brief = await this.database.managedBrief.findUnique({
      where: { id },
      select: { ...BRIEF_SELECT, userId: true },
    });

    if (!brief) throw ApiException.notFound('No such brief.');

    if (brief.state === BriefState.CLOSED) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'That brief is closed. Reopen it before placing anybody.',
        { data: { state: brief.state } },
      );
    }

    if (brief.bookingId) {
      throw ApiException.conflict(
        ApiErrorCode.ALREADY_DECIDED,
        'Somebody has already been placed on this brief.',
        { data: { bookingId: brief.bookingId, chosenListingId: brief.chosenListingId } },
      );
    }

    // On the member's behalf, so every check the member's own path applies still applies — the
    // listing being live, taking work, and not their own.
    const booking = await this.bookings.create(brief.userId, {
      listingId: dto.listingId,
      briefId: id,
    });

    void booking;

    const updated = await this.audit.mutate(
      // `after` is read from the row the update returns rather than from the booking view the
      // service handed back: `BookingService` sets the brief's `bookingId` itself, and reading it
      // off its response shape would be this file depending on a member serialiser's field names.
      (placedBrief: BriefRow & { userId: string }) => ({
        action: 'managed.brief_placed' as const,
        targetType: 'BRIEF' as const,
        targetId: id,
        before: { state: brief.state, chosenListingId: brief.chosenListingId },
        after: {
          state: BriefState.PLACED,
          chosenListingId: dto.listingId,
          bookingId: placedBrief.bookingId,
        },
        metadata: { note: dto.note ?? null, listingId: dto.listingId },
      }),
      tx =>
        tx.managedBrief.update({
          where: { id },
          // `BookingService` has already set `state`, `bookingId` and `chosenListingId` — it does
          // that for a member's own choice too. These two columns are the only thing this path
          // adds, and writing the others again here would be two writers for one fact.
          data: { placedById: actor.id, placedAt: new Date() },
          select: { ...BRIEF_SELECT, userId: true },
        }),
    );

    await this.tellMemberAboutPlacement(updated.result, dto.listingId);

    return this.briefDetail(id);
  }

  /** §7.7's brief transitions. `PLACED → OPEN` is the one that needs a lead. */
  async updateBrief(actor: AdminPrincipal, id: string, dto: UpdateBriefDto) {
    const brief = await this.database.managedBrief.findUnique({
      where: { id },
      select: { ...BRIEF_SELECT, userId: true },
    });

    if (!brief) throw ApiException.notFound('No such brief.');

    if (dto.state === brief.state) {
      // A no-op, answered rather than refused: the portal's state dropdown can be saved without
      // being changed, and a 409 there would be an error message about nothing.
      return this.briefDetail(id);
    }

    this.assertTransition(BRIEF_TRANSITIONS, brief.state, dto.state, 'brief');

    if (brief.state === BriefState.PLACED && dto.state === BriefState.OPEN) {
      if (!actor.permissions.has('moderation:assign')) {
        throw ApiException.forbidden(
          ApiErrorCode.FORBIDDEN,
          'Placing a brief again is a lead’s call (`moderation:assign`).',
        );
      }

      await this.releaseBooking(brief.bookingId, brief.userId);
    }

    await this.audit.mutate(
      {
        action: 'managed.brief_updated' as const,
        targetType: 'BRIEF' as const,
        targetId: id,
        before: { state: brief.state },
        after: { state: dto.state },
        metadata: { note: dto.note ?? null },
      },
      tx =>
        tx.managedBrief.update({
          where: { id },
          data: {
            state: dto.state,
            // Re-placing clears the choice, because a brief that is open again with last time's
            // professional still named on it reads as placed to every screen that checks.
            ...(dto.state === BriefState.OPEN
              ? { chosenListingId: null, bookingId: null, placedById: null, placedAt: null }
              : {}),
          },
          select: { ...BRIEF_SELECT, userId: true },
        }),
    );

    return this.briefDetail(id);
  }

  /**
   * The booking the last placement made, before the brief is opened again.
   *
   * Re-opening cleared `bookingId` and left the booking itself alone, so the professional kept a
   * live `PENDING_ACCEPTANCE` job for work that had been taken off them — and the next placement
   * created a second one. Two bookings, one brief, and nobody told.
   *
   * Cancelled through the member's own path rather than with an update here, so it is the same
   * transition the member's cancel is: the timeline entry, the stage and the notice to the
   * professional all come with it. Once it has been **accepted** the re-open is refused instead:
   * work may have started, and a booking somebody agreed to is not an administrative detail.
   *
   * Before the audited update rather than inside it, which is the same order `placeBrief` uses for
   * the same reason: `BookingService` owns its own transaction. If the update then failed the
   * brief would still read `PLACED` against a cancelled booking — visible and recoverable, unlike
   * an open brief with a live booking nobody can see.
   */
  private async releaseBooking(bookingId: string | null, memberId: string): Promise<void> {
    if (!bookingId) return;

    const booking = await this.database.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, state: true },
    });

    if (!booking) return;

    if (booking.state !== JobState.PENDING_ACCEPTANCE) {
      // Already cancelled or declined: nothing is live, so the brief can open with no fuss.
      if (RELEASED_STATES.includes(booking.state)) return;

      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        `That booking is ${booking.state.toLowerCase().replace(/_/g, ' ')}. Settle it with the professional before opening the brief again.`,
        { data: { bookingId, state: booking.state } },
      );
    }

    await this.bookings.cancel(memberId, bookingId, {
      reason: 'The brief was opened again, so this placement was withdrawn.',
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private assertTransition<T extends string>(
    table: Record<T, T[]>,
    from: T,
    to: T,
    what: string,
  ): void {
    if (!table[from].includes(to)) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        `A ${what} cannot go from ${from} to ${to}.`,
        { data: { state: from, allowed: table[from] } },
      );
    }
  }

  private async staffFor(ids: Array<string | null>) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];

    if (!wanted.length) return new Map<string, StaffRefView>();

    const rows = await this.database.user.findMany({
      where: { id: { in: wanted } },
      select: staffRefSelect,
    });

    return new Map(rows.map(row => [row.id, toStaffRef(row, this.media.sign)]));
  }

  private toRequestRow(
    row: RequestRow,
    staff: Map<string, StaffRefView>,
    helpAreaLabels: Map<string, string>,
  ) {
    return {
      id: row.id,
      member: toMemberRef(row.user, this.media.sign),
      subjectType: row.subjectType,
      state: row.state,
      /**
       * `Code[]`, as §5.16 types it: the code **and** its label.
       *
       * It was a bare `string[]` with a comment claiming otherwise, which would have put
       * `LISTINGS` on the screen where "Writing and photographing listings" belongs — and the
       * portal has no way to turn one into the other, because the labels live in `taxonomy_terms`.
       */
      helpAreas: (Array.isArray(row.helpAreas) ? (row.helpAreas as string[]) : [])
        .filter(code => typeof code === 'string')
        .map(code => ({ code, label: helpAreaLabels.get(code) ?? code }) satisfies CodeView),
      assignedTo: row.assignedToId ? (staff.get(row.assignedToId) ?? null) : null,
      assignedAt: row.assignedAt?.toISOString() ?? null,
      conversationId: row.conversationId,
      storeId: row.storeId,
      briefId: row.briefId,
      closedReason: row.closedReason,
      closedAt: row.closedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** The cities and category labels one page of briefs needs. */
  private async briefExtras(rows: Array<{ cityId: string | null; categoryCode: string }>) {
    const [labels, cities] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      Promise.all(
        [...new Set(rows.map(row => row.cityId).filter((id): id is string => !!id))].map(
          async id => [id, await this.cities.find(id)] as const,
        ),
      ),
    ]);

    return {
      labels,
      cities: new Map(
        cities
          .filter(([, city]) => !!city)
          .map(([id, city]) => [
            id,
            { id: city!.id, name: city!.name, region: city!.region } as CityRefView,
          ]),
      ),
    };
  }

  private toBriefRow(
    row: BriefRow,
    extras: { labels: Map<string, string>; cities: Map<string, CityRefView> },
  ) {
    const category: CodeView = {
      code: row.categoryCode,
      label: extras.labels.get(row.categoryCode) ?? row.categoryCode,
    };

    return {
      id: row.id,
      member: toMemberRef(row.user, this.media.sign),
      category,
      description: row.description,
      urgency: row.urgency,
      // `budgetPence`, named for what it is: the column is `budget` and every other money field in
      // the portal says its unit, because a number called `budget` is read as pounds by somebody
      // eventually.
      budgetPence: row.budget,
      currency: row.currency,
      city: row.cityId ? (extras.cities.get(row.cityId) ?? null) : null,
      state: row.state,
      chosenListingId: row.chosenListingId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async briefRow(id: string) {
    const row = await this.database.managedBrief.findUnique({
      where: { id },
      select: BRIEF_SELECT,
    });

    if (!row) return null;

    return this.toBriefRow(row, await this.briefExtras([row]));
  }

  /** The member hears that somebody moved their request, in the thread they already have open. */
  private async tellMemberAboutRequest(
    row: { id: string; userId: string; conversationId: string | null },
    state: ManagedRequestState,
    closedReason: ManagedRequestClosedReason | null,
  ): Promise<void> {
    const words: Record<ManagedRequestState, string> = {
      OPEN: 'Your request is back with the Circl team.',
      IN_PROGRESS: 'Somebody at Circl is working on your request now.',
      CLOSED: CLOSING_WORDS[closedReason ?? ManagedRequestClosedReason.OTHER],
    };

    if (row.conversationId) {
      await this.conversations.postSystemMessage(
        row.conversationId,
        SystemMessageType.MANAGED_STATE_CHANGED,
        words[state],
        { managedRequestId: row.id, state, closedReason },
      );
    }

    this.notifications.raise({
      userId: row.userId,
      kind: NotificationKind.ANNOUNCEMENT,
      categoryCode: 'ACCOUNT',
      title: 'Circl team',
      body: words[state],
      route: row.conversationId ? `/messages/${row.conversationId}` : null,
      metadata: { managedRequestId: row.id },
    });
  }

  /** Both sides hear about a placement: the member who asked, and the professional who got the job. */
  private async tellMemberAboutPlacement(
    brief: { id: string; userId: string },
    listingId: string,
  ): Promise<void> {
    const listing = await this.database.professionalListing.findUnique({
      where: { id: listingId },
      select: { professionTitle: true, userId: true },
    });
    const managed = await this.database.managedRequest.findFirst({
      where: { briefId: brief.id },
      select: { conversationId: true },
    });

    const words = `Circl has found you ${listing ? `a ${listing.professionTitle.toLowerCase()}` : 'somebody'}. They will confirm shortly.`;

    if (managed?.conversationId) {
      await this.conversations.postSystemMessage(
        managed.conversationId,
        SystemMessageType.MANAGED_PLACED,
        words,
        { briefId: brief.id, listingId },
      );
    }

    this.notifications.raise({
      userId: brief.userId,
      kind: NotificationKind.BOOKING,
      categoryCode: 'BOOKINGS',
      title: 'Circl found somebody for you',
      body: words,
      route: managed?.conversationId ? `/messages/${managed.conversationId}` : null,
      metadata: { briefId: brief.id, listingId },
    });

    // The professional already has the booking notification from `BookingService`. This one says
    // where it came from, which changes how they read it: a brief Circl placed is work somebody
    // vouched for, not a cold request.
    if (listing?.userId) {
      this.notifications.raise({
        userId: listing.userId,
        kind: NotificationKind.BOOKING,
        categoryCode: 'BOOKINGS',
        title: 'Circl placed a job with you',
        body: 'A member asked Circl to find them somebody, and we picked you.',
        route: '/bookings',
        metadata: { briefId: brief.id },
      });
    }
  }
}

/** What a closed request says to the member. The reason is theirs to know. */
const CLOSING_WORDS: Record<ManagedRequestClosedReason, string> = {
  PLACED: 'You are booked in with somebody. We have closed this request.',
  STORE_SET_UP: 'Your shop is set up. We have closed this request.',
  MEMBER_WITHDREW: 'We have closed this request, as you asked.',
  NOT_POSSIBLE: 'We could not help with this one, so we have closed the request. Do ask again.',
  OTHER: 'We have closed this request.',
};

const REQUEST_SELECT = {
  id: true,
  subjectType: true,
  state: true,
  helpAreas: true,
  notes: true,
  storeId: true,
  briefId: true,
  conversationId: true,
  assignedToId: true,
  assignedAt: true,
  closedReason: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: caseMemberSelect },
} satisfies Prisma.ManagedRequestSelect;

const BRIEF_SELECT = {
  id: true,
  categoryCode: true,
  description: true,
  urgency: true,
  budget: true,
  currency: true,
  cityId: true,
  state: true,
  chosenListingId: true,
  bookingId: true,
  placedById: true,
  placedAt: true,
  createdAt: true,
  user: { select: caseMemberSelect },
} satisfies Prisma.ManagedBriefSelect;

type RequestRow = Prisma.ManagedRequestGetPayload<{ select: typeof REQUEST_SELECT }>;
type BriefRow = Prisma.ManagedBriefGetPayload<{ select: typeof BRIEF_SELECT }>;
