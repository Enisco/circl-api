import { Injectable } from '@nestjs/common';

/**
 * Who has a live socket right now.
 *
 * It lives here rather than inside the gateway because two different things need it and they
 * cannot both depend on the gateway: the gateway *writes* it on connect and disconnect, and the
 * conversation and presence services *read* it to answer over REST. A map on the gateway meant
 * `isOnline` was hardcoded `false` everywhere outside the socket, which is worse than not
 * answering at all.
 *
 * **This is per process.** Socket.IO is running on the plain in-memory adapter, so a member
 * connected to one instance is invisible to another. That is correct today, when there is one
 * process, and it is the first thing to fix before running two: `@socket.io/redis-adapter` plus a
 * shared registry, not a bigger map.
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
