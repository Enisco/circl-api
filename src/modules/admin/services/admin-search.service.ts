import { Injectable } from '@nestjs/common';
import { Prisma, ReportTargetType } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { MediaService } from '@/modules/platform/shared';
import { AdminPrincipal } from '../common/admin-principal';
import { StaffRefView, staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';
import { contentAdminUrl, memberAdminUrl } from '../serializers/admin-url';
import { contentById } from './admin-member-tabs.service';

/** How many of each kind the palette returns. §5.27: five. */
const PER_KIND = 5;

/** A member, as the palette draws them. A row, not a profile: the palette is a way to navigate. */
export interface PaletteMemberView {
  id: string;
  name: string;
  username: string | null;
  city: string | null;
  status: string;
  avatarUrl: string | null;
  /** Why this row matched, so an exact hit can be shown differently from a fuzzy one. */
  matchedOn: 'id' | 'email' | 'username' | 'name';
  adminUrl: string;
}

export interface PaletteContentView {
  targetType: ReportTargetType;
  targetId: string;
  title: string | null;
  excerpt: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  /** Null where that kind has no portal page, which the portal renders as text (see admin-url). */
  adminUrl: string | null;
}

export interface PaletteView {
  members?: PaletteMemberView[];
  staff?: StaffRefView[];
  content?: PaletteContentView[];
}

/** A uuid, which is the only thing worth asking the content tables about. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The command palette (§5.27).
 *
 * `POST`, not `GET`, and that is the point of the endpoint rather than an accident: the query is a
 * name, an email address or a username, and a GET would put all three in the URL — the access log,
 * the browser history, the `Referer` of the next request. §2.6 says member identifiers never reach
 * a URL, so the palette posts.
 *
 * Each section is gated on its own permission and **omitted** rather than returned empty when the
 * caller lacks it, which is the convention §5.24 set for dashboard widgets: an empty list says
 * "nothing matched", and a missing key says "not yours to search". A moderator who sees an empty
 * `staff` array would reasonably conclude there are no staff called Sarah.
 */
@Injectable()
export class AdminSearchService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
  ) {}

  async search(actor: AdminPrincipal, q: string): Promise<PaletteView> {
    const term = q.trim();
    const [members, staff, content] = await Promise.all([
      actor.permissions.has('members:read') ? this.members(actor, term) : null,
      actor.permissions.has('team:read') ? this.staff(term) : null,
      actor.permissions.has('content:read') ? this.content(term) : null,
    ]);

    return {
      ...(members ? { members } : {}),
      ...(staff ? { staff } : {}),
      ...(content ? { content } : {}),
    };
  }

  /**
   * Members, exact matches first.
   *
   * "Exact first" is what makes the palette usable: a staff member pasting an id or an email knows
   * exactly who they want, and burying that row under four fuzzy name matches wastes the keystroke
   * the palette exists to save. Ordered in SQL rather than afterwards so the ordering survives the
   * limit — sorting a page of five is not the same as taking the best five.
   *
   * An email query from somebody without `members:pii_reveal` matches **nothing**, the same rule
   * the member list follows (§5.4): otherwise the palette becomes a way to confirm which address
   * an account holds, one guess at a time.
   */
  private async members(actor: AdminPrincipal, term: string): Promise<PaletteMemberView[]> {
    const looksLikeEmail = term.includes('@');

    if (looksLikeEmail && !actor.permissions.has('members:pii_reveal')) return [];

    const like = `%${term}%`;
    const rows = await this.database.$queryRaw<
      Array<{
        id: string;
        first_name: string;
        last_name: string | null;
        username: string | null;
        status: string;
        avatar_key: string | null;
        profile_image_url: string | null;
        city: string | null;
        matched_on: PaletteMemberView['matchedOn'];
      }>
    >`
      SELECT u."id" AS id, u."first_name" AS first_name, u."last_name" AS last_name,
             u."username" AS username, u."status"::text AS status,
             u."avatar_key" AS avatar_key, u."profile_image_url" AS profile_image_url,
             c."name" AS city,
             CASE
               WHEN u."id"::text = ${term} THEN 'id'
               WHEN lower(u."email") = lower(${term}) THEN 'email'
               WHEN lower(u."username") = lower(${term}) THEN 'username'
               ELSE 'name'
             END AS matched_on
      FROM "users" u
      LEFT JOIN "user_profile" p ON p."user_id" = u."id"
      LEFT JOIN "cities" c ON c."id" = p."city_id"
      WHERE u."is_staff" = false
        AND u."deleted_at" IS NULL
        AND u."anonymised_at" IS NULL
        AND (
          u."id"::text = ${term}
          OR lower(u."username") = lower(${term})
          ${looksLikeEmail ? Prisma.sql`OR lower(u."email") = lower(${term})` : Prisma.empty}
          OR u."first_name" ILIKE ${like}
          OR u."last_name" ILIKE ${like}
          OR u."username" ILIKE ${like}
        )
      ORDER BY
        CASE
          WHEN u."id"::text = ${term} THEN 0
          WHEN lower(u."email") = lower(${term}) THEN 1
          WHEN lower(u."username") = lower(${term}) THEN 2
          ELSE 3
        END,
        u."first_name" ASC, u."id" ASC
      LIMIT ${PER_KIND}
    `;

    return rows.map(row => ({
      id: row.id,
      name: [row.first_name, row.last_name].filter(Boolean).join(' '),
      username: row.username,
      city: row.city,
      status: row.status,
      avatarUrl: row.avatar_key ? this.media.sign(row.avatar_key) : (row.profile_image_url ?? null),
      matchedOn: row.matched_on,
      adminUrl: memberAdminUrl(row.id),
    }));
  }

  /** Staff, by name or username. Exact username first, for the same reason. */
  private async staff(term: string): Promise<StaffRefView[]> {
    const like = `%${term}%`;
    const rows = await this.database.user.findMany({
      where: {
        isStaff: true,
        deletedAt: null,
        OR: [
          { id: term },
          { username: { equals: term, mode: 'insensitive' } },
          { firstName: { contains: term, mode: 'insensitive' } },
          { lastName: { contains: term, mode: 'insensitive' } },
          { username: { contains: like.replaceAll('%', ''), mode: 'insensitive' } },
        ],
      },
      select: staffRefSelect,
      orderBy: [{ firstName: 'asc' }, { id: 'asc' }],
      take: PER_KIND,
    });

    return rows.map(row => toStaffRef(row, key => this.media.sign(key)));
  }

  /**
   * Content, by its id and nothing else.
   *
   * §5.27 says "by exact id/reportToken", and that restriction is right rather than lazy: a
   * free-text search across eleven content tables is the member-facing search engine, which has
   * its own indexes, its own ranking and its own visibility rules. What a staff member needs from
   * a palette is to paste an id out of a report or a log and land on the thing.
   *
   * Asked of every arm, because an id does not say what it belongs to. Eleven primary-key lookups
   * is cheaper than making the caller name the type they are holding an id for.
   */
  private async content(term: string): Promise<PaletteContentView[]> {
    if (!UUID.test(term)) return [];

    const arms = contentById(term);
    const rows = await this.database.$queryRaw<
      Array<{
        target_type: ReportTargetType;
        id: string;
        title: string | null;
        excerpt: string | null;
        deleted_at: Date | null;
        created_at: Date;
      }>
    >`
      SELECT target_type, id, title, excerpt, deleted_at, created_at
      FROM (${Prisma.join(
        arms.map(arm => arm.sql),
        ' UNION ALL ',
      )}) AS found
      LIMIT ${PER_KIND}
    `;

    return rows.map(row => ({
      targetType: row.target_type,
      targetId: row.id,
      title: row.title,
      excerpt: row.excerpt,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      adminUrl: contentAdminUrl(row.target_type, row.id),
    }));
  }
}
