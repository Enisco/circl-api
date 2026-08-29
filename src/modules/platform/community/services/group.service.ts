import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  ActivityVerb,
  Group,
  GroupMembershipState,
  JoinPolicy,
  NotificationKind,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { NotificationFeedService } from '../../notifications';
import {
  ApiErrorCode,
  ApiException,
  Paginated,
  buildPageMeta,
  daysAgo,
  excerpt,
} from '@/common';
import {
  ActivityService,
  AuthorView,
  BlockingService,
  CityService,
  CityView,
  MediaService,
  MediaView,
  authorSelect,
  toAuthorView,
  toCityView,
  toMediaViews,
} from '../../shared';
import {
  CreateGroupDto,
  CreateGroupPostDto,
  CreateGroupPostReplyDto,
  ListGroupsDto,
  UpdateGroupDto,
} from '../dtos/group.dto';

export const GROUP_POST_MEDIA_OWNER = 'GROUP_POST';

/** `isNew` is server-computed so the definition lives in one place (1.7.1). */
const NEW_GROUP_DAYS = 14;

export type MembershipView = 'NONE' | 'PENDING' | 'MEMBER' | 'ADMIN';

export interface GroupSummaryView {
  id: string;
  name: string;
  description: string;
  city: CityView | null;
  memberCount: number;
  joinPolicy: JoinPolicy;
  isNew: boolean;
  avatarUrl: string | null;
  viewer: { membership: MembershipView; unreadPostCount: number; isAdmin: boolean };
  createdAt: string;
}

export interface GroupDetailView extends GroupSummaryView {
  rules: string | null;
  memberPreview: AuthorView[];
  admins: AuthorView[];
  reportToken: string;
  pendingRequestCount?: number;
  viewer: GroupSummaryView['viewer'] & { canPost: boolean; canModerate: boolean };
}

export interface GroupPostView {
  id: string;
  content: string;
  media: MediaView[];
  counts: { replies: number };
  author: AuthorView;
  viewer: { isOwner: boolean; canDelete: boolean };
  createdAt: string;
}

@Injectable()
export class GroupService {
  constructor(
    private readonly database: PrismaService,
    private readonly cities: CityService,
    private readonly media: MediaService,
    private readonly blocking: BlockingService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationFeedService,
  ) {}

  // ─── 1.7.1 List ────────────────────────────────────────────────────────────

  async list(viewerId: string, query: ListGroupsDto): Promise<Paginated<GroupSummaryView>> {
    const where: Prisma.GroupWhereInput = { deletedAt: null };

    if (query.cityId) where.cityId = query.cityId;

    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: Prisma.QueryMode.insensitive } },
        { description: { contains: query.q, mode: Prisma.QueryMode.insensitive } },
      ];
    }

    // Membership filters are expressed as a relation predicate rather than a fetch-then-filter, so paging stays correct: filtering after the page is taken produces short pages and a totalCount nobody can trust.
    switch (query.membership) {
      case 'JOINED':
        where.memberships = {
          some: {
            userId: viewerId,
            state: { in: [GroupMembershipState.MEMBER, GroupMembershipState.ADMIN] },
          },
        };
        break;
      case 'PENDING':
        where.memberships = { some: { userId: viewerId, state: GroupMembershipState.PENDING } };
        break;
      case 'NOT_JOINED':
        where.memberships = {
          none: {
            userId: viewerId,
            state: {
              in: [
                GroupMembershipState.MEMBER,
                GroupMembershipState.ADMIN,
                GroupMembershipState.PENDING,
              ],
            },
          },
        };
        break;
      default:
        break;
    }

    const [total, rows] = await this.database.$transaction([
      this.database.group.count({ where }),
      this.database.group.findMany({
        where,
        include: { city: { select: { id: true, name: true, region: true } } },
        orderBy: this.orderFor(query.sort),
        skip: query.skip,
        take: query.take,
      }),
    ]);

    const memberships = await this.membershipsFor(
      viewerId,
      rows.map(row => row.id),
    );
    const unread = await this.unreadCounts(viewerId, rows, memberships);

    return {
      data: rows.map(row => this.toSummary(row, memberships.get(row.id), unread.get(row.id) ?? 0)),
      meta: buildPageMeta(query, total),
    };
  }

  private orderFor(sort: ListGroupsDto['sort']): Prisma.GroupOrderByWithRelationInput[] {
    switch (sort) {
      case 'NEWEST':
        return [{ createdAt: 'desc' }];
      case 'MOST_MEMBERS':
        return [{ memberCount: 'desc' }];
      case 'MOST_ACTIVE':
        return [{ lastPostAt: { sort: 'desc', nulls: 'last' } }, { postCount: 'desc' }];
      default:
        // RECOMMENDED, until there are enough signals to do better: active and populated, which is what a member joining their first group wants.
        return [{ lastPostAt: { sort: 'desc', nulls: 'last' } }, { memberCount: 'desc' }];
    }
  }

  // ─── 1.7.2 Detail ──────────────────────────────────────────────────────────

  async findOne(viewerId: string, id: string): Promise<GroupDetailView> {
    const group = await this.database.group.findUnique({
      where: { id },
      include: { city: { select: { id: true, name: true, region: true } } },
    });

    if (!group) throw ApiException.notFound('This group could not be found.');
    if (group.deletedAt) throw ApiException.deleted('This group');

    const memberships = await this.membershipsFor(viewerId, [id]);
    const membership = memberships.get(id);
    const unread = await this.unreadCounts(viewerId, [group], memberships);

    const [preview, admins] = await Promise.all([
      this.database.groupMembership.findMany({
        where: {
          groupId: id,
          state: { in: [GroupMembershipState.MEMBER, GroupMembershipState.ADMIN] },
        },
        include: { user: { select: authorSelect } },
        // Admins first, then most recently active (1.7.2).
        orderBy: [{ isAdmin: 'desc' }, { lastActiveAt: 'desc' }],
        take: 10,
      }),
      this.database.groupMembership.findMany({
        where: { groupId: id, isAdmin: true, state: { not: GroupMembershipState.REMOVED } },
        include: { user: { select: authorSelect } },
      }),
    ]);

    const isMember = membership === 'MEMBER' || membership === 'ADMIN';
    const isAdmin = membership === 'ADMIN';

    const summary = this.toSummary(group, membership, unread.get(id) ?? 0);
    const detail: GroupDetailView = {
      ...summary,
      rules: group.rules,
      memberPreview: preview.map(row => toAuthorView(row.user, { sign: this.media.sign })),
      admins: admins.map(row => toAuthorView(row.user, { sign: this.media.sign })),
      reportToken: group.reportToken,
      viewer: { ...summary.viewer, canPost: isMember, canModerate: isAdmin },
    };

    if (isAdmin) {
      detail.pendingRequestCount = await this.database.groupMembership.count({
        where: { groupId: id, state: GroupMembershipState.PENDING },
      });
    }

    return detail;
  }

  // ─── 1.7.3 Create ──────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateGroupDto): Promise<GroupDetailView> {
    const city = await this.cities.assertValid(dto.cityId);

    const clash = await this.database.group.findFirst({
      where: { cityId: city.id, name: dto.name, deletedAt: null },
      select: { id: true },
    });

    if (clash) {
      throw ApiException.conflict(
        ApiErrorCode.GROUP_NAME_TAKEN,
        'A group with this name already exists in this city.',
        { data: { groupId: clash.id } },
      );
    }

    const avatar = dto.avatarKey
      ? (
          await this.media.validate([dto.avatarKey], userId, {
            maxImages: 1,
            allowVideo: false,
            allowAudio: false,
          })
        )[0]
      : null;

    const group = await this.database.$transaction(async tx => {
      const created = await tx.group.create({
        data: {
          name: dto.name,
          description: dto.description,
          cityId: city.id,
          joinPolicy: dto.joinPolicy ?? JoinPolicy.OPEN,
          rules: dto.rules ?? null,
          createdById: userId,
          avatarKey: avatar?.storageKey ?? null,
          // The creator becomes the first member and the first admin, which is what the live preview card in the composer already shows (1.7.3).
          memberCount: 1,
        },
      });

      await tx.groupMembership.create({
        data: {
          groupId: created.id,
          userId,
          state: GroupMembershipState.ADMIN,
          isAdmin: true,
          joinedAt: new Date(),
        },
      });

      if (avatar) await this.media.attach(tx, [avatar], 'GROUP_AVATAR', created.id);

      return created;
    });

    this.activity.record({
      userId,
      verb: ActivityVerb.CREATE,
      subject: ActivitySubject.GROUP,
      subjectId: group.id,
      cityId: group.cityId,
      weight: 4,
    });

    return this.findOne(userId, group.id);
  }

  async update(userId: string, id: string, dto: UpdateGroupDto): Promise<GroupDetailView> {
    await this.assertAdmin(userId, id);

    await this.database.group.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        joinPolicy: dto.joinPolicy,
        rules: dto.rules,
      },
    });

    return this.findOne(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.assertAdmin(userId, id);

    // Soft delete, cascading to posts through the same flag rather than a physical cascade — a deleted group's content stays available to moderation.
    await this.database.$transaction(async tx => {
      const now = new Date();

      await tx.group.update({ where: { id }, data: { deletedAt: now } });
      await tx.groupPost.updateMany({
        where: { groupId: id, deletedAt: null },
        data: { deletedAt: now },
      });
    });
  }

  // ─── 1.7.4 Membership ──────────────────────────────────────────────────────

  async join(
    userId: string,
    id: string,
  ): Promise<{ membership: MembershipView; memberCount: number }> {
    const group = await this.load(id);
    const existing = await this.database.groupMembership.findUnique({
      where: { groupId_userId: { groupId: id, userId } },
    });

    if (
      existing &&
      existing.state !== GroupMembershipState.REMOVED &&
      existing.state !== GroupMembershipState.REJECTED
    ) {
      // Already in, or already waiting.
      return { membership: this.stateToView(existing), memberCount: group.memberCount };
    }

    const isOpen = group.joinPolicy === JoinPolicy.OPEN;
    const state = isOpen ? GroupMembershipState.MEMBER : GroupMembershipState.PENDING;

    const memberCount = await this.database.$transaction(async tx => {
      await tx.groupMembership.upsert({
        where: { groupId_userId: { groupId: id, userId } },
        update: {
          state,
          requestedAt: new Date(),
          joinedAt: isOpen ? new Date() : null,
          decidedAt: null,
        },
        create: { groupId: id, userId, state, joinedAt: isOpen ? new Date() : null },
      });

      if (!isOpen) return group.memberCount;

      const updated = await tx.group.update({
        where: { id },
        data: { memberCount: { increment: 1 } },
        select: { memberCount: true },
      });

      return updated.memberCount;
    });

    if (isOpen) {
      this.activity.record({
        userId,
        verb: ActivityVerb.JOIN,
        subject: ActivitySubject.GROUP,
        subjectId: id,
        cityId: group.cityId,
        weight: 3,
      });
    }

    return { membership: isOpen ? 'MEMBER' : 'PENDING', memberCount };
  }

  async leave(
    userId: string,
    id: string,
  ): Promise<{ membership: MembershipView; memberCount: number }> {
    const group = await this.load(id);
    const membership = await this.database.groupMembership.findUnique({
      where: { groupId_userId: { groupId: id, userId } },
    });

    if (!membership || membership.state === GroupMembershipState.REMOVED) {
      return { membership: 'NONE', memberCount: group.memberCount };
    }

    // The last admin cannot walk out of a group with other people in it.
    if (membership.isAdmin && group.memberCount > 1) {
      const otherAdmins = await this.database.groupMembership.count({
        where: {
          groupId: id,
          isAdmin: true,
          userId: { not: userId },
          state: { not: GroupMembershipState.REMOVED },
        },
      });

      if (otherAdmins === 0) {
        throw ApiException.conflict(
          ApiErrorCode.LAST_ADMIN_CANNOT_LEAVE,
          'You are the only admin. Make someone else an admin, or delete the group, before leaving.',
        );
      }
    }

    const wasCounted =
      membership.state === GroupMembershipState.MEMBER ||
      membership.state === GroupMembershipState.ADMIN;

    const memberCount = await this.database.$transaction(async tx => {
      await tx.groupMembership.delete({ where: { groupId_userId: { groupId: id, userId } } });

      if (!wasCounted) return group.memberCount;

      const updated = await tx.group.update({
        where: { id },
        data: { memberCount: { decrement: 1 } },
        select: { memberCount: true },
      });

      return updated.memberCount;
    });

    return { membership: 'NONE', memberCount };
  }

  async listJoinRequests(
    userId: string,
    id: string,
    query: { skip: number; take: number; currentPage: number; perPage: number },
  ): Promise<Paginated<{ user: AuthorView; requestedAt: string }>> {
    await this.assertAdmin(userId, id);

    const where = { groupId: id, state: GroupMembershipState.PENDING };

    const [total, rows] = await this.database.$transaction([
      this.database.groupMembership.count({ where }),
      this.database.groupMembership.findMany({
        where,
        include: { user: { select: authorSelect } },
        orderBy: { requestedAt: 'asc' },
        skip: query.skip,
        take: query.take,
      }),
    ]);

    return {
      data: rows.map(row => ({
        user: toAuthorView(row.user, { sign: this.media.sign }),
        requestedAt: row.requestedAt.toISOString(),
      })),
      meta: buildPageMeta(query, total),
    };
  }

  async decideJoinRequest(
    adminId: string,
    id: string,
    subjectUserId: string,
    decision: 'APPROVE' | 'REJECT',
  ): Promise<{ membership: MembershipView; memberCount: number }> {
    await this.assertAdmin(adminId, id);

    const membership = await this.database.groupMembership.findUnique({
      where: { groupId_userId: { groupId: id, userId: subjectUserId } },
    });

    if (!membership || membership.state !== GroupMembershipState.PENDING) {
      throw ApiException.notFound('There is no pending request from this member.');
    }

    const approve = decision === 'APPROVE';

    const memberCount = await this.database.$transaction(async tx => {
      await tx.groupMembership.update({
        where: { groupId_userId: { groupId: id, userId: subjectUserId } },
        data: {
          state: approve ? GroupMembershipState.MEMBER : GroupMembershipState.REJECTED,
          joinedAt: approve ? new Date() : null,
          decidedAt: new Date(),
        },
      });

      const group = approve
        ? await tx.group.update({
            where: { id },
            data: { memberCount: { increment: 1 } },
            select: { memberCount: true },
          })
        : await tx.group.findUniqueOrThrow({ where: { id }, select: { memberCount: true } });

      return group.memberCount;
    });

    return { membership: approve ? 'MEMBER' : 'NONE', memberCount };
  }

  async removeMember(
    adminId: string,
    id: string,
    subjectUserId: string,
  ): Promise<{ memberCount: number }> {
    await this.assertAdmin(adminId, id);

    if (adminId === subjectUserId) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Use leave rather than removing yourself.',
      );
    }

    const membership = await this.database.groupMembership.findUnique({
      where: { groupId_userId: { groupId: id, userId: subjectUserId } },
    });

    if (!membership) throw ApiException.notFound('This member is not in the group.');

    const wasCounted =
      membership.state === GroupMembershipState.MEMBER ||
      membership.state === GroupMembershipState.ADMIN;

    const memberCount = await this.database.$transaction(async tx => {
      await tx.groupMembership.update({
        where: { groupId_userId: { groupId: id, userId: subjectUserId } },
        data: { state: GroupMembershipState.REMOVED, isAdmin: false, decidedAt: new Date() },
      });

      if (!wasCounted) {
        const group = await tx.group.findUniqueOrThrow({
          where: { id },
          select: { memberCount: true },
        });

        return group.memberCount;
      }

      const group = await tx.group.update({
        where: { id },
        data: { memberCount: { decrement: 1 } },
        select: { memberCount: true },
      });

      return group.memberCount;
    });

    return { memberCount };
  }

  // ─── 1.7.5 Posts and replies ───────────────────────────────────────────────

  async listPosts(
    viewerId: string,
    id: string,
    query: { skip: number; take: number; currentPage: number; perPage: number },
  ): Promise<Paginated<GroupPostView> & { meta: { preview?: boolean } }> {
    await this.load(id);

    const membership = (await this.membershipsFor(viewerId, [id])).get(id);
    const isMember = membership === 'MEMBER' || membership === 'ADMIN';

    // A non-member gets a preview of the last 3 posts rather than an empty wall, because proof of life beats an empty invitation.
    const take = isMember ? query.take : 3;
    const blockedIds = await this.blocking.blockedUserIds(viewerId);

    const where: Prisma.GroupPostWhereInput = {
      groupId: id,
      deletedAt: null,
      ...(blockedIds.length ? { authorId: { notIn: blockedIds } } : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.groupPost.count({ where }),
      this.database.groupPost.findMany({
        where,
        include: { author: { select: authorSelect } },
        orderBy: { createdAt: 'desc' },
        skip: isMember ? query.skip : 0,
        take,
      }),
    ]);

    const media = isMember
      ? await this.media.forOwners(
          GROUP_POST_MEDIA_OWNER,
          rows.map(row => row.id),
        )
      : new Map();

    if (isMember && rows.length) {
      // Opening the wall reads it, which is what clears the unread dot.
      await this.database.groupMembership.update({
        where: { groupId_userId: { groupId: id, userId: viewerId } },
        data: { lastReadAt: new Date(), lastActiveAt: new Date() },
      });
    }

    return {
      data: rows.map(row => ({
        id: row.id,
        content: isMember ? row.content : excerpt(row.content, 120),
        media: isMember ? toMediaViews(media.get(row.id), this.media.sign) : [],
        counts: { replies: row.replyCount },
        author: toAuthorView(row.author, { sign: this.media.sign }),
        viewer: {
          isOwner: row.authorId === viewerId,
          canDelete: row.authorId === viewerId || membership === 'ADMIN',
        },
        createdAt: row.createdAt.toISOString(),
      })),
      meta: {
        ...buildPageMeta(isMember ? query : { currentPage: 1, perPage: take }, total),
        ...(isMember ? {} : { preview: true }),
      },
    };
  }

  async createPost(userId: string, id: string, dto: CreateGroupPostDto): Promise<GroupPostView> {
    await this.assertMember(userId, id);

    const media = await this.media.validate(dto.mediaKeys, userId);

    const post = await this.database.$transaction(async tx => {
      const created = await tx.groupPost.create({
        data: { groupId: id, authorId: userId, content: dto.content },
        include: { author: { select: authorSelect } },
      });

      await this.media.attach(tx, media, GROUP_POST_MEDIA_OWNER, created.id);
      await tx.group.update({
        where: { id },
        data: { postCount: { increment: 1 }, lastPostAt: new Date() },
      });

      return created;
    });

    return {
      id: post.id,
      content: post.content,
      media: toMediaViews(
        media.map((item, index) => ({ ...item, position: index })),
        this.media.sign,
      ),
      counts: { replies: 0 },
      author: toAuthorView(post.author, { sign: this.media.sign }),
      viewer: { isOwner: true, canDelete: true },
      createdAt: post.createdAt.toISOString(),
    };
  }

  async removePost(userId: string, groupId: string, postId: string): Promise<void> {
    const post = await this.database.groupPost.findUnique({ where: { id: postId } });

    if (!post || post.groupId !== groupId)
      throw ApiException.notFound('This post could not be found.');
    if (post.deletedAt) throw ApiException.deleted('This post');

    const membership = (await this.membershipsFor(userId, [groupId])).get(groupId);

    if (post.authorId !== userId && membership !== 'ADMIN') {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You cannot remove this post.');
    }

    await this.database.$transaction(async tx => {
      await tx.groupPost.update({ where: { id: postId }, data: { deletedAt: new Date() } });
      await tx.group.update({ where: { id: groupId }, data: { postCount: { decrement: 1 } } });
    });
  }

  /** Returns the parent post alongside the page of replies. */
  async listPostReplies(
    viewerId: string,
    groupId: string,
    postId: string,
    query: { skip: number; take: number; currentPage: number; perPage: number },
  ) {
    await this.assertMember(viewerId, groupId);

    const post = await this.database.groupPost.findUnique({
      where: { id: postId },
      include: { author: { select: authorSelect } },
    });

    if (!post || post.groupId !== groupId)
      throw ApiException.notFound('This post could not be found.');
    if (post.deletedAt) throw ApiException.deleted('This post');

    const blockedIds = await this.blocking.blockedUserIds(viewerId);
    const where: Prisma.GroupPostReplyWhereInput = {
      postId,
      deletedAt: null,
      ...(blockedIds.length ? { authorId: { notIn: blockedIds } } : {}),
    };

    const [total, rows, media] = await Promise.all([
      this.database.groupPostReply.count({ where }),
      this.database.groupPostReply.findMany({
        where,
        include: { author: { select: authorSelect } },
        orderBy: { createdAt: 'asc' },
        skip: query.skip,
        take: query.take,
      }),
      this.media.forOwners(GROUP_POST_MEDIA_OWNER, [postId]),
    ]);

    return {
      data: {
        post: {
          id: post.id,
          content: post.content,
          media: toMediaViews(media.get(postId), this.media.sign),
          counts: { replies: post.replyCount },
          author: toAuthorView(post.author, { sign: this.media.sign }),
          viewer: { isOwner: post.authorId === viewerId, canDelete: post.authorId === viewerId },
          createdAt: post.createdAt.toISOString(),
        },
        replies: rows.map(row => ({
          id: row.id,
          content: row.content,
          author: toAuthorView(row.author, { sign: this.media.sign }),
          viewer: { isOwner: row.authorId === viewerId, canDelete: row.authorId === viewerId },
          createdAt: row.createdAt.toISOString(),
        })),
      },
      meta: buildPageMeta(query, total),
    };
  }

  async createPostReply(
    userId: string,
    groupId: string,
    postId: string,
    dto: CreateGroupPostReplyDto,
  ) {
    await this.assertMember(userId, groupId);

    const post = await this.database.groupPost.findUnique({ where: { id: postId } });

    if (!post || post.groupId !== groupId)
      throw ApiException.notFound('This post could not be found.');
    if (post.deletedAt) throw ApiException.deleted('This post');

    const reply = await this.database.$transaction(async tx => {
      const created = await tx.groupPostReply.create({
        data: { postId, authorId: userId, content: dto.content },
        include: { author: { select: authorSelect } },
      });

      await tx.groupPost.update({ where: { id: postId }, data: { replyCount: { increment: 1 } } });
      await tx.group.update({ where: { id: groupId }, data: { lastPostAt: new Date() } });

      return created;
    });

    // The post's author, not the whole group.
    this.notifications.raise({
      userId: post.authorId,
      actorId: userId,
      kind: NotificationKind.GROUP,
      categoryCode: 'GROUPS',
      title: 'New reply in your group post',
      body: excerpt(dto.content, 80),
      route: `/community/group-post/${postId}`,
    });

    return {
      id: reply.id,
      content: reply.content,
      author: toAuthorView(reply.author, { sign: this.media.sign }),
      viewer: { isOwner: true, canDelete: true },
      createdAt: reply.createdAt.toISOString(),
    };
  }

  async removePostReply(userId: string, groupId: string, postId: string, replyId: string) {
    const reply = await this.database.groupPostReply.findUnique({
      where: { id: replyId },
      include: { post: { select: { groupId: true } } },
    });

    if (!reply || reply.postId !== postId || reply.post.groupId !== groupId) {
      throw ApiException.notFound('This reply could not be found.');
    }

    if (reply.deletedAt) throw ApiException.deleted('This reply');

    const membership = (await this.membershipsFor(userId, [groupId])).get(groupId);

    if (reply.authorId !== userId && membership !== 'ADMIN') {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'You cannot remove this reply.');
    }

    await this.database.$transaction(async tx => {
      await tx.groupPostReply.update({ where: { id: replyId }, data: { deletedAt: new Date() } });
      await tx.groupPost.update({ where: { id: postId }, data: { replyCount: { decrement: 1 } } });
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private toSummary(
    group: Group & { city: { id: string; name: string; region: string | null } | null },
    membership: MembershipView | undefined,
    unreadPostCount: number,
  ): GroupSummaryView {
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      city: toCityView(group.city),
      // An integer, not "1.2k": the client cannot filter or sort a formatted string (0.6).
      memberCount: group.memberCount,
      joinPolicy: group.joinPolicy,
      isNew: group.createdAt >= daysAgo(NEW_GROUP_DAYS),
      avatarUrl: group.avatarKey ? this.media.sign(group.avatarKey) : null,
      viewer: {
        // The single source of truth for whether the button reads Join, Pending or Leave.
        membership: membership ?? 'NONE',
        unreadPostCount,
        isAdmin: membership === 'ADMIN',
      },
      createdAt: group.createdAt.toISOString(),
    };
  }

  private async membershipsFor(
    userId: string,
    groupIds: string[],
  ): Promise<Map<string, MembershipView>> {
    if (!groupIds.length) return new Map();

    const rows = await this.database.groupMembership.findMany({
      where: { userId, groupId: { in: groupIds } },
    });

    return new Map(rows.map(row => [row.groupId, this.stateToView(row)]));
  }

  private stateToView(row: { state: GroupMembershipState; isAdmin: boolean }): MembershipView {
    switch (row.state) {
      case GroupMembershipState.ADMIN:
        return 'ADMIN';
      case GroupMembershipState.MEMBER:
        return row.isAdmin ? 'ADMIN' : 'MEMBER';
      case GroupMembershipState.PENDING:
        return 'PENDING';
      default:
        return 'NONE';
    }
  }

  /** Posts since the member last opened each wall. */
  private async unreadCounts(
    userId: string,
    groups: Array<{ id: string; lastPostAt: Date | null }>,
    memberships: Map<string, MembershipView>,
  ): Promise<Map<string, number>> {
    const joined = groups.filter(group => {
      const membership = memberships.get(group.id);

      return (membership === 'MEMBER' || membership === 'ADMIN') && group.lastPostAt !== null;
    });

    if (!joined.length) return new Map();

    const rows = await this.database.groupMembership.findMany({
      where: { userId, groupId: { in: joined.map(group => group.id) } },
      select: { groupId: true, lastReadAt: true },
    });

    const counts = new Map<string, number>();

    await Promise.all(
      rows.map(async row => {
        const count = await this.database.groupPost.count({
          where: {
            groupId: row.groupId,
            deletedAt: null,
            authorId: { not: userId },
            ...(row.lastReadAt ? { createdAt: { gt: row.lastReadAt } } : {}),
          },
        });

        counts.set(row.groupId, count);
      }),
    );

    return counts;
  }

  private async load(id: string): Promise<Group> {
    const group = await this.database.group.findUnique({ where: { id } });

    if (!group) throw ApiException.notFound('This group could not be found.');
    if (group.deletedAt) throw ApiException.deleted('This group');

    return group;
  }

  private async assertMember(userId: string, groupId: string): Promise<void> {
    await this.load(groupId);

    const membership = (await this.membershipsFor(userId, [groupId])).get(groupId);

    if (membership !== 'MEMBER' && membership !== 'ADMIN') {
      throw ApiException.forbidden(
        ApiErrorCode.NOT_A_MEMBER,
        'Join this group to take part in it.',
      );
    }
  }

  private async assertAdmin(userId: string, groupId: string): Promise<void> {
    await this.load(groupId);

    const membership = (await this.membershipsFor(userId, [groupId])).get(groupId);

    if (membership !== 'ADMIN') {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'Only a group admin can do that.');
    }
  }
}
