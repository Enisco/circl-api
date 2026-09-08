import { Injectable } from '@nestjs/common';
import { Prisma, UserAccountStatus } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { buildPageMeta, escapeLike } from '@/common';
import {
  authorSelect,
  AuthorView,
  BlockingService,
  MediaService,
  toAuthorView,
} from '@/modules/platform/shared';
import {
  bestScore,
  CITY_BIAS,
  MIN_TERM_LENGTH,
  normaliseTerm,
  termVariants,
  termWords,
} from '@/modules/platform/search/services/search-terms';

export interface PersonHit extends AuthorView {
  type: 'PERSON';
}

export interface PeopleSearchResult {
  total: number;
  items: PersonHit[];
}

/** How far the trigram fallback will look before deciding the name simply is not there. */
const FUZZY_SCAN_LIMIT = 50;

/** Below this a typo is indistinguishable from a different name, so the fallback stays out of it. */
const FUZZY_MIN_LENGTH = 4;

/**
 * Member search. Matches display name and username, deliberately not bio, city or interests:
 * searching what members wrote about themselves opens a privacy surface for no benefit.
 * Returns the shared author object (0.9) unchanged.
 */
@Injectable()
export class UserDirectoryService {
  constructor(
    private readonly database: PrismaService,
    private readonly blocking: BlockingService,
    private readonly media: MediaService,
  ) {}

  /** The paginated People view, behind `GET /users?q=`. */
  async list(
    viewerId: string,
    query: { q?: string; cityId?: string; page?: number; limit?: number },
  ) {
    const term = normaliseTerm(query.q);
    const perPage = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const currentPage = Math.max(query.page ?? 1, 1);

    if (term.length < MIN_TERM_LENGTH) {
      // A directory with no term is not a feature: it is an export of the membership.
      return { data: [], meta: buildPageMeta({ currentPage, perPage }, 0) };
    }

    const blockedIds = await this.blocking.blockedUserIds(viewerId);
    const where = this.buildWhere(viewerId, term, blockedIds);
    const [total, rows] = await this.database.$transaction([
      this.database.user.count({ where }),
      this.database.user.findMany({
        where,
        select: authorSelect,
        orderBy: { createdAt: 'desc' },
        skip: (currentPage - 1) * perPage,
        take: perPage,
      }),
    ]);

    // The fallback has to paginate too, or page 2 of a fuzzy result is an empty page reporting a
    // different total from the page before it.
    if (total === 0 && term.length >= FUZZY_MIN_LENGTH) {
      const fuzzy = await this.fuzzy(
        viewerId,
        term,
        perPage,
        blockedIds,
        (currentPage - 1) * perPage,
      );

      return {
        data: this.rank(fuzzy.items, term, query.cityId ?? null, perPage),
        meta: buildPageMeta({ currentPage, perPage }, fuzzy.total),
      };
    }

    // Ranked within the page, not across the result: the page was drawn in a stable `createdAt`
    // order, so paging is consistent, and a name search rarely runs past one page anyway.
    return {
      data: this.rank(
        rows.map(row => this.toHit(row)),
        term,
        query.cityId ?? null,
        perPage,
      ),
      meta: buildPageMeta({ currentPage, perPage }, total),
    };
  }

  /** A true total plus a small ranked window, ranked here rather than in a second index. */
  async preview(
    viewerId: string,
    term: string,
    take: number,
    cityId: string | null,
  ): Promise<PeopleSearchResult> {
    const blockedIds = await this.blocking.blockedUserIds(viewerId);
    const where = this.buildWhere(viewerId, term, blockedIds);
    const [total, rows] = await this.database.$transaction([
      this.database.user.count({ where }),
      this.database.user.findMany({
        where,
        select: authorSelect,
        orderBy: { createdAt: 'desc' },
        take,
      }),
    ]);

    if (total === 0 && term.length >= FUZZY_MIN_LENGTH) {
      return this.fuzzy(viewerId, term, take, blockedIds);
    }

    return {
      total,
      items: this.rank(
        rows.map(row => this.toHit(row)),
        term,
        cityId,
        take,
      ),
    };
  }

  /**
   * Never returned: blocked either way, suspended, deleted, or the caller. Anonymity attaches to a
   * post, not a person, so somebody who posts anonymously is still findable by name.
   */
  private buildWhere(viewerId: string, term: string, blockedIds: string[]): Prisma.UserWhereInput {
    const words = termWords(term);

    // Every word must match something, so "ama o" finds Ama Owusu without a column holding the
    // two names joined. One word expands to its stem as well.
    const clauses = (words.length ? words : [term]).map(word => ({
      OR: termVariants(word).flatMap(variant => {
        // Escaped: `%` and `_` are ILIKE wildcards, and `%%` would otherwise list the whole
        // membership.
        const like = { contains: escapeLike(variant), mode: Prisma.QueryMode.insensitive };

        return [{ firstName: like }, { lastName: like }, { username: like }];
      }),
    }));

    return {
      deletedAt: null,
      isAnonymised: false,
      // Exactly the rule the auth guard applies: SUSPENDED cannot hold a session, and everyone
      // else can. Anything stricter would hide members who are using the app right now.
      status: { not: UserAccountStatus.SUSPENDED },
      id: { not: viewerId, ...(blockedIds.length ? { notIn: blockedIds } : {}) },
      AND: clauses,
    };
  }

  /** The typo path. `%` is pg_trgm's similarity operator, on the same indexes. Only runs on zero hits. */
  private async fuzzy(
    viewerId: string,
    term: string,
    take: number,
    blockedIds: string[],
    skip = 0,
  ): Promise<PeopleSearchResult> {
    const excluded = [viewerId, ...blockedIds];
    const rows = await this.database.$queryRaw<Array<{ id: string }>>`
      SELECT u.id
      FROM users u
      WHERE u.deleted_at IS NULL
        AND u.is_anonymised = false
        AND u.status::text <> 'SUSPENDED'
        AND u.id NOT IN (${Prisma.join(excluded)})
        AND (u.first_name % ${term} OR u.last_name % ${term} OR u.username % ${term})
      ORDER BY GREATEST(
        similarity(u.first_name, ${term}),
        similarity(COALESCE(u.last_name, ''), ${term}),
        similarity(COALESCE(u.username, ''), ${term})
      ) DESC
      LIMIT ${FUZZY_SCAN_LIMIT}
    `;

    if (!rows.length) return { total: 0, items: [] };

    if (skip >= rows.length) return { total: rows.length, items: [] };

    const ordered = rows.slice(skip, skip + take).map(row => row.id);
    const users = await this.database.user.findMany({
      where: { id: { in: ordered } },
      select: authorSelect,
    });
    const byId = new Map(users.map(user => [user.id, user]));

    return {
      // Capped at the scan limit rather than counted exactly: a fallback total only has to render
      // "See all", and a second full count would double the cost of the slow path.
      total: rows.length,
      items: ordered.flatMap(id => {
        const user = byId.get(id);

        return user ? [this.toHit(user)] : [];
      }),
    };
  }

  private toHit(row: Parameters<typeof toAuthorView>[0]): PersonHit {
    // `isAnonymous` is never passed: a person is a person, whatever they post under.
    return { type: 'PERSON', ...toAuthorView(row, { sign: this.media.sign }) };
  }

  private rank(items: PersonHit[], term: string, cityId: string | null, take: number): PersonHit[] {
    const variants = termVariants(term);

    return items
      .map(item => ({
        item,
        score:
          bestScore([item.username, item.displayName], variants) +
          (cityId && item.city?.id === cityId ? CITY_BIAS : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, take)
      .map(entry => entry.item);
  }
}
