import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '@/infrastructure';
import { ConversationService } from '../services/conversation.service';
import { MessageService } from '../services/message.service';
import { MessagePushService } from '../services/message-push.service';
import { SendMessageDto } from '../dtos/message.dto';

interface AuthedSocket extends Socket {
  data: { userId?: string };
}

/** Close code for an invalid or expired token, which the client treats like a 401. */
const CLOSE_UNAUTHORISED = 4401;

/** A typing state expires after 5 seconds without a refresh (5.2.2). */
const TYPING_TTL_MS = 5000;

/** 5.7: 60 messages a minute and 300 an hour, per member. */
const SEND_LIMITS = [
  { windowMs: 60_000, max: 60 },
  { windowMs: 3_600_000, max: 300 },
];

/** The live half of messaging (5.2). */
@WebSocketGateway({
  namespace: '/ws/chat',
  cors: { origin: true, credentials: true },
  pingInterval: 30_000,
  pingTimeout: 60_000,
})
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  /** Live socket count per user, which is what makes presence and push honest. */
  private readonly connections = new Map<string, Set<string>>();

  private readonly typingTimers = new Map<string, NodeJS.Timeout>();

  /** Send timestamps per member, trimmed to the longest window on each check. */
  private readonly sendHistory = new Map<string, number[]>();

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly database: PrismaService,
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
    private readonly push: MessagePushService,
  ) {}

  // ─── 5.2.1 Connection ──────────────────────────────────────────────────────

  /** Authentication runs as connection middleware rather than inside `handleConnection`, and the difference is load-bearing. */
  afterInit(server: Server) {
    server.use((socket, next) => {
      void this.authenticate(socket as AuthedSocket)
        .then(() => next())
        .catch(() => {
          const error = new Error('Unauthorised') as Error & { data?: unknown };

          // The close code the spec names, so the client treats it exactly like a 401: refresh once, then reconnect.
          error.data = { code: CLOSE_UNAUTHORISED };
          next(error);
        });
    });
  }

  private async authenticate(socket: AuthedSocket): Promise<void> {
    const token = this.tokenFrom(socket);

    if (!token) throw new Error('No token');

    const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });

    const user = await this.database.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, status: true, isAnonymised: true },
    });

    if (!user || user.isAnonymised || user.status === 'SUSPENDED') {
      throw new Error('Not permitted');
    }

    socket.data.userId = user.id;
  }

  async handleConnection(socket: AuthedSocket) {
    const userId = socket.data.userId;

    // Unreachable in practice: the middleware above rejects first.
    if (!userId) return this.reject(socket);

    await socket.join(this.roomFor(userId));

    const sockets = this.connections.get(userId) ?? new Set();

    sockets.add(socket.id);
    this.connections.set(userId, sockets);

    // The badge is in four section headers, so it is sent on connect rather than waiting for the first message to make it correct.
    socket.emit('unread.total', await this.conversations.unreadTotal(userId));
    this.broadcastPresence(userId, true);
  }

  handleDisconnect(socket: AuthedSocket) {
    const userId = socket.data.userId;

    if (!userId) return;

    const sockets = this.connections.get(userId);

    sockets?.delete(socket.id);

    if (!sockets?.size) {
      this.connections.delete(userId);
      // Send history goes with the last socket: it is a burst guard, not a durable quota, and holding it for every member who ever connected is an unbounded map on a long-running process.
      this.sendHistory.delete(userId);
      this.broadcastPresence(userId, false);
    }
  }

  // ─── 5.2.2 Client to server ────────────────────────────────────────────────

  @SubscribeMessage('message.send')
  async onSend(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() payload: SendMessageDto & { conversationId: string },
  ) {
    const userId = socket.data.userId;

    if (!userId) return this.reject(socket);

    const retryAfter = this.sendAllowance(userId);

    if (retryAfter !== null) {
      socket.emit('message.status', {
        conversationId: payload.conversationId,
        clientId: payload.clientId,
        status: 'FAILED',
        error: 'RATE_LIMITED',
        retryAfterSeconds: retryAfter,
        message: 'You are sending messages too quickly.',
      });

      return;
    }

    try {
      const message = await this.messages.send(userId, payload.conversationId, payload);

      // The acknowledgement echoes clientId, so the pending bubble is replaced rather than duplicated (5.2.2).
      socket.emit('message.ack', {
        conversationId: payload.conversationId,
        clientId: payload.clientId,
        message,
      });

      const recipients = await this.recipientsOf(payload.conversationId, userId);

      for (const recipient of recipients) {
        this.server
          .to(this.roomFor(recipient))
          .emit('message.new', { conversationId: payload.conversationId, message });

        void this.pushUnread(recipient);
      }

      // Anyone with a live socket has it on their device, which is what DELIVERED means (5.4).
      const connected = recipients.filter(id => this.connections.has(id));
      const offline = recipients.filter(id => !this.connections.has(id));

      if (offline.length) {
        this.push.notify({
          conversationId: payload.conversationId,
          messageId: message.id,
          senderId: userId,
          recipientIds: offline,
        });
      }

      if (connected.length) {
        await Promise.all(connected.map(id => this.messages.markDelivered(id, [message.id])));

        this.server.to(this.roomFor(userId)).emit('message.status', {
          conversationId: payload.conversationId,
          messageId: message.id,
          status: 'DELIVERED',
        });
      }
    } catch (error) {
      // The store never invents a delivery state, so a failure has to come back as one rather than leaving a bubble spinning forever (5.2.4).
      socket.emit('message.status', {
        conversationId: payload.conversationId,
        clientId: payload.clientId,
        status: 'FAILED',
        error: (error as { code?: string }).code ?? 'SEND_FAILED',
        message: (error as Error).message,
      });
    }
  }

  @SubscribeMessage('message.read')
  async onRead(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() payload: { conversationId: string; lastReadMessageId: string },
  ) {
    const userId = socket.data.userId;

    if (!userId) return this.reject(socket);

    const result = await this.messages
      .markRead(userId, payload.conversationId, payload.lastReadMessageId)
      .catch(() => null);

    if (!result) return;

    const recipients = await this.recipientsOf(payload.conversationId, userId);

    for (const recipient of recipients) {
      this.server.to(this.roomFor(recipient)).emit('message.read', {
        conversationId: payload.conversationId,
        userId,
        lastReadMessageId: result.lastReadMessageId,
        readAt: result.readAt,
      });
    }

    void this.pushUnread(userId);
  }

  @SubscribeMessage('typing.start')
  async onTypingStart(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() payload: { conversationId: string },
  ) {
    await this.emitTyping(socket, payload.conversationId, true);
  }

  @SubscribeMessage('typing.stop')
  async onTypingStop(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() payload: { conversationId: string },
  ) {
    await this.emitTyping(socket, payload.conversationId, false);
  }

  /** Resume after a reconnect (5.2.1). */
  @SubscribeMessage('sync')
  async onSync(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() payload: { cursors: Array<{ conversationId: string; lastMessageId: string }> },
  ) {
    const userId = socket.data.userId;

    if (!userId) return this.reject(socket);

    for (const cursor of payload.cursors ?? []) {
      const missed = await this.messages
        .history(userId, cursor.conversationId, { after: cursor.lastMessageId, limit: 100 })
        .catch(() => null);

      if (!missed?.data.length) continue;

      for (const message of missed.data) {
        socket.emit('message.new', { conversationId: cursor.conversationId, message });
      }

      await this.messages.markDelivered(
        userId,
        missed.data.filter(message => !message.isMine).map(message => message.id),
      );
    }

    socket.emit('unread.total', await this.conversations.unreadTotal(userId));
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async emitTyping(socket: AuthedSocket, conversationId: string, isTyping: boolean) {
    const userId = socket.data.userId;

    if (!userId) return;

    const conversation = await this.database.conversation.findUnique({
      where: { id: conversationId },
      select: { kind: true, participants: { select: { userId: true } } },
    });

    if (!conversation) return;
    if (!conversation.participants.some(participant => participant.userId === userId)) return;

    // D28: no typing events on SUPPORT threads.
    if (conversation.kind === 'SUPPORT') return;

    const key = `${conversationId}:${userId}`;
    const existing = this.typingTimers.get(key);

    if (existing) clearTimeout(existing);

    for (const participant of conversation.participants) {
      if (participant.userId === userId) continue;

      this.server
        .to(this.roomFor(participant.userId))
        .emit('typing', { conversationId, userId, isTyping });
    }

    if (!isTyping) {
      this.typingTimers.delete(key);

      return;
    }

    // The server expires a typing state rather than trusting a `typing.stop` that a dropped connection will never send.
    this.typingTimers.set(
      key,
      setTimeout(() => {
        this.typingTimers.delete(key);

        for (const participant of conversation.participants) {
          if (participant.userId === userId) continue;

          this.server
            .to(this.roomFor(participant.userId))
            .emit('typing', { conversationId, userId, isTyping: false });
        }
      }, TYPING_TTL_MS),
    );
  }

  /** Returns null when the send is allowed, or the seconds to wait when it is not. */
  private sendAllowance(userId: string): number | null {
    const now = Date.now();
    const longest = Math.max(...SEND_LIMITS.map(limit => limit.windowMs));
    const history = (this.sendHistory.get(userId) ?? []).filter(at => now - at < longest);

    for (const limit of SEND_LIMITS) {
      const inWindow = history.filter(at => now - at < limit.windowMs);

      if (inWindow.length >= limit.max) {
        this.sendHistory.set(userId, history);

        return Math.ceil((limit.windowMs - (now - inWindow[0])) / 1000);
      }
    }

    history.push(now);
    this.sendHistory.set(userId, history);

    return null;
  }

  private async recipientsOf(conversationId: string, senderId: string): Promise<string[]> {
    const participants = await this.database.conversationParticipant.findMany({
      where: { conversationId, userId: { not: senderId } },
      select: { userId: true },
    });

    return participants.map(participant => participant.userId);
  }

  /**
   * Tells one member their view of a thread changed (5.2.3).
   *
   * Muting, archiving and a refreshed context snapshot all change the inbox row
   * without producing a message, so nothing else would push it.
   */
  async pushConversationUpdated(userId: string, conversationId: string): Promise<void> {
    if (!this.connections.has(userId)) return;

    const conversation = await this.conversations
      .findOne(userId, conversationId)
      .catch(() => null);

    if (!conversation) return;

    this.server.to(this.roomFor(userId)).emit('conversation.updated', { conversation });
  }

  private async pushUnread(userId: string) {
    if (!this.connections.has(userId)) return;

    this.server
      .to(this.roomFor(userId))
      .emit('unread.total', await this.conversations.unreadTotal(userId));
  }

  private broadcastPresence(userId: string, isOnline: boolean) {
    void this.database.conversationParticipant
      .findMany({
        where: { userId },
        select: { conversation: { select: { participants: { select: { userId: true } } } } },
      })
      .then(rows => {
        const seen = new Set<string>();

        for (const row of rows) {
          for (const participant of row.conversation.participants) {
            if (participant.userId === userId || seen.has(participant.userId)) continue;

            seen.add(participant.userId);
            this.server.to(this.roomFor(participant.userId)).emit('presence', {
              userId,
              isOnline,
              lastSeenAt: new Date().toISOString(),
            });
          }
        }
      })
      .catch(() => undefined);
  }

  /** Whether this member has a live socket, which is what decides socket vs push. */
  isConnected(userId: string): boolean {
    return this.connections.has(userId);
  }

  private roomFor(userId: string): string {
    return `user:${userId}`;
  }

  /** Prefer the Authorization header; the query parameter is the documented fallback for clients that cannot set one on the handshake — and it must never be logged (5.2.1). */
  private tokenFrom(socket: Socket): string | null {
    const header = socket.handshake.headers.authorization;

    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7);
    }

    const auth = socket.handshake.auth?.token;

    if (typeof auth === 'string' && auth) return auth;

    const query = socket.handshake.query?.token;

    return typeof query === 'string' && query ? query : null;
  }

  private reject(socket: Socket) {
    // Closed rather than silently dropped, so the client refreshes and reconnects once instead of losing messages quietly (5.2.1).
    socket.emit('error', { code: CLOSE_UNAUTHORISED, message: 'Unauthorised' });
    socket.disconnect(true);
    this.logger.debug(`Rejected socket ${socket.id}: unauthorised`);
  }
}
