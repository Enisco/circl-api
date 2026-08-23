import { Injectable } from '@nestjs/common';
import {
  ConnectionRequestState,
  DmPolicy,
  Prisma,
  SystemMessageType,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { addDays, ApiErrorCode, ApiException, buildPageMeta } from '@/common';
import { BlockingService } from '../../shared';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';
import {
  CreateConnectionRequestDto,
  DeclineRequestDto,
  ListConnectionRequestsDto,
} from '../dtos/connect.dto';
import { ConnectProfileService } from './connect-profile.service';

/** A declined pair may not be re-requested for 30 days (3.5.3). */
const DECLINE_COOLDOWN_DAYS = 30;

/** Rate limited harder than other creates: volume requesting is the failure mode. */
const DAILY_REQUEST_LIMIT = 20;

@Injectable()
export class ConnectionRequestService {
  constructor(
    private readonly database: PrismaService,
    private readonly profiles: ConnectProfileService,
    private readonly blocking: BlockingService,
    private readonly conversations: ConversationFactoryService,
  ) {}

  // ─── 3.5.1 Create ──────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateConnectionRequestDto) {
    const own = await this.profiles.requireOwn(userId);
    const target = await this.profiles.findByIdOrUserId(dto.toProfileId);

    if (!target || !target.isVisible) {
      throw ApiException.notFound('That profile could not be found.');
    }

    if (target.userId === userId) {
      throw ApiException.unprocessable(
        ApiErrorCode.CANNOT_CONNECT_WITH_YOURSELF,
        'You cannot send yourself a connection request.',
      );
    }

    // Phrased identically to a plain "not available", so a block is never
    // distinguishable from an absent profile (3.5.1).
    if (await this.blocking.isBlockedEitherWay(userId, target.userId)) {
      throw ApiException.notFound('That profile could not be found.');
    }

    // Sending a request to an open inbox is a wasted step, so the response hands
    // the client the thread instead of an error it has to interpret.
    if (target.dmPolicy === DmPolicy.OPEN) {
      const { conversation } = await this.conversations.ensure({
        kind: ThreadKind.CONNECT,
        participantIds: [userId, target.userId],
        contextType: ThreadContextType.CONNECT_PROFILE,
        contextId: target.id,
        snapshot: { title: target.lookingFor.slice(0, 60), route: `/connect/profile/${target.id}` },
      });

      throw ApiException.unprocessable(
        ApiErrorCode.DIRECT_MESSAGE_ALLOWED,
        'This member has an open inbox — you can message them directly.',
        { data: { conversationId: conversation.id } },
      );
    }

    const existing = await this.database.connectionRequest.findFirst({
      where: {
        state: ConnectionRequestState.PENDING,
        OR: [
          { fromUserId: userId, toUserId: target.userId },
          { fromUserId: target.userId, toUserId: userId },
        ],
      },
    });

    if (existing) {
      throw ApiException.conflict(
        ApiErrorCode.REQUEST_ALREADY_EXISTS,
        existing.fromUserId === userId
          ? 'You have already sent this member a request.'
          : 'This member has already sent you a request.',
        {
          data: {
            request: {
              id: existing.id,
              state: existing.state,
              direction: existing.fromUserId === userId ? 'SENT' : 'RECEIVED',
            },
          },
        },
      );
    }

    // Repeated requesting after a decline is harassment with extra steps (3.5.3).
    const declined = await this.database.connectionRequest.findFirst({
      where: {
        fromUserId: userId,
        toUserId: target.userId,
        state: ConnectionRequestState.DECLINED,
        cooldownUntil: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (declined?.cooldownUntil) {
      const retryAfterDays = Math.ceil(
        (declined.cooldownUntil.getTime() - Date.now()) / 86_400_000,
      );

      throw ApiException.rateLimited(
        ApiErrorCode.REQUEST_COOLDOWN,
        'You cannot send this member another request right now.',
        { data: { retryAfterDays } },
      );
    }

    const sentToday = await this.database.connectionRequest.count({
      where: { fromUserId: userId, createdAt: { gte: addDays(new Date(), -1) } },
    });

    if (sentToday >= DAILY_REQUEST_LIMIT) {
      throw ApiException.rateLimited(
        ApiErrorCode.RATE_LIMITED,
        `You can send up to ${DAILY_REQUEST_LIMIT} connection requests a day.`,
        { data: { retryAfterDays: 1 } },
      );
    }

    const request = await this.database.connectionRequest.create({
      data: {
        fromProfileId: own.id,
        toProfileId: target.id,
        fromUserId: userId,
        toUserId: target.userId,
        note: dto.note ?? null,
      },
    });

    // Creates a notification for the recipient. Does NOT create a conversation
    // yet — that happens on accept (3.5.1).
    return {
      id: request.id,
      state: request.state,
      direction: 'SENT' as const,
      note: request.note,
      createdAt: request.createdAt.toISOString(),
    };
  }

  // ─── 3.5.2 List ────────────────────────────────────────────────────────────

  async list(userId: string, query: ListConnectionRequestsDto) {
    const own = await this.profiles.requireOwn(userId);
    const direction = query.direction ?? 'RECEIVED';
    const state = query.state ?? 'PENDING';

    const where: Prisma.ConnectionRequestWhereInput = {
      ...(direction === 'RECEIVED' ? { toProfileId: own.id } : { fromProfileId: own.id }),
      ...(state === 'ALL' ? {} : { state: state as ConnectionRequestState }),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.connectionRequest.count({ where }),
      this.database.connectionRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
    ]);

    const otherProfileIds = rows.map(row =>
      direction === 'RECEIVED' ? row.fromProfileId : row.toProfileId,
    );
    const profiles = await Promise.all(
      otherProfileIds.map(id => this.profiles.findByIdOrUserId(id)),
    );
    const views = await Promise.all(
      profiles.map(profile => (profile ? this.profiles.toView(profile) : null)),
    );
    const byId = new Map(
      profiles.map((profile, index) => [profile?.id ?? `missing-${index}`, views[index]] as const),
    );

    return {
      data: rows.map((row, index) => ({
        id: row.id,
        direction,
        state: row.state,
        note: row.note,
        profile: byId.get(otherProfileIds[index]) ?? null,
        conversationId: row.conversationId,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: buildPageMeta(query, total),
    };
  }

  // ─── 3.5.3 Acting on a request ─────────────────────────────────────────────

  /** Accept creates the conversation and returns its id, so the client opens the
   *  chat straight away instead of guessing a thread (3.5.3). */
  async accept(userId: string, id: string) {
    const { request, own } = await this.loadForRecipient(userId, id);
    const target = await this.profiles.findByIdOrUserId(request.fromProfileId);

    const conversationId = await this.database.$transaction(async tx => {
      const { conversation } = await this.conversations.ensure(
        {
          kind: ThreadKind.CONNECT,
          participantIds: [request.fromUserId, request.toUserId],
          contextType: ThreadContextType.CONNECT_PROFILE,
          contextId: own.id,
          snapshot: {
            title: target?.lookingFor.slice(0, 60) ?? 'Connection',
            route: `/connect/profile/${request.fromProfileId}`,
          },
        },
        tx,
      );

      await tx.connectionRequest.update({
        where: { id },
        data: {
          state: ConnectionRequestState.ACCEPTED,
          respondedAt: new Date(),
          conversationId: conversation.id,
        },
      });

      await this.conversations.postSystemMessage(
        conversation.id,
        SystemMessageType.CONNECTION_ACCEPTED,
        'You are now connected. Take care sharing personal details with someone new.',
        { requestId: id },
        tx,
      );

      return conversation.id;
    });

    return { id, state: ConnectionRequestState.ACCEPTED, conversationId };
  }

  /**
   * Decline is silent: the sender is not notified, and their view shows the
   * request as no longer pending without saying why (3.5.3).
   */
  async decline(userId: string, id: string, dto: DeclineRequestDto) {
    const { request } = await this.loadForRecipient(userId, id);

    await this.database.$transaction(async tx => {
      await tx.connectionRequest.update({
        where: { id },
        data: {
          state: ConnectionRequestState.DECLINED,
          respondedAt: new Date(),
          cooldownUntil: addDays(new Date(), DECLINE_COOLDOWN_DAYS),
        },
      });

      // The decline sheet's second option, applied in the same transaction.
      if (dto.alsoBlock) {
        await tx.block.upsert({
          where: { blockerId_blockedId: { blockerId: userId, blockedId: request.fromUserId } },
          update: {},
          create: { blockerId: userId, blockedId: request.fromUserId },
        });
      }
    });

    return { id, state: ConnectionRequestState.DECLINED };
  }

  async cancel(userId: string, id: string) {
    const own = await this.profiles.requireOwn(userId);
    const request = await this.database.connectionRequest.findUnique({ where: { id } });

    if (!request || request.fromProfileId !== own.id) {
      throw ApiException.notFound('That request could not be found.');
    }

    if (request.state !== ConnectionRequestState.PENDING) {
      throw ApiException.conflict(
        ApiErrorCode.CONFLICT,
        'That request is no longer pending.',
        { data: { state: request.state } },
      );
    }

    await this.database.connectionRequest.update({
      where: { id },
      data: { state: ConnectionRequestState.CANCELLED, respondedAt: new Date() },
    });

    return { id, state: ConnectionRequestState.CANCELLED };
  }

  private async loadForRecipient(userId: string, id: string) {
    const own = await this.profiles.requireOwn(userId);
    const request = await this.database.connectionRequest.findUnique({ where: { id } });

    if (!request || request.toProfileId !== own.id) {
      throw ApiException.notFound('That request could not be found.');
    }

    if (request.state !== ConnectionRequestState.PENDING) {
      throw ApiException.conflict(
        ApiErrorCode.CONFLICT,
        'That request is no longer pending.',
        { data: { state: request.state } },
      );
    }

    return { request, own };
  }
}
