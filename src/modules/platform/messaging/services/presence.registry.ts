import { Injectable } from '@nestjs/common';

/**
 * Who has a live socket right now: the gateway writes it, the REST services read it. Per process,
 * so a second instance needs `@socket.io/redis-adapter` and a shared registry.
 */
@Injectable()
export class PresenceRegistry {
  private readonly sockets = new Map<string, Set<string>>();

  /** `userId -> socketId -> the conversation that socket has on screen`, when the client says so. */
  private readonly viewing = new Map<string, Map<string, string>>();

  /** Returns true when this socket is the one that brought the member online. */
  add(userId: string, socketId: string): boolean {
    const existing = this.sockets.get(userId);

    if (existing) {
      existing.add(socketId);

      return false;
    }

    this.sockets.set(userId, new Set([socketId]));

    return true;
  }

  /** Returns true when this socket was the last one, so the member is now offline. */
  remove(userId: string, socketId: string): boolean {
    const existing = this.sockets.get(userId);

    if (!existing) return false;

    existing.delete(socketId);
    this.closeThread(userId, socketId);

    if (existing.size) return false;

    this.sockets.delete(userId);

    return true;
  }

  /** The thread this socket has on screen, which is the one thing that suppresses a push (5.6). */
  openThread(userId: string, socketId: string, conversationId: string): void {
    const existing = this.viewing.get(userId);

    if (existing) {
      existing.set(socketId, conversationId);

      return;
    }

    this.viewing.set(userId, new Map([[socketId, conversationId]]));
  }

  closeThread(userId: string, socketId: string): void {
    const existing = this.viewing.get(userId);

    if (!existing) return;

    existing.delete(socketId);

    if (!existing.size) this.viewing.delete(userId);
  }

  /** True only when one of the member's devices is on this thread right now. */
  isViewing(userId: string, conversationId: string): boolean {
    const open = this.viewing.get(userId);

    return open ? [...open.values()].includes(conversationId) : false;
  }

  isOnline(userId: string): boolean {
    return this.sockets.has(userId);
  }

  /** The online subset of a list, for answering about many members in one pass. */
  onlineAmong(userIds: string[]): Set<string> {
    return new Set(userIds.filter(userId => this.sockets.has(userId)));
  }
}
