import {
  ContentVisibilityState,
  Prisma,
  StoreComplianceState,
  UserAccountStatus,
} from '@prisma/client';

/**
 * Whether the public may see a piece of content (§6.5).
 *
 * Two fragments, because there are two different questions and conflating them is the bug this
 * file exists to prevent:
 *
 * - **`PUBLIC_VISIBILITY`** — a feed, a search result, a recommendation, a Pulse count, a
 *   notification fan-out. Only `VISIBLE`. A `LIMITED` post is one a scan thought was probably
 *   over the line, and the whole point of limiting rather than holding is that it stops being
 *   *distributed* while staying where its author put it.
 * - **`DIRECT_VISIBILITY`** — somebody's profile, or a link somebody was given. `VISIBLE` or
 *   `LIMITED`. A member who follows a link to a limited post sees it; nobody is shown it who did
 *   not go looking.
 *
 * `HELD`, `PENDING_APPROVAL` and `REJECTED` are in neither. Those are not public at all, and a
 * single-item read of one by anybody other than its author is a 404 — see `reviewStatusOf`.
 *
 * Fragments rather than a service: a `where` clause is not a dependency, and these have to be
 * reachable from fifteen services without a module edge between them. One definition, so the
 * answer cannot drift between the feed and the search that reads the same rows.
 */
export const PUBLIC_VISIBILITY: { visibilityState: ContentVisibilityState } = {
  visibilityState: ContentVisibilityState.VISIBLE,
};

// Typed rather than `as const`: an `as const` array is `readonly`, and Prisma's generated `in`
// filter takes a mutable one, so the whole fragment stopped being assignable to any `where`.
export const DIRECT_VISIBILITY: { visibilityState: { in: ContentVisibilityState[] } } = {
  visibilityState: {
    in: [ContentVisibilityState.VISIBLE, ContentVisibilityState.LIMITED],
  },
};

/**
 * Whether a shop may trade (§5.7's Decision, overriding D23).
 *
 * `SUSPENDED` takes a shop and its items out of browse, search and recommendations. Until this
 * existed, `complianceState` recorded a judgement that changed nothing: staff could suspend a shop
 * and it kept selling. A state called SUSPENDED that leaves the shop trading is worse than not
 * having one, because staff believe they have acted and nobody is told otherwise.
 *
 * `UNDER_REVIEW` deliberately does **not** gate. It means somebody is looking, and taking a shop
 * offline while that happens would make "we are checking" indistinguishable from "we decided" —
 * and the checking is often about a single item.
 *
 * Composed into the store's own `where`, or nested under `store` for an item's.
 */
export const TRADING_STORE: { complianceState: { not: StoreComplianceState } } = {
  complianceState: { not: StoreComplianceState.SUSPENDED },
};

/** The same gate for a hand-written query. */
export const tradingStoreSql = (alias: string): Prisma.Sql =>
  Prisma.sql`${Prisma.raw(`"${alias}"."compliance_state"`)} <> ${StoreComplianceState.SUSPENDED}::"StoreComplianceState"`;

/**
 * Whether a piece of content's author may be seen at all (§13.2).
 *
 * A suspension hides what the member published, not just their ability to sign in. Until this
 * existed a suspension stopped somebody using the app and left every post, guide, review, listing
 * and shop of theirs fully visible — so a suspension issued *for* harmful content left the content
 * up.
 *
 * ## Why a read-path filter and not a visibility rewrite
 *
 * §13.2 is explicit: "implemented as a read-path join on author status, not by rewriting
 * `visibilityState`". Rewriting would destroy the state each item was already in — a post the
 * scanner had limited and one that was perfectly fine would both become HELD, and reactivating the
 * member would have to guess which was which. Filtering on the author instead means the suspension
 * ends and everything returns to exactly what it was, with nothing to restore.
 *
 * ## Composed per relation, on purpose
 *
 * The relation's name differs by table — `author`, `user`, `owner`, `reviewer` — and three models
 * reach the member through a parent (`connectPost → profile → user`,
 * `professionalService → listing → user`, `storeItem → store → owner`). So this is a fragment the
 * call site names its relation for, rather than something spread blindly into a `where`:
 *
 * ```ts
 * where: { ...PUBLIC_VISIBILITY, author: ACTIVE_AUTHOR }
 * where: { ...PUBLIC_VISIBILITY, store: { owner: ACTIVE_AUTHOR } }
 * ```
 *
 * `content-visibility-coverage.spec.ts` is what makes that completeness checkable rather than a
 * matter of my diligence: a reader-facing query that applies neither this nor an exemption comment
 * fails the build.
 */
export const ACTIVE_AUTHOR: { status: { not: UserAccountStatus } } = {
  status: { not: UserAccountStatus.SUSPENDED },
};

/**
 * The same rule where the author is **optional** — which today means guides.
 *
 * `Guide.authorId` is null for the ones Circl writes, and a plain relation filter does not match a
 * null relation: `{ author: ACTIVE_AUTHOR }` on a guide would hide **every staff-written guide on
 * the platform**, silently, as a side effect of a change about suspensions. `isNot` is the
 * nullable to-one form: a null author is not a suspended member, so it passes.
 *
 * ## Why not an `OR`
 *
 * The obvious spelling is `OR: [{ authorId: null }, { author: ACTIVE_AUTHOR }]`, and it was the
 * first version of this. It is a **trap**: spread into a `where` that later sets its own `OR` —
 * which the feed does, for `cityId` — the second `OR` replaces the first and the author filter
 * disappears. Silently, and only on the city-scoped path, which is the common one.
 *
 * One key on one relation cannot be overwritten by an unrelated clause, which is the whole reason
 * for this spelling.
 */
export const ACTIVE_OR_NO_AUTHOR: { isNot: { status: UserAccountStatus } } = {
  isNot: { status: UserAccountStatus.SUSPENDED },
};

/** The same gate for a hand-written query, against the joined author's alias. */
export const activeAuthorSql = (alias: string): Prisma.Sql =>
  Prisma.sql`${Prisma.raw(`"${alias}"."status"`)} <> ${UserAccountStatus.SUSPENDED}::"UserAccountStatus"`;

/** The same rules for a hand-written query. `alias` is the table alias, never caller input. */
export const publicVisibilitySql = (alias: string): Prisma.Sql =>
  Prisma.sql`${Prisma.raw(`"${alias}"."visibility_state"`)} = ${ContentVisibilityState.VISIBLE}::"ContentVisibilityState"`;

export const directVisibilitySql = (alias: string): Prisma.Sql =>
  Prisma.sql`${Prisma.raw(`"${alias}"."visibility_state"`)} IN (${ContentVisibilityState.VISIBLE}::"ContentVisibilityState", ${ContentVisibilityState.LIMITED}::"ContentVisibilityState")`;

/** Distributable: feeds, search, recommendations, counts. */
export const isPublic = (state: ContentVisibilityState): boolean =>
  state === ContentVisibilityState.VISIBLE;

/** Reachable by a direct link or on the author's profile. */
export const isReachable = (state: ContentVisibilityState): boolean =>
  state === ContentVisibilityState.VISIBLE || state === ContentVisibilityState.LIMITED;

/**
 * What the **author** is told about their own content (§6.5).
 *
 * Null for anything the author has no reason to think about: a limited post reads as normal to the
 * person who wrote it, because telling them "your post has been quietly demoted" invites them to
 * repost it, and the demotion is provisional until a human looks.
 *
 * `UNDER_REVIEW` is for content a scan held and a human has not reached yet; `NOT_APPROVED` is a
 * decision somebody made. The distinction is the one members ask about, so it is in the payload
 * rather than inferred from a state name the API does not publish.
 */
export type ReviewStatus = 'UNDER_REVIEW' | 'NOT_APPROVED' | null;

export const reviewStatusOf = (state: ContentVisibilityState): ReviewStatus => {
  switch (state) {
    case ContentVisibilityState.HELD:
    case ContentVisibilityState.PENDING_APPROVAL:
      return 'UNDER_REVIEW';
    case ContentVisibilityState.REJECTED:
      return 'NOT_APPROVED';
    default:
      return null;
  }
};

/**
 * The sentence the author sees. Deliberately plain, and deliberately not an accusation: at this
 * point nobody has decided anything, and most held content is published after review.
 */
export const REVIEW_MESSAGE: Record<'UNDER_REVIEW' | 'NOT_APPROVED', string> = {
  UNDER_REVIEW: 'This is being reviewed. It usually takes a few hours.',
  NOT_APPROVED: 'This was not approved, so it is not visible to others.',
};
