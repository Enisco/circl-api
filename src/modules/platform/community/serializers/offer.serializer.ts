import { CommunityOffer, DeliveryMode, Media, PostVisibility, PriceBasis } from '@prisma/client';
import { money } from '@/common';
import {
  AuthorSource,
  AuthorView,
  CityView,
  MediaView,
  TermView,
  UrlSigner,
  toAuthorView,
  toCityView,
  toMediaViews,
  toTermView,
} from '../../shared';

export interface OfferSummaryView {
  type: 'OFFER';
  id: string;
  title: string;
  excerpt: string;
  category: TermView | null;
  city: CityView | null;
  deliveryMode: DeliveryMode;
  priceFrom: { amount: number; currency: string } | null;
  priceBasis: PriceBasis;
  /** `priceFrom == null`, sent explicitly so the client never has to decide what a missing price means (1.4.1). */
  isFree: boolean;
  media: MediaView[];
  provider: AuthorView;
  createdAt: string;
}

export interface OfferDetailView extends Omit<OfferSummaryView, 'type' | 'excerpt'> {
  description: string;
  reportToken: string;
  viewer: { isOwner: boolean; canEdit: boolean; canDelete: boolean; isBlocked: boolean };
  /** If a thread with this provider about this offer already exists, Message opens it instead of starting a second one (1.4.2, and rule 3 of 5.0). */
  conversationId: string | null;
  promotedToListingId: string | null;
  updatedAt: string;
}

export type OfferRow = CommunityOffer & {
  author: AuthorSource;
  city: { id: string; name: string; region: string | null } | null;
};

export interface OfferViewContext {
  viewerId: string | null;
  categoryLabels: Map<string, string>;
  media?: Map<string, Media[]>;
  /** Signs stored keys into URLs at serialisation time (0.11.3). */
  sign: UrlSigner;
  blockedAuthorIds?: Set<string>;
  conversationIds?: Map<string, string>;
}

export const toOfferSummary = (offer: OfferRow, context: OfferViewContext): OfferSummaryView => ({
  type: 'OFFER',
  id: offer.id,
  title: offer.title,
  excerpt: excerptOf(offer.description),
  category: toTermView(offer.categoryCode, context.categoryLabels),
  city: toCityView(offer.city),
  deliveryMode: offer.deliveryMode,
  priceFrom: money(offer.priceFrom, offer.currency),
  priceBasis: offer.priceBasis,
  isFree: offer.priceFrom === null,
  media: toMediaViews(context.media?.get(offer.id), context.sign),
  provider: toAuthorView(offer.author, {
    sign: context.sign,
    isAnonymous: offer.visibility === PostVisibility.ANONYMOUS,
  }),
  createdAt: offer.createdAt.toISOString(),
});

export const toOfferDetail = (offer: OfferRow, context: OfferViewContext): OfferDetailView => {
  const summary = toOfferSummary(offer, context);
  const isOwner = context.viewerId !== null && offer.authorId === context.viewerId;

  return {
    id: summary.id,
    title: summary.title,
    description: offer.description,
    category: summary.category,
    city: summary.city,
    deliveryMode: summary.deliveryMode,
    priceFrom: summary.priceFrom,
    priceBasis: summary.priceBasis,
    isFree: summary.isFree,
    media: summary.media,
    provider: summary.provider,
    reportToken: offer.reportToken,
    viewer: {
      isOwner,
      canEdit: isOwner,
      canDelete: isOwner,
      isBlocked: context.blockedAuthorIds?.has(offer.authorId) ?? false,
    },
    conversationId: context.conversationIds?.get(offer.id) ?? null,
    promotedToListingId: offer.promotedToListingId,
    createdAt: summary.createdAt,
    updatedAt: offer.updatedAt.toISOString(),
  };
};

const excerptOf = (text: string): string => {
  const clean = text.replace(/\s+/g, ' ').trim();

  if (clean.length <= 200) return clean;

  const cut = clean.slice(0, 200);
  const lastSpace = cut.lastIndexOf(' ');

  return `${(lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};
