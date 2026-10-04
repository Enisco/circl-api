import { Injectable } from '@nestjs/common';
import {
  ActivitySubject,
  ActivityVerb,
  Group,
  GroupMembershipState,
  GroupVisibility,
  JoinPolicy,
  NotificationKind,
  ParticipantRole,
  Prisma,
  TaxonomyKind,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { NotificationFeedService } from '../../notifications';
import {
  ApiErrorCode,
  ApiException,
  buildPageMeta,
  daysAgo,
  escapeLike,
  excerpt,
  Paginated,
  stripFormatting,
} from '@/common';
import {
  ActivityService,
  AuthorView,
  BlockingService,
  CityService,
  CityView,
  MediaService,
  MediaView,
  TaxonomyService,
  TermView,
  authorSelect,
  toAuthorView,
  toCityView,
  toMediaViews,
  toTermView,
} from '../../shared';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import {
  CreateGroupDto,
  CreateGroupPostDto,
  CreateGroupPostReplyDto,
  InviteMembersDto,
  JoinGroupDto,
  ListGroupsDto,
  UpdateGroupDto,
} from '../dtos/group.dto';

export const GROUP_POST_MEDIA_OWNER = 'GROUP_POST';
export const GROUP_AVATAR_MEDIA_OWNER = 'GROUP_AVATAR';

/** A group row with everything the view needs selected. */
type GroupRow = Group & { city: { id: string; name: string; region: string | null } | null };

interface Standing {
  membership: MembershipView;
  wasRemoved: boolean;
  isInvited: boolean;
  isMuted: boolean;
  unreadCount: number;
  unreadPostCount: number;
}

interface ThreadFacts {
  lastMessageAt: Date | null;
  messageCount: number;
  preview: string | null;
}

/** What a one-line preview says when the last thing said was not words. */
const MEDIA_PREVIEW: Partial<Record<string, string>> = {
  IMAGE: 'Photo',
  VIDEO: 'Video',
  AUDIO: 'Voice note',
};

/**
 * Rules arrive as a list, or as the one blob of text an older build sends. A string becomes a
 * single rule rather than being split on guesswork: nobody agreed that a newline means a new rule.
 */
const toRuleList = (rules: string | string[] | null | undefined): string[] => {
  if (rules === null || rules === undefined) return [];
  if (Array.isArray(rules)) return rules.map(rule => rule.trim()).filter(Boolean);

  return rules.trim() ? [rules.trim()] : [];
};

/** `isNew` is server-computed so the definition lives in one place (1.7.1). */
const NEW_GROUP_DAYS = 14;

export type MembershipView = 'NONE' | 'PENDING' | 'MEMBER' | 'ADMIN';

/**
 * The flags the client's one button is chosen from, in this order: member, removed, invited,
 * requested, then the policy. They have to be mutually honest or the button lies, so all of them
 * are derived from one membership row and one invitation lookup rather than computed apart.
 */
export interface GroupViewerView {
  membership: MembershipView;
  canPost: boolean;
  canModerate: boolean;
  /** Survives a reload, which is what stops the button flipping back to Join after a refresh. */
  hasRequested: boolean;
  /** Final until an invitation. True for ever after, which is how the client knows not to offer. */
  wasRemoved: boolean;
  isInvited: boolean;
  /** Per member. A muted group still counts its unread; it simply does not notify. */
  isMuted: boolean;
  /** @deprecated Read `unreadCount`, which counts the chat rather than the wall. */
  unreadPostCount: number;
  /** @deprecated Read `membership === 'ADMIN'` or `canModerate`. */
  isAdmin: boolean;
}

export interface GroupSummaryView {
  id: string;
  name: string;
  description: string;
  city: CityView | null;
  category: TermView | null;
  rules: string[];
  memberCount: number;
  joinPolicy: JoinPolicy;
  visibility: GroupVisibility;
  isNew: boolean;
  avatarUrl: string | null;
  createdBy: string;
  /** The group's chat. Null when the caller may not have it: see `redactedFor`. */
  conversationId: string | null;
  lastMessageAt: string | null;
  /** Plain words: the markers are stripped, because this is a one-line preview. */
  lastMessagePreview: string | null;
  unreadCount: number;
  /** Everything ever said, which is how busy a group looks before joining. */
  messageCount: number | null;
  /** Admin only, absent for everybody else. */
  pendingRequestCount?: number;
  viewer: GroupViewerView;
  createdAt: string;
}

export interface GroupDetailView extends GroupSummaryView {
  memberPreview: AuthorView[];
  admins: AuthorView[];
  reportToken: string;
}

export interface GroupMemberView {
  user: AuthorView;
  role: 'ADMIN' | 'MEMBER';
  joinedAt: string | null;
}

export interface GroupInvitationView {
  id: string;
  group: { id: string; name: string; avatarUrl: string | null; memberCount: number };
  invitedBy: AuthorView;
  sentAt: string;
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
    private readonly taxonomy: TaxonomyService,
    private readonly conversations: ConversationFactoryService,
  ) {}

  // ─── 1.7.1 List ────────────────────────────────────────────────────────────

  async list(viewerId: string, query: ListGroupsDto): Promise<Paginated<GroupSummaryView>> {
    const where: Prisma.GroupWhereInput = { deletedAt: null };
    // `scope` and `membership` are two filters that both read the membership relation, so they
    // are ANDed rather than written to the same slot: assigning both left the second one silently
    // deciding, and `?scope=MINE&membership=PENDING` answered as though scope had not been sent.
    const and: Prisma.GroupWhereInput[] = [];

    if (query.cityId) where.cityId = query.cityId;
    if (query.categoryCodes?.length) where.categoryCode = { in: query.categoryCodes };

    // MINE is every group the caller is in; DISCOVER is every other one. A closed group still
    // appears in DISCOVER — its name and description are public, what it has said is not.
    if (query.scope === 'MINE' || query.scope === 'DISCOVER') {
      const joined = {
        userId: viewerId,
        state: { in: [GroupMembershipState.MEMBER, GroupMembershipState.ADMIN] },
      };

      and.push({ memberships: query.scope === 'MINE' ? { some: joined } : { none: joined } });
    }

    if (query.q) {
      // `%` and `_` are ILIKE wildcards; unescaped, `%` matches the whole table (0.5).
      const q = escapeLike(query.q);

      where.OR = [
        { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { description: { contains: q, mode: Prisma.QueryMode.insensitive } },
      ];
    }

    // Membership filters are expressed as a relation predicate rather than a fetch-then-filter, so paging stays correct: filtering after the page is taken produces short pages and a totalCount nobody can trust.
    switch (query.membership) {
      case 'JOINED':
        and.push({
          memberships: {
            some: {
              userId: viewerId,
              state: { in: [GroupMembershipState.MEMBER, GroupMembershipState.ADMIN] },
            },
          },
        });
        break;
      case 'PENDING':
        and.push({
          memberships: { some: { userId: viewerId, state: GroupMembershipState.PENDING } },
        });
        break;
      case 'NOT_JOINED':
        and.push({
          memberships: {
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
          },
        });
        break;
      default:
        break;
    }

    if (and.length) where.AND = and;

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

    const [standing, threads, labels] = await Promise.all([
      this.standingFor(viewerId, rows),
      this.threadFactsFor(rows),
      this.categoryLabels(),
    ]);

    // The card says "3 people are waiting", so the number has to be on the row and not only on
    // the group's own screen. Counted for the caller's own groups alone, in one grouped query.
    const pending = await this.pendingCountsFor(
      rows.filter(row => standing.get(row.id)?.membership === 'ADMIN').map(row => row.id),
    );

    return {
      data: rows.map(row => {
        const summary = this.toSummary(
          row,
          standing.get(row.id)!,
          labels,
          row.conversationId ? threads.get(row.conversationId) : undefined,
        );

        return summary.viewer.canModerate
          ? { ...summary, pendingRequestCount: pending.get(row.id) ?? 0 }
          : summary;
      }),
      meta: buildPageMeta(query, total),
    };
  }

  /** How many are waiting on each of these groups, for the admin's cards. */
  private async pendingCountsFor(groupIds: string[]): Promise<Map<string, number>> {
    if (!groupIds.length) return new Map();

    const rows = await this.database.groupMembership.groupBy({
      by: ['groupId'],
      where: { groupId: { in: groupIds }, state: GroupMembershipState.PENDING },
      _count: { _all: true },
    });

    return new Map(rows.map(row => [row.groupId, row._count._all] as const));
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

    const [standing, threads, labels] = await Promise.all([
      this.standingFor(viewerId, [group]),
      this.threadFactsFor([group]),
      this.categoryLabels(),
    ]);

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

    const summary = this.toSummary(
      group,
      standing.get(id)!,
      labels,
      group.conversationId ? threads.get(group.conversationId) : undefined,
    );
    const detail: GroupDetailView = {
      ...summary,
      memberPreview: preview.map(row => toAuthorView(row.user, { sign: this.media.sign })),
      admins: admins.map(row => toAuthorView(row.user, { sign: this.media.sign })),
      reportToken: group.reportToken,
    };

    if (summary.viewer.canModerate) {
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

    if (dto.categoryCode) {
      await this.taxonomy.assertAllValid(
        TaxonomyKind.COMMUNITY_CATEGORY,
        [dto.categoryCode],
        'categoryCode',
      );
    }

    const group = await this.database.$transaction(async tx => {
      const created = await tx.group.create({
        data: {
          name: dto.name,
          description: dto.description,
          cityId: city.id,
          categoryCode: dto.categoryCode ?? null,
          joinPolicy: dto.joinPolicy ?? JoinPolicy.OPEN,
          visibility: dto.visibility ?? GroupVisibility.OPEN,
          rules: toRuleList(dto.rules),
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

      // The group gets its thread now, so there is something to open the moment it exists. An
      // ordinary conversation: every client gets bubbles, attachments, voice notes, delivery
      // state and pagination without a second messaging stack.
      const { conversation } = await this.conversations.ensure(
        {
          kind: ThreadKind.GROUP,
          // The group's id, not a sorted pair: this is the one thread whose membership changes.
          participantKey: `group:${created.id}`,
          participantIds: [userId],
          contextType: ThreadContextType.GROUP,
          contextId: created.id,
          snapshot: {
            title: created.name,
            thumbnailKey: created.avatarKey,
            route: `/community/group/${created.id}`,
          },
        },
        tx,
      );

      await tx.group.update({
        where: { id: created.id },
        data: { conversationId: conversation.id },
      });

      if (avatar) await this.media.attach(tx, [avatar], GROUP_AVATAR_MEDIA_OWNER, created.id);

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

    if (dto.categoryCode) {
      await this.taxonomy.assertAllValid(
        TaxonomyKind.COMMUNITY_CATEGORY,
        [dto.categoryCode],
        'categoryCode',
      );
    }

    const city = dto.cityId ? await this.cities.assertValid(dto.cityId) : null;
    const avatar = dto.avatarKey
      ? (
          await this.media.validate([dto.avatarKey], userId, {
            maxImages: 1,
            allowVideo: false,
            allowAudio: false,
          })
        )[0]
      : null;

    await this.database.$transaction(async tx => {
      if (avatar) await this.media.attach(tx, [avatar], GROUP_AVATAR_MEDIA_OWNER, id);

      // An explicit null is the remove action. Absent is not: an admin editing the rules sends no
      // avatar key, and reading that as null would take the group's picture with it.
      if (dto.avatarKey === null) {
        await this.media.releaseOwner(tx, GROUP_AVATAR_MEDIA_OWNER, id);
      }

      const updated = await tx.group.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          cityId: city?.id,
          categoryCode: dto.categoryCode,
          joinPolicy: dto.joinPolicy,
          visibility: dto.visibility,
          ...(dto.rules !== undefined ? { rules: toRuleList(dto.rules) } : {}),
          ...(avatar ? { avatarKey: avatar.storageKey } : {}),
          ...(dto.avatarKey === null ? { avatarKey: null } : {}),
        },
      });

      // The inbox row reads the snapshot rather than joining back to the group, so a renamed
      // group would otherwise keep its old name in everybody's messages list for months.
      if (updated.conversationId) {
        await this.conversations.refreshSnapshot(
          ThreadContextType.GROUP,
          id,
          {
            title: updated.name,
            thumbnailKey: updated.avatarKey,
            route: `/community/group/${id}`,
          },
          tx,
        );
      }
    });

    return this.findOne(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const group = await this.assertAdmin(userId, id);

    // Soft delete, cascading to posts through the same flag rather than a physical cascade — a deleted group's content stays available to moderation.
    await this.database.$transaction(async tx => {
      const now = new Date();

      await tx.group.update({ where: { id }, data: { deletedAt: now } });
      await tx.groupPost.updateMany({
        where: { groupId: id, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.groupInvitation.deleteMany({ where: { groupId: id } });
      await tx.groupMembership.deleteMany({ where: { groupId: id } });

      // The thread leaves every inbox and answers 403 to everyone, because participation is what
      // the messages API checks. The messages themselves stay, for the same reason the posts do.
      if (group.conversationId) {
        await tx.conversationParticipant.deleteMany({
          where: { conversationId: group.conversationId },
        });
      }
    });
  }

  // ─── 1.7.4 Membership ──────────────────────────────────────────────────────

  async join(
    userId: string,
    id: string,
    dto: JoinGroupDto = {},
  ): Promise<{ membership: MembershipView; memberCount: number }> {
    const group = await this.load(id);
    const [existing, invitation] = await Promise.all([
      this.database.groupMembership.findUnique({
        where: { groupId_userId: { groupId: id, userId } },
      }),
      this.database.groupInvitation.findUnique({
        where: { groupId_userId: { groupId: id, userId } },
        select: { id: true },
      }),
    ]);

    if (
      existing &&
      existing.state !== GroupMembershipState.REMOVED &&
      existing.state !== GroupMembershipState.REJECTED
    ) {
      // Already in, or already waiting. Asking twice is not an error: answer where they stand.
      return { membership: this.stateToView(existing), memberCount: group.memberCount };
    }

    // Removal is final until an invitation. The client hides the button, so this is the backstop.
    if (existing?.state === GroupMembershipState.REMOVED && !invitation) {
      throw ApiException.forbidden(
        ApiErrorCode.REMOVED_FROM_GROUP,
        'An admin removed you from this group. Only an invitation can let you back in.',
      );
    }

    // An invitation goes straight in, whatever the policy — the admin has already decided.
    const isOpen = group.joinPolicy === JoinPolicy.OPEN || invitation !== null;
    const state = isOpen ? GroupMembershipState.MEMBER : GroupMembershipState.PENDING;

    const memberCount = await this.database.$transaction(async tx => {
      await tx.groupMembership.upsert({
        where: { groupId_userId: { groupId: id, userId } },
        update: {
          state,
          isAdmin: false,
          requestedAt: new Date(),
          requestMessage: dto.message?.trim() || null,
          joinedAt: isOpen ? new Date() : null,
          decidedAt: null,
        },
        create: {
          groupId: id,
          userId,
          state,
          requestMessage: dto.message?.trim() || null,
          joinedAt: isOpen ? new Date() : null,
        },
      });

      // An invitation that outlived the joining it led to would keep the button reading Accept.
      if (invitation) {
        await tx.groupInvitation.delete({ where: { id: invitation.id } });
      }

      if (!isOpen) return group.memberCount;

      await this.addToThread(tx, group.conversationId, [userId]);

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

      // The admin alone, and never every member: a group that narrates everything is a group
      // people mute.
      const actor = await this.notifications.actorName(userId);

      this.notifications.raise({
        userId: group.createdById,
        actorId: userId,
        kind: NotificationKind.GROUP,
        categoryCode: 'GROUPS',
        title: `${actor} joined ${group.name}`,
        body: null,
        route: `/community/group/${id}/members`,
        target: { type: 'GROUP', id },
        collapseKey: `group-joined:${id}`,
        collapsedTitle: (count, actorName) =>
          count === 2
            ? `${actorName} and 1 other joined ${group.name}`
            : `${actorName} and ${count - 1} others joined ${group.name}`,
        actorTitle: actor,
        metadata: { groupId: id, event: 'GROUP_MEMBER_JOINED' },
      });
    } else {
      // A pending request sits in a queue nobody is told about otherwise, so a closed group's
      // members are whoever the owner happened to notice.
      const actor = await this.notifications.actorName(userId);

      this.notifications.raise({
        userId: group.createdById,
        actorId: userId,
        kind: NotificationKind.GROUP,
        categoryCode: 'GROUPS',
        title: `${actor} asked to join ${group.name}`,
        body: null,
        route: `/community/group/${id}/requests`,
        target: { type: 'GROUP', id },
        // One row per group: ten requests is one row saying ten, not ten rows.
        collapseKey: `group-join:${id}`,
        collapsedTitle: (count, actorName) =>
          count === 2
            ? `${actorName} and 1 other asked to join ${group.name}`
            : `${actorName} and ${count - 1} others asked to join ${group.name}`,
        actorTitle: actor,
        metadata: { groupId: id, event: 'GROUP_JOIN_REQUEST' },
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

      // Withdrawing a request moves nothing: a request was never a membership.
      if (!wasCounted) return group.memberCount;

      await this.removeFromThread(tx, group.conversationId, [userId]);

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
  ): Promise<Paginated<{ user: AuthorView; message: string | null; requestedAt: string }>> {
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
        message: row.requestMessage,
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
  ): Promise<GroupDetailView> {
    const group = await this.assertAdmin(adminId, id);

    const membership = await this.database.groupMembership.findUnique({
      where: { groupId_userId: { groupId: id, userId: subjectUserId } },
    });

    if (!membership || membership.state !== GroupMembershipState.PENDING) {
      throw ApiException.notFound('There is no pending request from this member.');
    }

    const approve = decision === 'APPROVE';

    await this.database.$transaction(async tx => {
      await tx.groupMembership.update({
        where: { groupId_userId: { groupId: id, userId: subjectUserId } },
        data: {
          state: approve ? GroupMembershipState.MEMBER : GroupMembershipState.REJECTED,
          joinedAt: approve ? new Date() : null,
          decidedAt: new Date(),
        },
      });

      if (!approve) return;

      await this.addToThread(tx, group.conversationId, [subjectUserId]);
      await tx.group.update({ where: { id }, data: { memberCount: { increment: 1 } } });
    });

    // Both outcomes, because a request that is silently declined is indistinguishable from one
    // nobody has looked at yet, and the member keeps checking.
    this.notifications.raise({
      userId: subjectUserId,
      actorId: adminId,
      kind: NotificationKind.GROUP,
      categoryCode: 'GROUPS',
      title: approve
        ? `You are in ${group.name}`
        : `Your request to join ${group.name} was declined`,
      body: null,
      // A declined member has nowhere useful to go, so that row is unroutable by design (6.1.1).
      route: approve ? `/community/group/${id}` : null,
      // A declined member has nowhere to go, so there is no target either.
      target: approve ? { type: 'GROUP', id } : null,
      metadata: {
        groupId: id,
        event: approve ? 'GROUP_REQUEST_ACCEPTED' : 'GROUP_REQUEST_REJECTED',
      },
    });

    // Both numbers moved and the screen reads both, so the whole group comes back — which already
    // carries `memberCount` and `pendingRequestCount` — rather than a pair the client has to merge.
    return this.findOne(adminId, id);
  }

  async removeMember(adminId: string, id: string, subjectUserId: string): Promise<GroupDetailView> {
    const group = await this.assertAdmin(adminId, id);

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

    await this.database.$transaction(async tx => {
      await tx.groupMembership.update({
        where: { groupId_userId: { groupId: id, userId: subjectUserId } },
        data: { state: GroupMembershipState.REMOVED, isAdmin: false, decidedAt: new Date() },
      });

      // An invitation is the only way back, so any outstanding one goes with the removal.
      await tx.groupInvitation.deleteMany({ where: { groupId: id, userId: subjectUserId } });

      // Somebody who only asked was never counted, so removing them moves nothing.
      if (!wasCounted) return;

      await this.removeFromThread(tx, group.conversationId, [subjectUserId]);
      await tx.group.update({ where: { id }, data: { memberCount: { decrement: 1 } } });
    });

    // Being removed from a group is something a member has to be told, or they come back to a
    // group that has silently stopped being theirs.
    this.notifications.raise({
      userId: subjectUserId,
      actorId: adminId,
      kind: NotificationKind.GROUP,
      categoryCode: 'GROUPS',
      title: `You were removed from ${group.name}`,
      body: null,
      // Nowhere useful to go, so that row is unroutable by design (6.1.1).
      route: null,
      target: null,
      metadata: { groupId: id, event: 'GROUP_REMOVED' },
    });

    return this.findOne(adminId, id);
  }

  // ─── 1.7.6 Members, mute and invitations ───────────────────────────────────

  /** Members only: who is in a group is not public, even where what it says is. */
  async listMembers(
    viewerId: string,
    id: string,
    query: { skip: number; take: number; currentPage: number; perPage: number; q?: string },
  ): Promise<Paginated<GroupMemberView>> {
    await this.assertMember(viewerId, id);

    const where: Prisma.GroupMembershipWhereInput = {
      groupId: id,
      state: { in: [GroupMembershipState.MEMBER, GroupMembershipState.ADMIN] },
      ...(query.q
        ? {
            user: {
              OR: [
                { firstName: { contains: escapeLike(query.q), mode: 'insensitive' } },
                { lastName: { contains: escapeLike(query.q), mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.groupMembership.count({ where }),
      this.database.groupMembership.findMany({
        where,
        include: { user: { select: authorSelect } },
        // Admins first, then by how long they have been in it.
        orderBy: [{ isAdmin: 'desc' }, { joinedAt: 'asc' }],
        skip: query.skip,
        take: query.take,
      }),
    ]);

    return {
      data: rows.map(row => ({
        user: toAuthorView(row.user, { sign: this.media.sign }),
        role: row.isAdmin ? ('ADMIN' as const) : ('MEMBER' as const),
        joinedAt: row.joinedAt?.toISOString() ?? null,
      })),
      meta: buildPageMeta(query, total),
    };
  }

  /**
   * Per member, never for the group. Held on the thread's own participant row rather than on the
   * membership, so the group's switch and the chat's are the same switch: two would drift and a
   * member would mute a group and still be pushed.
   */
  async setMuted(userId: string, id: string, isMuted: boolean): Promise<GroupDetailView> {
    const group = await this.assertMember(userId, id);

    if (group.conversationId) {
      await this.database.conversationParticipant.updateMany({
        where: { conversationId: group.conversationId, userId },
        data: { isMuted },
      });
    }

    return this.findOne(userId, id);
  }

  /**
   * Who an admin can still invite: members of Circl not in the group and with nothing outstanding.
   * Somebody the admin removed before stays on this list, because an invitation is the only way
   * back in, and says so, so the admin knows who they are re-admitting.
   */
  async listInvitable(
    adminId: string,
    id: string,
    query: { skip: number; take: number; currentPage: number; perPage: number; q?: string },
  ): Promise<Paginated<{ user: AuthorView; wasRemoved: boolean }>> {
    await this.assertAdmin(adminId, id);

    const blockedIds = await this.blocking.blockedUserIds(adminId);
    const where: Prisma.UserWhereInput = {
      isAnonymised: false,
      isStaff: false,
      id: { notIn: [adminId, ...blockedIds] },
      // Not in it and not waiting. A removed member is neither, which is why they stay listed.
      groupMemberships: {
        none: {
          groupId: id,
          state: {
            in: [
              GroupMembershipState.MEMBER,
              GroupMembershipState.ADMIN,
              GroupMembershipState.PENDING,
            ],
          },
        },
      },
      groupInvites: { none: { groupId: id } },
      ...(query.q
        ? {
            OR: [
              { firstName: { contains: escapeLike(query.q), mode: 'insensitive' } },
              { lastName: { contains: escapeLike(query.q), mode: 'insensitive' } },
              { username: { contains: escapeLike(query.q), mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.user.count({ where }),
      this.database.user.findMany({
        where,
        select: {
          ...authorSelect,
          groupMemberships: {
            where: { groupId: id, state: GroupMembershipState.REMOVED },
            select: { state: true },
          },
        },
        orderBy: { firstName: 'asc' },
        skip: query.skip,
        take: query.take,
      }),
    ]);

    return {
      data: rows.map(row => ({
        user: toAuthorView(row, { sign: this.media.sign }),
        wasRemoved: row.groupMemberships.length > 0,
      })),
      meta: buildPageMeta(query, total),
    };
  }

  /** Several at once, and inviting somebody already invited is not an error. */
  async invite(adminId: string, id: string, dto: InviteMembersDto): Promise<GroupDetailView> {
    const group = await this.assertAdmin(adminId, id);

    const eligible = await this.database.user.findMany({
      where: {
        id: { in: dto.userIds },
        isAnonymised: false,
        groupMemberships: {
          none: {
            groupId: id,
            state: { in: [GroupMembershipState.MEMBER, GroupMembershipState.ADMIN] },
          },
        },
      },
      select: { id: true },
    });

    if (eligible.length) {
      await this.database.groupInvitation.createMany({
        data: eligible.map(user => ({ groupId: id, userId: user.id, invitedById: adminId })),
        skipDuplicates: true,
      });
    }

    const actor = await this.notifications.actorName(adminId);

    for (const user of eligible) {
      this.notifications.raise({
        userId: user.id,
        actorId: adminId,
        kind: NotificationKind.GROUP,
        categoryCode: 'GROUPS',
        title: `${actor} invited you to ${group.name}`,
        body: null,
        // The Groups screen, which is where the invitation is waiting.
        route: '/community/groups',
        target: { type: 'GROUP', id },
        metadata: { groupId: id, event: 'GROUP_INVITED' },
      });
    }

    return this.findOne(adminId, id);
  }

  /** Every invitation waiting on the caller, shown at the top of the Groups screen. */
  async myInvitations(userId: string): Promise<GroupInvitationView[]> {
    const rows = await this.database.groupInvitation.findMany({
      where: { userId, group: { deletedAt: null } },
      include: {
        group: { select: { id: true, name: true, avatarKey: true, memberCount: true } },
        invitedBy: { select: authorSelect },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return rows.map(row => ({
      id: row.id,
      group: {
        id: row.group.id,
        name: row.group.name,
        avatarUrl: row.group.avatarKey ? this.media.sign(row.group.avatarKey) : null,
        memberCount: row.group.memberCount,
      },
      invitedBy: toAuthorView(row.invitedBy, { sign: this.media.sign }),
      sentAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * The `{id}` is the group's, which is what every screen holds. Accepting goes through `join`,
   * so one path adds a member to the group and to its thread and there is nowhere for the two to
   * disagree.
   */
  async answerInvitation(
    userId: string,
    id: string,
    accept: boolean,
  ): Promise<GroupDetailView | null> {
    const invitation = await this.database.groupInvitation.findFirst({
      where: { userId, OR: [{ groupId: id }, { id }] },
      select: { id: true, groupId: true },
    });

    if (!invitation) throw ApiException.notFound('There is no invitation waiting for you here.');

    if (!accept) {
      await this.database.groupInvitation.delete({ where: { id: invitation.id } });

      return null;
    }

    await this.join(userId, invitation.groupId);

    return this.findOne(userId, invitation.groupId);
  }

  /**
   * Membership of a group and participation in its thread are one thing said twice, so they are
   * only ever written together.
   */
  private async addToThread(
    tx: Prisma.TransactionClient,
    conversationId: string | null,
    userIds: string[],
  ): Promise<void> {
    if (!conversationId || !userIds.length) return;

    await tx.conversationParticipant.createMany({
      data: userIds.map(userId => ({
        conversationId,
        userId,
        role: ParticipantRole.MEMBER,
      })),
      skipDuplicates: true,
    });
  }

  private async removeFromThread(
    tx: Prisma.TransactionClient,
    conversationId: string | null,
    userIds: string[],
  ): Promise<void> {
    if (!conversationId || !userIds.length) return;

    // Deleted rather than marked left: the messages API checks participation, so this is what
    // takes the thread out of their inbox and makes reading it a 403.
    await tx.conversationParticipant.deleteMany({
      where: { conversationId, userId: { in: userIds } },
    });
  }

  // ─── 1.7.5 Posts and replies ───────────────────────────────────────────────

  async listPosts(
    viewerId: string,
    id: string,
    query: { skip: number; take: number; currentPage: number; perPage: number },
  ): Promise<Paginated<GroupPostView> & { meta: { preview?: boolean } }> {
    const group = await this.load(id);

    const membership = await this.membershipOf(viewerId, id);
    const isMember = membership === 'MEMBER' || membership === 'ADMIN';

    // The whole point of a closed group: its name and rules are public, what it has said is not.
    // Without this the wall handed a non-member a preview of it and the full post count with it,
    // which made `visibility` a label on the payload rather than a rule.
    if (!isMember && group.visibility === GroupVisibility.CLOSED) {
      throw ApiException.forbidden(
        ApiErrorCode.NOT_A_MEMBER,
        'This group is for members only. Ask to join to read it.',
      );
    }

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

    const membership = await this.membershipOf(userId, groupId);

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
    const actor = await this.notifications.actorName(userId);

    this.notifications.raise({
      userId: post.authorId,
      actorId: userId,
      kind: NotificationKind.GROUP,
      categoryCode: 'GROUPS',
      title: `${actor} replied in your group post`,
      body: excerpt(dto.content, 80),
      // The wall is retired (2026-10-02) and there is no post screen to open, so this lands on
      // the group — the one thing that still exists — rather than on a route nothing resolves.
      // Only an app old enough to still have the wall can get here at all.
      route: `/community/group/${groupId}`,
      target: { type: 'GROUP', id: groupId },
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

    const membership = await this.membershipOf(userId, groupId);

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
    group: GroupRow,
    standing: Standing,
    labels: Map<string, string>,
    thread: ThreadFacts | undefined,
  ): GroupSummaryView {
    const isMember = standing.membership === 'MEMBER' || standing.membership === 'ADMIN';
    // A closed group's name, description, city, category, member count and rules are public.
    // What it has said is not, and neither is the fact that there is a thread to open.
    const hidden = group.visibility === GroupVisibility.CLOSED && !isMember;

    return {
      id: group.id,
      name: group.name,
      description: group.description,
      city: toCityView(group.city),
      category: toTermView(group.categoryCode, labels),
      rules: group.rules,
      // An integer, not "1.2k": the client cannot filter or sort a formatted string (0.6).
      memberCount: group.memberCount,
      joinPolicy: group.joinPolicy,
      visibility: group.visibility,
      isNew: group.createdAt >= daysAgo(NEW_GROUP_DAYS),
      avatarUrl: group.avatarKey ? this.media.sign(group.avatarKey) : null,
      createdBy: group.createdById,
      conversationId: hidden ? null : group.conversationId,
      lastMessageAt: hidden ? null : (thread?.lastMessageAt?.toISOString() ?? null),
      lastMessagePreview: hidden ? null : (thread?.preview ?? null),
      unreadCount: standing.unreadCount,
      messageCount: hidden ? null : (thread?.messageCount ?? 0),
      viewer: {
        // The single source of truth for whether the button reads Join, Pending or Leave.
        membership: standing.membership,
        canPost: isMember,
        canModerate: standing.membership === 'ADMIN',
        hasRequested: standing.membership === 'PENDING',
        wasRemoved: standing.wasRemoved,
        isInvited: standing.isInvited,
        isMuted: standing.isMuted,
        unreadPostCount: standing.unreadPostCount,
        isAdmin: standing.membership === 'ADMIN',
      },
      createdAt: group.createdAt.toISOString(),
    };
  }

  /**
   * Where the caller stands in each of these groups, in one pass. Every flag the client's button
   * is chosen from comes from here, so two of them cannot disagree: a member who is also
   * "removed", or an invitation that outlives the joining it led to, would each draw the wrong
   * button on a screen that only draws one.
   */
  private async standingFor(userId: string, groups: GroupRow[]): Promise<Map<string, Standing>> {
    const empty: Standing = {
      membership: 'NONE',
      wasRemoved: false,
      isInvited: false,
      isMuted: false,
      unreadCount: 0,
      unreadPostCount: 0,
    };

    if (!groups.length) return new Map();

    const groupIds = groups.map(group => group.id);
    const conversationIds = groups
      .map(group => group.conversationId)
      .filter((id): id is string => id !== null);

    const [memberships, invitations, participants] = await Promise.all([
      this.database.groupMembership.findMany({ where: { userId, groupId: { in: groupIds } } }),
      this.database.groupInvitation.findMany({
        where: { userId, groupId: { in: groupIds } },
        select: { groupId: true },
      }),
      conversationIds.length
        ? this.database.conversationParticipant.findMany({
            where: { userId, conversationId: { in: conversationIds } },
            select: { conversationId: true, unreadCount: true, isMuted: true },
          })
        : Promise.resolve<Array<{ conversationId: string; unreadCount: number; isMuted: boolean }>>(
            [],
          ),
    ]);

    const membershipById = new Map(memberships.map(row => [row.groupId, row] as const));
    const invited = new Set(invitations.map(row => row.groupId));
    const participantById = new Map(participants.map(row => [row.conversationId, row] as const));

    const unreadPosts = await this.unreadCounts(
      userId,
      groups,
      new Map(memberships.map(row => [row.groupId, this.stateToView(row)])),
    );

    return new Map(
      groups.map(group => {
        const row = membershipById.get(group.id);
        const participant = group.conversationId
          ? participantById.get(group.conversationId)
          : undefined;

        return [
          group.id,
          {
            ...empty,
            membership: row ? this.stateToView(row) : 'NONE',
            wasRemoved: row?.state === GroupMembershipState.REMOVED,
            isInvited: invited.has(group.id),
            isMuted: participant?.isMuted ?? false,
            unreadCount: participant?.unreadCount ?? 0,
            unreadPostCount: unreadPosts.get(group.id) ?? 0,
          },
        ];
      }),
    );
  }

  /** The last thing said in each thread, for the row's preview line. */
  private async threadFactsFor(groups: GroupRow[]): Promise<Map<string, ThreadFacts>> {
    const conversationIds = groups
      .map(group => group.conversationId)
      .filter((id): id is string => id !== null);

    if (!conversationIds.length) return new Map();

    const [conversations, lastMessages] = await Promise.all([
      this.database.conversation.findMany({
        where: { id: { in: conversationIds } },
        select: { id: true, lastMessageAt: true, messageCount: true },
      }),
      this.database.message.findMany({
        where: { conversationId: { in: conversationIds }, deletedAt: null },
        orderBy: { sentAt: 'desc' },
        distinct: ['conversationId'],
        select: { conversationId: true, body: true, kind: true },
      }),
    ]);

    const previews = new Map<string, string | null>(
      lastMessages.map(message => [
        message.conversationId,
        // Markers out: a one-line preview renders nothing, so `*ID*` would show the member the
        // asterisks. Media says what it is rather than coming back blank.
        message.body ? stripFormatting(message.body) : (MEDIA_PREVIEW[message.kind] ?? null),
      ]),
    );

    return new Map(
      conversations.map(conversation => [
        conversation.id,
        {
          lastMessageAt: conversation.lastMessageAt,
          messageCount: conversation.messageCount,
          preview: previews.get(conversation.id) ?? null,
        },
      ]),
    );
  }

  /** One lookup for the category labels every group row needs. */
  private categoryLabels(): Promise<Map<string, string>> {
    return this.taxonomy.labels(TaxonomyKind.COMMUNITY_CATEGORY);
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

    if (!rows.length) return new Map();

    // One grouped query rather than one count per group. Each group has its own threshold, which
    // is why this is an OR of pairs instead of a single range: a page of twenty groups was twenty
    // round trips on a list endpoint, for a number that is now the deprecated one of the two.
    const counts = await this.database.groupPost.groupBy({
      by: ['groupId'],
      where: {
        deletedAt: null,
        authorId: { not: userId },
        OR: rows.map(row => ({
          groupId: row.groupId,
          ...(row.lastReadAt ? { createdAt: { gt: row.lastReadAt } } : {}),
        })),
      },
      _count: { _all: true },
    });

    return new Map(counts.map(row => [row.groupId, row._count._all] as const));
  }

  private async load(id: string): Promise<Group> {
    const group = await this.database.group.findUnique({ where: { id } });

    if (!group) throw ApiException.notFound('This group could not be found.');
    if (group.deletedAt) throw ApiException.deleted('This group');

    return group;
  }

  private async assertMember(userId: string, groupId: string): Promise<Group> {
    const group = await this.load(groupId);
    const membership = await this.membershipOf(userId, groupId);

    if (membership !== 'MEMBER' && membership !== 'ADMIN') {
      throw ApiException.forbidden(
        ApiErrorCode.NOT_A_MEMBER,
        'Join this group to take part in it.',
      );
    }

    return group;
  }

  private async assertAdmin(userId: string, groupId: string): Promise<Group> {
    const group = await this.load(groupId);
    const membership = await this.membershipOf(userId, groupId);

    if (membership !== 'ADMIN') {
      throw ApiException.forbidden(ApiErrorCode.NOT_ADMIN, 'Only a group admin can do that.');
    }

    return group;
  }

  private async membershipOf(userId: string, groupId: string): Promise<MembershipView> {
    const row = await this.database.groupMembership.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });

    return row ? this.stateToView(row) : 'NONE';
  }
}
