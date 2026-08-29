import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { buildPageMeta, excerpt } from '@/common';
import { MediaService } from '@/modules/platform';
import { ActivityType, ListUserActivityDto } from '../dtos';

/** One row of the UNION, before it is dressed for the client. */
interface ActivityRow {
  id: string;
  type: ActivityType;
  title: string | null;
  body: string | null;
  status_code: string | null;
  reply_count: number | null;
  is_anonymous: boolean;
  created_at: Date;
}

/** Already-worded status labels (0.7). */
const STATUS_LABELS: Record<string, string> = {
  OPEN: 'Open',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

/** Where each type points. */
const ROUTES: Record<ActivityType, (id: string) => string> = {
  [ActivityType.REQUEST]: id => `/community/request/${id}`,
  [ActivityType.OFFER]: id => `/community/offer/${id}`,
  [ActivityType.GUIDE]: id => `/community/guide/${id}`,
  [ActivityType.UPDATE]: id => `/community/update/${id}`,
  [ActivityType.GROUP_POST]: id => `/community/group-post/${id}`,
  [ActivityType.REVIEW]: id => `/reviews/${id}`,
};

/** `Media.ownerType` per activity type, for the row thumbnail. */
const MEDIA_OWNERS: Partial<Record<ActivityType, string>> = {
  [ActivityType.REQUEST]: 'COMMUNITY_REQUEST',
  [ActivityType.OFFER]: 'COMMUNITY_OFFER',
  [ActivityType.GUIDE]: 'GUIDE',
  [ActivityType.UPDATE]: 'COMMUNITY_UPDATE',
  [ActivityType.GROUP_POST]: 'GROUP_POST',
};

/** A member's history across every section, in one list (0.16.5). */
@Injectable()
export class UserActivityService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
  ) {}

  async list(subjectId: string, viewerId: string, query: ListUserActivityDto) {
    const isOwner = subjectId === viewerId;
    const wanted = query.type ? [query.type] : Object.values(ActivityType);

    const union = this.union(subjectId, isOwner, wanted);

    if (!union) {
      return { data: [], meta: buildPageMeta(query, 0, { byType: {} }) };
    }

    const [rows, counts] = await Promise.all([
      this.database.$queryRaw<ActivityRow[]>`
        ${union}
        ORDER BY created_at DESC
        LIMIT ${query.perPage} OFFSET ${query.skip}
      `,
      this.database.$queryRaw<Array<{ type: ActivityType; count: bigint }>>`
        SELECT type, COUNT(*)::bigint AS count FROM (${union}) AS activity GROUP BY type
      `,
    ]);

    const byType: Record<string, number> = {};
    let total = 0;

    for (const row of counts) {
      // A type with no rows is omitted entirely rather than sent as 0: the client only renders chips for types that are present, and hides the whole row when there is one (0.16.5).
      byType[row.type] = Number(row.count);
      total += Number(row.count);
    }

    const thumbnails = await this.thumbnails(rows);

    return {
      data: rows.map(row => this.toView(row, isOwner, thumbnails)),
      meta: buildPageMeta(query, total, { byType }),
    };
  }

  /** The per-type SELECTs, unioned. */
  private union(subjectId: string, isOwner: boolean, wanted: ActivityType[]): Prisma.Sql | null {
    // Anonymous rows are returned to the owner and to nobody else.
    const visible = isOwner
      ? Prisma.sql`visibility IN ('PUBLIC', 'ANONYMOUS')`
      : Prisma.sql`visibility = 'PUBLIC'`;

    const branches: Partial<Record<ActivityType, Prisma.Sql>> = {
      [ActivityType.REQUEST]: Prisma.sql`
        SELECT id, 'REQUEST' AS type, title, description AS body, status::text AS status_code,
               reply_count, (visibility = 'ANONYMOUS') AS is_anonymous, created_at
        FROM community_requests
        WHERE author_id = ${subjectId} AND deleted_at IS NULL AND ${visible}`,

      [ActivityType.OFFER]: Prisma.sql`
        SELECT id, 'OFFER' AS type, title, description AS body, NULL AS status_code,
               NULL::int AS reply_count, (visibility = 'ANONYMOUS') AS is_anonymous, created_at
        FROM community_offers
        WHERE author_id = ${subjectId} AND deleted_at IS NULL AND ${visible}`,

      [ActivityType.GUIDE]: Prisma.sql`
        SELECT id, 'GUIDE' AS type, title, intro AS body, NULL AS status_code,
               NULL::int AS reply_count, false AS is_anonymous, created_at
        FROM guides
        WHERE author_id = ${subjectId} AND deleted_at IS NULL AND published_at IS NOT NULL`,

      [ActivityType.UPDATE]: Prisma.sql`
        SELECT id, 'UPDATE' AS type, NULL AS title, content AS body, NULL AS status_code,
               reply_count, (visibility = 'ANONYMOUS') AS is_anonymous, created_at
        FROM community_updates
        WHERE author_id = ${subjectId} AND deleted_at IS NULL AND ${visible}`,

      [ActivityType.GROUP_POST]: Prisma.sql`
        SELECT id, 'GROUP_POST' AS type, NULL AS title, content AS body, NULL AS status_code,
               reply_count, false AS is_anonymous, created_at
        FROM group_posts
        WHERE author_id = ${subjectId} AND deleted_at IS NULL`,

      // The review a member WROTE is their history.
      [ActivityType.REVIEW]: Prisma.sql`
        SELECT id, 'REVIEW' AS type, NULL AS title, comment AS body, NULL AS status_code,
               NULL::int AS reply_count, false AS is_anonymous, created_at
        FROM reviews
        WHERE reviewer_id = ${subjectId} AND deleted_at IS NULL`,
    };

    const selected = wanted.map(type => branches[type]).filter(Boolean) as Prisma.Sql[];

    if (!selected.length) return null;

    return Prisma.join(selected, ' UNION ALL ');
  }

  /** One query for every thumbnail on the page, keyed by owner type and id. */
  private async thumbnails(rows: ActivityRow[]): Promise<Map<string, string>> {
    const owners = rows
      .map(row => ({ ownerType: MEDIA_OWNERS[row.type], ownerId: row.id }))
      .filter((owner): owner is { ownerType: string; ownerId: string } => Boolean(owner.ownerType));

    if (!owners.length) return new Map();

    const media = await this.database.media.findMany({
      where: { OR: owners, position: 0 },
      select: { ownerType: true, ownerId: true, storageKey: true, thumbnailKey: true },
    });

    return new Map(
      media.map(item => [
        `${item.ownerType}:${item.ownerId}`,
        // The derived thumbnail when the S3 handler has produced one, the full object until then, so a row is never blank while a scan is pending.
        this.media.sign(item.thumbnailKey ?? item.storageKey),
      ]),
    );
  }

  private toView(row: ActivityRow, isOwner: boolean, thumbnails: Map<string, string>) {
    const owner = MEDIA_OWNERS[row.type];

    return {
      id: row.id,
      type: row.type,
      // Updates and group posts have no title of their own, so the first line of the body stands in rather than the row rendering an empty heading.
      title: row.title ?? excerpt(row.body ?? '', 80),
      excerpt: excerpt(row.body ?? '', 140),
      route: ROUTES[row.type](row.id),
      status: row.status_code
        ? { code: row.status_code, label: STATUS_LABELS[row.status_code] ?? row.status_code }
        : null,
      // Omitted rather than sent as 0 where the type has no replies (0.16.5).
      ...(row.reply_count !== null ? { replyCount: row.reply_count } : {}),
      // Owner-only.
      ...(isOwner ? { isAnonymous: row.is_anonymous } : {}),
      thumbnailUrl: (owner && thumbnails.get(`${owner}:${row.id}`)) ?? null,
      createdAt: row.created_at.toISOString(),
    };
  }
}
