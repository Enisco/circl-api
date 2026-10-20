import { Prisma, ServiceRequestOfferStatus, ServiceRequestState } from '@prisma/client';
import { money } from '@/common';
import {
  AuthorSource,
  CityView,
  TermView,
  UrlSigner,
  authorSelect,
  toAuthorView,
  toCityView,
  toTermView,
} from '../../shared';

/** Everything both sides of a service request are rendered from. */
export const SERVICE_REQUEST_SELECT = {
  id: true,
  userId: true,
  description: true,
  state: true,
  urgency: true,
  budget: true,
  budgetText: true,
  currency: true,
  categoryCode: true,
  adminCategoryCode: true,
  note: true,
  createdAt: true,
  updatedAt: true,
  city: { select: { id: true, name: true, region: true } },
} satisfies Prisma.ServiceRequestSelect;

export type ServiceRequestSource = Prisma.ServiceRequestGetPayload<{
  select: typeof SERVICE_REQUEST_SELECT;
}>;

/** An offer, with enough of the professional to draw a row for them. */
export const OFFER_SELECT = {
  id: true,
  requestId: true,
  status: true,
  offeredAt: true,
  respondedAt: true,
  expiresAt: true,
  conversationId: true,
  professionalId: true,
  listingId: true,
  professional: { select: authorSelect },
} satisfies Prisma.ServiceRequestOfferSelect;

export type OfferSource = Prisma.ServiceRequestOfferGetPayload<{ select: typeof OFFER_SELECT }>;

/** One professional who took the request on, as the member sees them. */
export interface ResponderView {
  /**
   * Their listing, where they have one, because that is what the app opens — and their user id
   * otherwise, so a row is never unopenable. `userId` travels beside it either way.
   */
  professionalId: string;
  userId: string;
  name: string;
  headline: string | null;
  avatarUrl: string | null;
  /** The thread, which by the time the member reads this already has their introduction in it. */
  conversationId: string | null;
  acceptedAt: string | null;
}

export interface ServiceRequestView {
  id: string;
  description: string;
  status: ServiceRequestState;
  urgency: string;
  budget: ReturnType<typeof money>;
  budgetText: string | null;
  category: TermView | null;
  city: CityView | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  responders?: ResponderView[];
}

/**
 * The request, as both the member and the professional read it.
 *
 * `category` is the **admin's** decision where there is one and the member's guess otherwise. One
 * field rather than two, because neither screen has anywhere to put a second: what they need to
 * know is what kind of help this is, and Circl's answer is the better one once it exists.
 */
export const toServiceRequestView = (
  request: ServiceRequestSource,
  labels: Map<string, string>,
): ServiceRequestView => ({
  id: request.id,
  description: request.description,
  status: request.state,
  urgency: request.urgency,
  budget: money(request.budget, request.currency),
  budgetText: request.budgetText,
  category: toTermView(request.adminCategoryCode ?? request.categoryCode, labels),
  city: toCityView(request.city),
  note: request.note,
  createdAt: request.createdAt.toISOString(),
  updatedAt: request.updatedAt.toISOString(),
});

export const toResponderView = (offer: OfferSource, sign: UrlSigner): ResponderView => {
  const author = toAuthorView(offer.professional as AuthorSource, { sign });

  return {
    professionalId: author.professionalId ?? offer.professionalId,
    userId: offer.professionalId,
    name: author.displayName,
    headline: author.headline,
    avatarUrl: author.avatarUrl,
    conversationId: offer.conversationId,
    acceptedAt: offer.respondedAt?.toISOString() ?? null,
  };
};

export interface OfferView {
  id: string;
  status: ServiceRequestOfferStatus;
  offeredAt: string;
  respondedAt: string | null;
  expiresAt: string;
  conversationId: string | null;
  request: ServiceRequestView;
}

/**
 * An offer, as the professional reads it.
 *
 * The member is not named, and neither is anything that would name them: they agreed to hear from
 * professionals Circl chose, not to have their name circulated to everyone who was asked. The
 * request's city does travel — judging whether you can take something on without knowing where it
 * is is guesswork.
 */
export const toOfferView = (
  offer: OfferSource & { request: ServiceRequestSource },
  labels: Map<string, string>,
): OfferView => ({
  id: offer.id,
  status: offer.status,
  offeredAt: offer.offeredAt.toISOString(),
  respondedAt: offer.respondedAt?.toISOString() ?? null,
  expiresAt: offer.expiresAt.toISOString(),
  conversationId: offer.conversationId,
  request: toServiceRequestView(offer.request, labels),
});
