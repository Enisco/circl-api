import { CommunityRequest, Media, PostVisibility, RequestStatus } from '@prisma/client';
import { money, toDateOnly } from '@/common';
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

export interface RequestCounts {
  views: number;
  helpers: number;
  replies: number;
  /** Owner only. The key is omitted for everyone else so the count cannot be inferred (1.2.2). */
  privateReplies?: number;
}

export interface RequestViewer {
  isOwner: boolean;
  hasOffered: boolean;
  hasReplied: boolean;
  isBlocked: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canResolve: boolean;
}

export interface RequestSummaryView {
  type: 'REQUEST';
  id: string;
  category: TermView | null;
  status: RequestStatus;
  title: string;
  excerpt: string;
  city: CityView | null;
  neededOn: string | null;
  thankYou: { amount: number; currency: string } | null;
  media: MediaView[];
  counts: RequestCounts;
  author: AuthorView;
  visibility: PostVisibility;
  isNearYou: boolean;
  viewer: Pick<RequestViewer, 'isOwner' | 'hasOffered'>;
  createdAt: string;
}

export interface RequestDetailView extends Omit<RequestSummaryView, 'type' | 'excerpt' | 'viewer'> {
  description: string | null;
  reportToken: string;
  viewer: RequestViewer;
  resolution: { resolvedAt: string; helpers: AuthorView[] } | null;
  updatedAt: string;
}

export type RequestRow = CommunityRequest & {
  author: AuthorSource;
  city: { id: string; name: string; region: string | null } | null;
};

export interface RequestViewContext {
  viewerId: string | null;
  /** The viewer's own city, for `isNearYou`. Computed per viewer, not stored (1.1). */
  viewerCityId?: string | null;
  categoryLabels: Map<string, string>;
  media?: Map<string, Media[]>;
  /** Signs stored keys into URLs at serialisation time (0.11.3). */
  sign: UrlSigner;
  hasOffered?: Set<string>;
  hasReplied?: Set<string>;
  blockedAuthorIds?: Set<string>;
  privateReplyCounts?: Map<string, number>;
}

const isAnonymous = (request: CommunityRequest) => request.visibility === PostVisibility.ANONYMOUS;

export const toRequestSummary = (
  request: RequestRow,
  context: RequestViewContext,
): RequestSummaryView => {
  const isOwner = context.viewerId !== null && request.authorId === context.viewerId;

  return {
    type: 'REQUEST',
    id: request.id,
    category: toTermView(request.categoryCode, context.categoryLabels),
    status: request.status,
    title: request.title,
    // A truncated description, server-side, so the feed payload does not carry full bodies (1.1).
    excerpt: excerptOf(request.description),
    city: toCityView(request.city),
    neededOn: toDateOnly(request.neededOn),
    thankYou: money(request.thankYouAmount, request.currency),
    media: toMediaViews(context.media?.get(request.id), context.sign),
    counts: {
      views: request.viewCount,
      // Responses where isHelpOffer is true — what the card renders as "3 offered to help".
      helpers: request.helperCount,
      replies: request.replyCount,
    },
    author: toAuthorView(request.author, { sign: context.sign, isAnonymous: isAnonymous(request) }),
    visibility: request.visibility,
    isNearYou: Boolean(context.viewerCityId && request.cityId === context.viewerCityId),
    viewer: {
      isOwner,
      hasOffered: context.hasOffered?.has(request.id) ?? false,
    },
    createdAt: request.createdAt.toISOString(),
  };
};

export const toRequestDetail = (
  request: RequestRow,
  context: RequestViewContext,
  resolution?: { resolvedAt: Date; helpers: AuthorSource[] } | null,
): RequestDetailView => {
  const summary = toRequestSummary(request, context);
  const isOwner = context.viewerId !== null && request.authorId === context.viewerId;
  const isOpen = request.status === RequestStatus.OPEN;

  const counts: RequestCounts = { ...summary.counts };

  if (isOwner) {
    counts.privateReplies = context.privateReplyCounts?.get(request.id) ?? 0;
  }

  return {
    id: summary.id,
    category: summary.category,
    status: summary.status,
    title: summary.title,
    description: request.description,
    city: summary.city,
    neededOn: summary.neededOn,
    thankYou: summary.thankYou,
    media: summary.media,
    counts,
    author: summary.author,
    visibility: summary.visibility,
    // Lets a viewer report anonymous content without ever seeing the author id.
    reportToken: request.reportToken,
    isNearYou: summary.isNearYou,
    viewer: {
      isOwner,
      hasOffered: summary.viewer.hasOffered,
      hasReplied: context.hasReplied?.has(request.id) ?? false,
      // A blocked author's content is returned with this set rather than hidden, so the client can offer "unblock to view".
      isBlocked: context.blockedAuthorIds?.has(request.authorId) ?? false,
      // canEdit and canDelete are computed here, not inferred by the client from isOwner, because they also depend on state (0.10).
      canEdit: isOwner && isOpen,
      canDelete: isOwner,
      canResolve: isOwner && isOpen,
    },
    resolution: resolution
      ? {
          resolvedAt: resolution.resolvedAt.toISOString(),
          helpers: resolution.helpers.map(helper => toAuthorView(helper, { sign: context.sign })),
        }
      : null,
    createdAt: summary.createdAt,
    updatedAt: request.updatedAt.toISOString(),
  };
};

const excerptOf = (description: string | null): string => {
  if (!description) return '';

  const text = description.replace(/\s+/g, ' ').trim();

  if (text.length <= 200) return text;

  const cut = text.slice(0, 200);
  const lastSpace = cut.lastIndexOf(' ');

  return `${(lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};
