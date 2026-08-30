import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  ActivityVerb,
  CommunityUpdate,
  Media,
  ModerationQueueType,
  NotificationKind,
  PostVisibility,
  Prisma,
  ReportTargetType,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import {
  ApiErrorCode,
  ApiException,
  Paginated,
  buildPageMeta,
  excerpt,
  toJson,
} from '@/common';
import {
  ActivityService,
  AuthorView,
  BlockingService,
  CityService,
  CityView,
  MediaService,
  MediaView,
  RiskScannerService,
  authorSelect,
  displayNameOf,
  toAuthorView,
  toCityView,
  toMediaViews,
} from '../../shared';
import { CreateUpdateDto, CreateUpdateReplyDto, ListUpdatesDto } from '../dtos/update.dto';
import { NotificationFeedService } from '../../notifications';

export const UPDATE_MEDIA_OWNER = 'COMMUNITY_UPDATE';

export interface UpdateView {
  type: 'UPDATE';
  id: string;
  content: string;
  media: MediaView[];
  city: CityView | null;
  placeLabel: string | null;
  counts: { reactions?: number; replies: number };
  commentsEnabled: boolean;
  reactionCountHidden: boolean;
  author: AuthorView;
  visibility: PostVisibility;
  reportToken: string;
  taggedUsers: AuthorView[];
  viewer: { isOwner: boolean; hasLiked: boolean; isBlocked: boolean; canDelete: boolean };
  createdAt: string;
}

export interface UpdateReplyView {
  id: string;
  content: string;
  author: AuthorView;
  /** Replies carry no media and are one level deep. Both are sent because the card reads them. */
  media: MediaView[];
  replyCount: number;
  /** The viewer's own permission, decided here. Mirrored inside `viewer` for existing callers. */
  canDelete: boolean;
  viewer: { isOwner: boolean; canDelete: boolean };
  createdAt: string;
}

const updateInclude = {
  author: { select: authorSelect },
  city: { select: { id: true, name: true, region: true } },
  tags: { include: { user: { select: authorSelect } } },
} satisfies Prisma.CommunityUpdateInclude;

type UpdateRow = Prisma.CommunityUpdateGetPayload<{ include: typeof updateInclude }>;

@Injectable()
export class UpdateService {
  constructor(
    private readonly database: PrismaService,
    private readonly cities: CityService,
    private readonly media: MediaService,
    private readonly blocking: BlockingService,
    private readonly activity: ActivityService,
    private readonly risk: RiskScannerService,
    private readonly notifications: NotificationFeedService,
  ) {}

  async list(viewerId: string, query: ListUpdatesDto): Promise<Paginated<UpdateView>> {
    const blockedIds = await this.blocking.blockedUserIds(viewerId);
    const where: Prisma.CommunityUpdateWhereInput = {
      deletedAt: null,
      ...(query.cityId ? { cityId: query.cityId } : {}),
      ...(query.authorId ? { authorId: query.authorId } : {}),
      ...(blockedIds.length ? { authorId: { notIn: blockedIds } } : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.communityUpdate.count({ where }),
      this.database.communityUpdate.findMany({
        where,
        include: updateInclude,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
    ]);

    const [media, liked] = await Promise.all([
      this.media.forOwners(
        UPDATE_MEDIA_OWNER,
        rows.map(row => row.id),
      ),
      this.likedIds(
        viewerId,
        rows.map(row => row.id),
      ),
    ]);

    return {
      data: rows.map(row => this.toView(row, viewerId, media, liked, new Set(blockedIds))),
      meta: buildPageMeta(query, total),
    };
  }

  async findOne(viewerId: string, id: string): Promise<UpdateView> {
    const update = await this.database.communityUpdate.findUnique({
      where: { id },
      include: updateInclude,
    });

    if (!update) throw ApiException.notFound('This post could not be found.');
    if (update.deletedAt) throw ApiException.deleted('This post');

    if (await this.activity.countView('update', id, viewerId, update.authorId)) {
      await this.database.communityUpdate.update({
        where: { id },
        data: { viewCount: { increment: 1 } },
      });
    }

    const [media, liked, blockedIds] = await Promise.all([
      this.media.forOwners(UPDATE_MEDIA_OWNER, [id]),
      this.likedIds(viewerId, [id]),
      this.blocking.blockedUserIds(viewerId),
    ]);

    return this.toView(update, viewerId, media, liked, new Set(blockedIds));
  }

  async create(userId: string, dto: CreateUpdateDto): Promise<UpdateView> {
    const cityId = dto.cityId ?? (await this.authorCityId(userId));

    if (cityId) await this.cities.assertValid(cityId);

    const media = await this.media.validate(dto.mediaKeys, userId);
    const taggedUserIds = await this.validTaggedUsers(dto.taggedUserIds);

    const created = await this.database.$transaction(async tx => {
      const update = await tx.communityUpdate.create({
        data: {
          authorId: userId,
          content: dto.content,
          cityId: cityId ?? null,
          placeId: dto.placeId ?? null,
          visibility: dto.visibility ?? PostVisibility.PUBLIC,
          commentsEnabled: dto.commentsEnabled ?? true,
          reactionCountHidden: dto.reactionCountHidden ?? false,
        },
      });

      await this.media.attach(tx, media, UPDATE_MEDIA_OWNER, update.id);

      if (taggedUserIds.length) {
        await tx.updateTag.createMany({
          data: taggedUserIds.map(taggedId => ({ updateId: update.id, userId: taggedId })),
          skipDuplicates: true,
        });
      }

      return update;
    });

    await this.afterWrite(created);

    return this.findOne(userId, created.id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const update = await this.load(id);

    if (update.authorId !== userId) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You cannot remove this post.');
    }

    await this.database.communityUpdate.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  // ─── 1.5.3 Reactions ───────────────────────────────────────────────────────

  /** One reaction type only — the UI is a single heart — so no body is needed. */
  async react(
    userId: string,
    id: string,
    liked: boolean,
  ): Promise<{ hasLiked: boolean; reactionCount?: number }> {
    const update = await this.load(id);

    const changed = await this.database.$transaction(async tx => {
      if (liked) {
        const result = await tx.updateReaction.createMany({
          data: [{ updateId: id, userId }],
          skipDuplicates: true,
        });

        if (result.count === 0) return false;

        await tx.communityUpdate.update({
          where: { id },
          data: { reactionCount: { increment: 1 } },
        });

        return true;
      }

      const result = await tx.updateReaction.deleteMany({ where: { updateId: id, userId } });

      if (result.count === 0) return false;

      await tx.communityUpdate.update({
        where: { id },
        data: { reactionCount: { decrement: 1 } },
      });

      return true;
    });

    if (changed && liked) {
      this.activity.record({
        userId,
        verb: ActivityVerb.REACT,
        subject: ActivitySubject.UPDATE,
        subjectId: id,
        cityId: update.cityId,
      });

      // Only on the way up, and only when something actually changed: an unlike is silent, and a
      // second tap on a slow connection has already returned false above.
      const actor = await this.database.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true },
      });

      this.notifications.raise({
        userId: update.authorId,
        actorId: userId,
        kind: NotificationKind.LIKE,
        categoryCode: 'REACTIONS',
        title: `${displayNameOf(actor?.firstName, actor?.lastName)} liked your post`,
        body: excerpt(update.content, 80),
        route: `/community/post/${id}`,
        // One row per post, not one per liker.
        collapseKey: `update:${id}`,
        collapsedTitle: (count, name) =>
          count === 2
            ? `${name} and 1 other liked your post`
            : `${name} and ${count - 1} others liked your post`,
        actorTitle: displayNameOf(actor?.firstName, actor?.lastName),
        metadata: { updateId: id },
      });
    }

    const fresh = await this.database.communityUpdate.findUniqueOrThrow({
      where: { id },
      select: { reactionCount: true, reactionCountHidden: true, authorId: true },
    });

    // When the author hid the count, it goes back to them and to nobody else.
    return {
      hasLiked: liked,
      ...(fresh.reactionCountHidden && fresh.authorId !== userId
        ? {}
        : { reactionCount: fresh.reactionCount }),
    };
  }

  // ─── 1.5.4 Replies ─────────────────────────────────────────────────────────

  async listReplies(
    viewerId: string,
    id: string,
    query: { skip: number; take: number; currentPage: number; perPage: number },
  ): Promise<Paginated<UpdateReplyView>> {
    // The post's author can remove a reply on their own post, not only its writer.
    const update = await this.load(id);

    const blockedIds = await this.blocking.blockedUserIds(viewerId);
    const where: Prisma.UpdateReplyWhereInput = {
      updateId: id,
      deletedAt: null,
      ...(blockedIds.length ? { authorId: { notIn: blockedIds } } : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.updateReply.count({ where }),
      this.database.updateReply.findMany({
        where,
        include: { author: { select: authorSelect } },
        // Replies read oldest first: a thread is a conversation, not a feed.
        orderBy: { createdAt: 'asc' },
        skip: query.skip,
        take: query.take,
      }),
    ]);

    return {
      data: rows.map(row => ({
        id: row.id,
        content: row.content,
        author: toAuthorView(row.author, { sign: this.media.sign }),
        media: [],
        replyCount: 0,
        canDelete: row.authorId === viewerId || update.authorId === viewerId,
        viewer: {
          isOwner: row.authorId === viewerId,
          canDelete: row.authorId === viewerId || update.authorId === viewerId,
        },
        createdAt: row.createdAt.toISOString(),
      })),
      meta: buildPageMeta(query, total),
    };
  }

  async createReply(
    userId: string,
    id: string,
    dto: CreateUpdateReplyDto,
  ): Promise<UpdateReplyView> {
    const update = await this.load(id);

    // The client hides the reply bar when comments are off, but the check has to exist here too (1.5.4).
    if (!update.commentsEnabled) {
      throw ApiException.forbidden(
        ApiErrorCode.COMMENTS_DISABLED,
        'The person who posted this turned comments off.',
      );
    }

    const reply = await this.database.$transaction(async tx => {
      const created = await tx.updateReply.create({
        data: { updateId: id, authorId: userId, content: dto.content },
        include: { author: { select: authorSelect } },
      });

      await tx.communityUpdate.update({ where: { id }, data: { replyCount: { increment: 1 } } });

      return created;
    });

    this.notifications.raise({
      userId: update.authorId,
      actorId: userId,
      kind: NotificationKind.REPLY,
      categoryCode: 'REPLIES',
      title: 'New reply to your update',
      body: excerpt(dto.content, 80),
      route: `/community/update/${id}`,
    });

    return {
      id: reply.id,
      content: reply.content,
      author: toAuthorView(reply.author, { sign: this.media.sign }),
      media: [],
      replyCount: 0,
      canDelete: true,
      viewer: { isOwner: true, canDelete: true },
      createdAt: reply.createdAt.toISOString(),
    };
  }

  async removeReply(userId: string, updateId: string, replyId: string): Promise<void> {
    const reply = await this.database.updateReply.findUnique({
      where: { id: replyId },
      include: { update: { select: { authorId: true } } },
    });

    if (!reply || reply.updateId !== updateId) {
      throw ApiException.notFound('This reply could not be found.');
    }

    if (reply.deletedAt) throw ApiException.deleted('This reply');

    if (reply.authorId !== userId && reply.update.authorId !== userId) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You cannot remove this reply.');
    }

    await this.database.$transaction(async tx => {
      await tx.updateReply.update({ where: { id: replyId }, data: { deletedAt: new Date() } });
      await tx.communityUpdate.update({
        where: { id: updateId },
        data: { replyCount: { decrement: 1 } },
      });
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private toView(
    row: UpdateRow,
    viewerId: string | null,
    media: Map<string, Media[]>,
    liked: Set<string>,
    blockedIds: Set<string>,
  ): UpdateView {
    const isOwner = viewerId !== null && row.authorId === viewerId;
    const isAnonymous = row.visibility === PostVisibility.ANONYMOUS;

    return {
      type: 'UPDATE',
      id: row.id,
      content: row.content,
      media: toMediaViews(media.get(row.id), this.media.sign),
      city: toCityView(row.city),
      placeLabel: row.placeLabel,
      counts: {
        ...(row.reactionCountHidden && !isOwner ? {} : { reactions: row.reactionCount }),
        replies: row.replyCount,
      },
      commentsEnabled: row.commentsEnabled,
      reactionCountHidden: row.reactionCountHidden,
      author: toAuthorView(row.author, { sign: this.media.sign, isAnonymous }),
      visibility: row.visibility,
      reportToken: row.reportToken,
      taggedUsers: row.tags.map(tag => toAuthorView(tag.user, { sign: this.media.sign })),
      viewer: {
        isOwner,
        hasLiked: liked.has(row.id),
        isBlocked: blockedIds.has(row.authorId),
        canDelete: isOwner,
      },
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async likedIds(viewerId: string | null, updateIds: string[]): Promise<Set<string>> {
    if (!viewerId || !updateIds.length) return new Set();

    const rows = await this.database.updateReaction.findMany({
      where: { userId: viewerId, updateId: { in: updateIds } },
      select: { updateId: true },
    });

    return new Set(rows.map(row => row.updateId));
  }

  private async authorCityId(userId: string): Promise<string | null> {
    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { cityId: true },
    });

    return profile?.cityId ?? null;
  }

  /** Tagging someone who has blocked you, or who does not exist, silently drops them rather than failing the post: the member's update is the thing that matters, and a 422 naming who blocked them would leak the block. */
  private async validTaggedUsers(taggedUserIds: string[] | undefined): Promise<string[]> {
    if (!taggedUserIds?.length) return [];

    const users = await this.database.user.findMany({
      where: { id: { in: taggedUserIds }, isAnonymised: false },
      select: { id: true },
    });

    return users.map(user => user.id);
  }

  private async load(id: string): Promise<CommunityUpdate> {
    const update = await this.database.communityUpdate.findUnique({ where: { id } });

    if (!update) throw ApiException.notFound('This post could not be found.');
    if (update.deletedAt) throw ApiException.deleted('This post');

    return update;
  }

  private async afterWrite(update: CommunityUpdate): Promise<void> {
    this.activity.record({
      userId: update.authorId,
      verb: ActivityVerb.CREATE,
      subject: ActivitySubject.UPDATE,
      subjectId: update.id,
      cityId: update.cityId,
      weight: 2,
    });

    const assessment = await this.risk.scan(update.content);
    const isAnonymous = update.visibility === PostVisibility.ANONYMOUS;

    if (!this.risk.isUrgent(assessment) && !isAnonymous) return;

    await this.database.moderationQueueItem
      .upsert({
        where: {
          type_targetType_targetId: {
            type: isAnonymous ? ModerationQueueType.ANONYMOUS_POST : ModerationQueueType.GUARD_RISK,
            targetType: ReportTargetType.UPDATE,
            targetId: update.id,
          },
        },
        update: {},
        create: {
          type: isAnonymous ? ModerationQueueType.ANONYMOUS_POST : ModerationQueueType.GUARD_RISK,
          targetType: ReportTargetType.UPDATE,
          targetId: update.id,
          subjectUserId: update.authorId,
          riskLevel: assessment.level,
          riskCategory: assessment.category,
          riskScore: assessment.score,
          riskSignals: toJson(assessment.signals),
          summary: update.content.slice(0, 200),
        },
      })
      .catch(() => undefined);
  }
}
