import { Injectable } from '@nestjs/common';
import { ServiceRequestOfferStatus, ServiceRequestState, TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import { MediaService, TaxonomyService } from '../../shared';
import {
  OFFER_SELECT,
  SERVICE_REQUEST_SELECT,
  ServiceRequestSource,
  ServiceRequestView,
  toResponderView,
  toServiceRequestView,
} from '../serializers/service-request.serializer';
import { CreateServiceRequestDto } from '../dtos/service-request.dto';

/** How many of a member's own requests one list returns. Nobody has more; a cap stops a loop. */
const LIST_LIMIT = 50;

/** The states a member can still withdraw from. */
const WITHDRAWABLE: ServiceRequestState[] = [
  ServiceRequestState.SUBMITTED,
  ServiceRequestState.MATCHING,
];

/**
 * The member's half of "let Circl handle it" (§2, member side).
 *
 * Four calls: submit, their own list, one of them, withdraw. Everything in between — who was
 * asked, how many, and what they said — happens on the staff side and in the professional's inbox,
 * and the member is told the outcome rather than shown the mechanism. In particular the app never
 * learns how many professionals were offered the request, and nothing here returns it.
 */
@Injectable()
export class ServiceRequestService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
    private readonly media: MediaService,
  ) {}

  /**
   * Submit one.
   *
   * The city is taken from the member's profile rather than asked for: there is no city picker on
   * this screen, staff need it to search, and asking somebody to restate where they live is a
   * question their account already answers.
   */
  async create(userId: string, dto: CreateServiceRequestDto): Promise<ServiceRequestView> {
    // Only when they offered one. An absent category is the member saying they do not know, which
    // is the whole point of this route, so it is neither rejected nor defaulted.
    if (dto.categoryCode) {
      await this.taxonomy.assertValid(TaxonomyKind.PROFESSION, dto.categoryCode, 'categoryCode');
    }

    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { cityId: true },
    });

    const created = await this.database.serviceRequest.create({
      data: {
        userId,
        description: dto.description,
        urgency: dto.urgency ?? undefined,
        budget: dto.budget ?? null,
        budgetText: dto.budgetText ?? null,
        categoryCode: dto.categoryCode ?? null,
        cityId: profile?.cityId ?? null,
        state: ServiceRequestState.SUBMITTED,
      },
      select: SERVICE_REQUEST_SELECT,
    });

    const [view] = await this.withResponders([created]);

    return view;
  }

  /** Their own, newest first. */
  async list(userId: string): Promise<ServiceRequestView[]> {
    const rows = await this.database.serviceRequest.findMany({
      where: { userId },
      select: SERVICE_REQUEST_SELECT,
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });

    return this.withResponders(rows);
  }

  async findOne(userId: string, id: string): Promise<ServiceRequestView> {
    const [view] = await this.withResponders([await this.load(userId, id)]);

    return view;
  }

  /**
   * Withdraw it.
   *
   * Only while nobody has written: once a professional has introduced themselves it is a
   * conversation, and a conversation is ended by leaving it rather than by cancelling the thing
   * that started it. Outstanding offers are revoked in the same transaction — a withdrawn request
   * that is still in somebody's inbox is work they can accept and nobody will honour.
   */
  async cancel(userId: string, id: string): Promise<ServiceRequestView> {
    const request = await this.load(userId, id);

    if (!WITHDRAWABLE.includes(request.state)) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        request.state === ServiceRequestState.CANCELLED
          ? 'You have already withdrawn this request.'
          : 'Somebody has already taken this on. Tell them in the conversation instead.',
        { data: { status: request.state } },
      );
    }

    const updated = await this.database.$transaction(async tx => {
      /**
       * Guarded on the state as well as checked above it.
       *
       * A professional accepting between the two is narrow and bad: the request would read
       * `CANCELLED` with somebody's acceptance attached to it, and that professional would be
       * sitting in a thread about work the member had just withdrawn.
       */
      const { count } = await tx.serviceRequest.updateMany({
        where: { id, state: { in: WITHDRAWABLE } },
        data: { state: ServiceRequestState.CANCELLED },
      });

      if (!count) {
        throw ApiException.conflict(
          ApiErrorCode.INVALID_TRANSITION,
          'Somebody took this on while you were withdrawing it. Tell them in the conversation.',
        );
      }

      await tx.serviceRequestOffer.updateMany({
        where: { requestId: id, status: ServiceRequestOfferStatus.PENDING },
        data: { status: ServiceRequestOfferStatus.REVOKED },
      });

      return tx.serviceRequest.findUniqueOrThrow({
        where: { id },
        select: SERVICE_REQUEST_SELECT,
      });
    });

    const [view] = await this.withResponders([updated]);

    return view;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async load(userId: string, id: string) {
    const request = await this.database.serviceRequest.findUnique({
      where: { id },
      select: { ...SERVICE_REQUEST_SELECT, userId: true },
    });

    // Somebody else's request is not found rather than forbidden: whether a given id exists is
    // not something a stranger needs to learn.
    if (!request || request.userId !== userId) {
      throw ApiException.notFound('That request could not be found.');
    }

    return request;
  }

  /**
   * The accepted offers, attached as `responders`.
   *
   * Only `ACCEPTED` ones: the member never learns who was asked, only who took it on. The
   * `conversationId` on each is the point of the whole list — by the time one of these arrives the
   * thread exists and the professional has already written.
   */
  private async withResponders(requests: ServiceRequestSource[]): Promise<ServiceRequestView[]> {
    if (!requests.length) return [];

    const [labels, offers] = await Promise.all([
      this.taxonomy.labels(TaxonomyKind.PROFESSION),
      this.database.serviceRequestOffer.findMany({
        where: {
          requestId: { in: requests.map(row => row.id) },
          status: ServiceRequestOfferStatus.ACCEPTED,
        },
        select: OFFER_SELECT,
        orderBy: { respondedAt: 'asc' },
      }),
    ]);

    return requests.map(request => ({
      ...toServiceRequestView(request, labels),
      responders: offers
        .filter(offer => offer.requestId === request.id)
        .map(offer => toResponderView(offer, this.media.sign)),
    }));
  }
}
