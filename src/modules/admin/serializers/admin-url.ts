import { ReportTargetType } from '@prisma/client';

/**
 * Where a thing lives in the portal, as a path.
 *
 * Every list the portal draws has rows that lead somewhere, and the alternative to this map is each
 * endpoint inventing its own path — which is how a link in the activity feed and a link in the
 * content tab end up disagreeing about where a request is. A path and not a URL: the portal is
 * deployed at more than one hostname and the API has no business knowing which one asked.
 *
 * A target type with no page of its own returns null, which the portal reads as "render this as
 * text, not a link". Inventing a path that 404s would be worse than admitting there isn't one.
 */
const CONTENT_PATHS: Partial<Record<ReportTargetType, string>> = {
  REQUEST: '/content/requests',
  RESPONSE: '/content/responses',
  OFFER: '/content/offers',
  UPDATE: '/content/updates',
  UPDATE_REPLY: '/content/update-replies',
  GUIDE: '/guides',
  GROUP: '/content/groups',
  GROUP_POST: '/content/group-posts',
  GROUP_POST_REPLY: '/content/group-post-replies',
  STORE: '/content/stores',
  STORE_ITEM: '/content/store-items',
  CONNECT_MEDIA: '/content/connect-posts',
  CONNECT_STORY: '/content/connect-stories',
  CONNECT_PROFILE: '/content/connect-profiles',
  PROFESSIONAL_LISTING: '/content/listings',
  USER: '/members',
};

export const contentAdminUrl = (targetType: ReportTargetType, targetId: string): string | null => {
  const base = CONTENT_PATHS[targetType];

  return base ? `${base}/${targetId}` : null;
};

export const memberAdminUrl = (memberId: string): string => `/members/${memberId}`;
