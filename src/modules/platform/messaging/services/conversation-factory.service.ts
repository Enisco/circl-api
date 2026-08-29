import { Injectable } from '@nestjs/common';
import {
  Conversation,
  MessageKind,
  ParticipantRole,
  Prisma,
  SystemMessageType,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '@/infrastructure';
import { toJsonOrUndefined } from '@/common';

export interface ContextSnapshot {
  title: string;
  subtitle?: string | null;
  // / An object key, not a URL.
  thumbnailKey?: string | null;
  trailing?: string | null;
  route?: string | null;
}

export interface EnsureConversationInput {
  kind: ThreadKind;
  participantIds: string[];
  contextType?: ThreadContextType | null;
  contextId?: string | null;
  snapshot?: ContextSnapshot | null;
  isPinned?: boolean;
  staffIds?: string[];
}

/** Creates and finds conversations for the sections that own a subject. */
@Injectable()
export class ConversationFactoryService {
  constructor(private readonly database: PrismaService) {}

  /** The sorted participant pair, joined. Sorted so (a,b) and (b,a) are one key. */
  static participantKey(userIds: string[]): string {
    return [...new Set(userIds)].sort().join('|');
  }

  /** Finds the matching thread or creates it. */
  async ensure(
    input: EnsureConversationInput,
    tx?: Prisma.TransactionClient,
  ): Promise<{ conversation: Conversation; created: boolean }> {
    const client = tx ?? this.database;
    const participantKey = ConversationFactoryService.participantKey(input.participantIds);
    const contextType = input.contextType ?? null;
    const contextId = input.contextId ?? null;

    const existing = await client.conversation.findFirst({
      where: { participantKey, contextType, contextId },
    });

    if (existing) return { conversation: existing, created: false };

    const conversation = await client.conversation.create({
      data: {
        kind: input.kind,
        contextType,
        contextId,
        contextSnapshot: toJsonOrUndefined(input.snapshot),
        participantKey,
        // Pinning is server-side, not a client sort, because the support thread must be first for everyone (5.3.1).
        isPinned: input.isPinned ?? false,
        participants: {
          create: [
            ...input.participantIds.map(userId => ({ userId, role: ParticipantRole.MEMBER })),
            ...(input.staffIds ?? []).map(userId => ({ userId, role: ParticipantRole.STAFF })),
          ],
        },
      },
    });

    return { conversation, created: true };
  }

  /** Posts a system message into a thread. */
  async postSystemMessage(
    conversationId: string,
    systemType: SystemMessageType,
    body: string,
    data?: Record<string, unknown>,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.database;

    await client.message.create({
      data: {
        conversationId,
        senderId: null,
        kind: MessageKind.SYSTEM,
        body,
        systemType,
        systemData: toJsonOrUndefined(data),
        clientId: randomUUID(),
      },
    });

    await client.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date(), messageCount: { increment: 1 } },
    });

    // A system message is not "unread" in the sense a person's message is — it is the app narrating something the member just did or was just told about elsewhere.
  }

  /** Refreshes the display snapshot when the underlying record changes, so the inbox does not drift for months (5.1). */
  async refreshSnapshot(
    contextType: ThreadContextType,
    contextId: string,
    snapshot: ContextSnapshot,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.database;

    await client.conversation.updateMany({
      where: { contextType, contextId },
      data: { contextSnapshot: toJsonOrUndefined(snapshot) },
    });
  }

  /** Adds Circl staff to an existing thread, which is the one multi-party case (D29). */
  async addStaff(conversationId: string, staffIds: string[], tx?: Prisma.TransactionClient) {
    const client = tx ?? this.database;

    if (!staffIds.length) return;

    await client.conversationParticipant.createMany({
      data: staffIds.map(userId => ({ conversationId, userId, role: ParticipantRole.STAFF })),
      skipDuplicates: true,
    });
  }

  /** Every staff account, for the threads Circl's team has to be in. */
  async staffUserIds(): Promise<string[]> {
    const staff = await this.database.user.findMany({
      where: { isStaff: true, isAnonymised: false },
      select: { id: true },
      take: 25,
    });

    return staff.map(user => user.id);
  }
}
