import { Injectable } from '@nestjs/common';
import {
  Conversation,
  MessageKind,
  ParticipantRole,
  Prisma,
  SupportThreadType,
  SystemMessageType,
  ThreadContextType,
  ThreadKind,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '@/infrastructure';
import { toJsonOrUndefined } from '@/common';
import { settledType, typeFromContext } from './support-thread.rules';

export interface ContextSnapshot {
  title: string;
  subtitle?: string | null;
  // / An object key, not a URL.
  thumbnailKey?: string | null;
  trailing?: string | null;
  route?: string | null;
  /**
   * What the conversation is about, where it started from one particular thing — a Connect photo
   * or a prompt answer (3.5). Keys rather than URLs, because a snapshot outlives a signature.
   */
  about?: {
    kind: 'MEDIA' | 'PROMPT';
    id: string;
    thumbnailKey?: string | null;
    question?: string;
    answer?: string;
  } | null;
}

export interface EnsureConversationInput {
  kind: ThreadKind;
  participantIds: string[];
  /**
   * Overrides the sorted-pair key. A group's thread is the one whose membership changes, so its
   * key has to be the group rather than whoever happened to be in it when it was created.
   */
  participantKey?: string;
  contextType?: ThreadContextType | null;
  contextId?: string | null;
  snapshot?: ContextSnapshot | null;
  isPinned?: boolean;
  staffIds?: string[];
  /**
   * What the support thread is about, for `kind: SUPPORT`.
   *
   * Passed rather than derived because `GUARD` and `DEAL_PROBLEM` both arrive as
   * `contextType: SUPPORT` with a null context id — the same conversation key — so the context
   * cannot tell them apart. The caller that knows says so, and `settledType` makes sure a Guard
   * thread is never relabelled as anything else. See `support-thread.rules.ts`.
   */
  supportType?: SupportThreadType;
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
    const participantKey =
      input.participantKey ?? ConversationFactoryService.participantKey(input.participantIds);
    const contextType = input.contextType ?? null;
    const contextId = input.contextId ?? null;

    const existing = await client.conversation.findFirst({
      where: { participantKey, contextType, contextId },
    });

    if (existing) {
      // A second thing claiming a conversation that already exists — which for support threads is
      // the ordinary case, not an edge: a member's Guard disclosure and their deal problem share
      // one key by design (D36).
      if (input.kind === ThreadKind.SUPPORT) {
        await this.ensureSupportThread(client, existing.id, input, contextType);
      }

      return { conversation: existing, created: false };
    }

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

    if (input.kind === ThreadKind.SUPPORT) {
      await this.ensureSupportThread(client, conversation.id, input, contextType);
    }

    return { conversation, created: true };
  }

  /**
   * The staff row for a support conversation (§4.8).
   *
   * Written here rather than by each of the four services that open support threads, because a
   * conversation without one is invisible to the inbox — and the thread that goes missing is the
   * one somebody forgot to add the call to.
   *
   * On a conversation that already has a row this only ever **settles the type**, and in
   * particular only ever raises it to `GUARD`. Nothing else is touched: `state`, the assignee and
   * every timestamp belong to the thread's own life and would be reset by a second `ensure` call
   * for an unrelated reason.
   */
  private async ensureSupportThread(
    client: Prisma.TransactionClient | PrismaService,
    conversationId: string,
    input: EnsureConversationInput,
    contextType: ThreadContextType | null,
  ): Promise<void> {
    const memberId = input.participantIds[0];

    // No member, no thread. A support conversation always has exactly one; a row keyed on an
    // undefined member would fail the foreign key and take the whole creation down with it.
    if (!memberId) return;

    const claimed = input.supportType ?? typeFromContext(contextType);
    const existing = await client.supportThread.findUnique({
      where: { conversationId },
      select: { type: true },
    });
    const type = settledType(existing?.type ?? null, claimed);

    if (existing) {
      if (existing.type === type) return;

      await client.supportThread.update({ where: { conversationId }, data: { type } });

      return;
    }

    await client.supportThread.create({ data: { conversationId, memberId, type, tags: [] } });
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

  /**
   * There is deliberately no `staffUserIds()` any more (B17).
   *
   * Every support thread used to be created with **every** staff account as a participant — up to
   * 25 rows per thread, every role, nobody having chosen to be there. Three things were wrong with
   * it, and the third is why it could not be fixed until now:
   *
   *  - The member's own inbox drew one of them as the counterpart. `counterpart()` takes the first
   *    non-member participant, so the header of a support thread showed a staff account's name,
   *    avatar, online status and last-seen time — picked by row order.
   *  - A member's message raised a delivery receipt and an unread count for all 25, and pushed to
   *    any device those accounts had.
   *  - It was the only way staff could see the thread at all, so it could not be removed before
   *    §5.15's inbox existed. The inbox reads through `pageWithoutAuthorisation` and counts unread
   *    on `SupportThread` itself, so the participant rows are no longer carrying anything.
   *
   * Staff now join a thread by **acting** on it: the replier is added on reply and the assignee on
   * assignment, both through `addStaff` above. A participant row therefore means "this person has
   * done something here", which is what the member's inbox was already reading it as.
   */
}
