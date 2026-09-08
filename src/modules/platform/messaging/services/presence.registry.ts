import { Injectable } from '@nestjs/common';

/**
 * Who has a live socket right now: the gateway writes it, the REST services read it. Per process,
 * so a second instance needs `@socket.io/redis-adapter` and a shared registry.
 */
@Injectable()
export class PresenceRegistry {
  private readonly sockets = new Map<string, Set<string>>();

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

    if (existing.size) return false;

    this.sockets.delete(userId);

    return true;
  }

  isOnline(userId: string): boolean {
    return this.sockets.has(userId);
  }

  /** The online subset of a list, for answering about many members in one pass. */
  onlineAmong(userIds: string[]): Set<string> {
    return new Set(userIds.filter(userId => this.sockets.has(userId)));
  }
}
