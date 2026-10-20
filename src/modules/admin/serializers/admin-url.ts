import { ReportTargetType } from '@prisma/client';
import { kindForTarget } from '../content/content-registry';

/**
 * Where a thing lives in the portal, as a path.
 *
 * Every list the portal draws has rows that lead somewhere, and the alternative to this is each
 * endpoint inventing its own path — which is how a link in the activity feed and a link in the
 * content tab end up disagreeing about where a request is. A path and not a URL: the portal is
 * deployed at more than one hostname and the API has no business knowing which one asked.
 *
 * A target type with no page of its own returns null, which the portal reads as "render this as
 * text, not a link". Inventing a path that 404s would be worse than admitting there isn't one.
 */

export const memberAdminUrl = (memberId: string): string => `/members/${memberId}`;

/**
 * The content page for a target type, built from the registry rather than from a second list.
 *
 * This was a hand-written `Record<ReportTargetType, string>`, and the portal reported it wrong
 * twice over: it sent `/guides` and `/content/store-items` for pages that are `/content/guides`
 * and `/content/items`, and it had no entry at all for a Connect post, a service or a review, so
 * the three newest content screens were reachable from nothing. Both are the same bug — a copy of
 * the routing table that nobody updates when the table changes.
 *
 * `content-registry.ts` already holds each kind's slug, and that slug is what the API's own
 * `admin/content/:slug` routes are named after, so the portal's page is `/content/<slug>/<id>` by
 * construction. Deriving it here means a kind added to the registry is linkable the same day,
 * and the two cannot drift apart again.
 *
 * `USER` is the exception and is not in the registry: a member is not content, and their page is
 * `/members/<id>`. `CONNECT_MEDIA` is the other: its id is one photo out of a post, which no page
 * routes on, so it has no kind and gets null. It used to be pointed at the posts page, where a
 * media id 404s — the only thing worse than an unlinked row.
 */
export const contentAdminUrl = (targetType: ReportTargetType, targetId: string): string | null => {
  if (targetType === ReportTargetType.USER) return memberAdminUrl(targetId);

  const kind = kindForTarget(targetType);

  return kind ? `/content/${kind.slug}/${targetId}` : null;
};

/**
 * The support surface's own targets, which are not reportable content.
 *
 * The registry is keyed on `ReportTargetType` — the things a member can report — and the audit
 * trail records plenty that nobody can report: a service request, a brief. Those rows had no
 * path, so the portal rendered the most consequential entries in the log (who a member's problem
 * was offered to, and by whom) as plain text.
 *
 * `BRIEF` points at the same page as `SERVICE_REQUEST`: it is the same record under the name the
 * superseded endpoints still use for it.
 */
const SUPPORT_PATHS: Record<string, string> = {
  SERVICE_REQUEST: '/support/service-requests',
  BRIEF: '/support/service-requests',
  MANAGED_REQUEST: '/support/managed',
};

export const supportAdminUrl = (targetType: string, targetId: string): string | null => {
  const base = SUPPORT_PATHS[targetType];

  return base ? `${base}/${targetId}` : null;
};
