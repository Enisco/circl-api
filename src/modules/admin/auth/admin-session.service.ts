import { Injectable } from '@nestjs/common';
import { AdminSession, AdminSessionRevokeReason, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { CacheService, PrismaService } from '@/infrastructure';
import { Util } from '@/common';

/** Twelve hours from the second factor. A shift, not a tenancy. */
export const ADMIN_SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
/** Thirty minutes without a request. Long enough to read a case, short enough to leave a desk. */
export const ADMIN_SESSION_IDLE_MS = 30 * 60 * 1000;
export const ADMIN_ACCESS_TTL_SECONDS = 15 * 60;
/** Mirrors the member limit. A sixth sign-in revokes the oldest rather than being refused. */
export const ADMIN_MAX_SESSIONS = 5;
/** How long two concurrent refreshes may both be answered with the same new pair. */
export const ADMIN_REFRESH_GRACE_MS = 30 * 1000;

const SESSION_CACHE_TTL_SECONDS = 60;

export interface AdminSessionState {
  id: string;
  userId: string;
  revoked: boolean;
  absoluteExpiresAt: string;
  lastUsedAt: string;
}

/**
 * Admin sessions: short, revocable the instant somebody decides so, and countable.
 *
 * The refresh token is opaque rather than a JWT — `<sessionId>.<32 random bytes>` — for one
 * reason: a JWT is valid because of its signature, so revoking one means maintaining a list of
 * exceptions. An opaque token is valid because the server still has its hash, which makes
 * revocation a delete rather than a denylist.
 */
@Injectable()
export class AdminSessionService {
  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
  ) {}

  private sessionKey = (id: string) => `admin:session:${id}`;
  private revokedKey = (id: string) => `admin:session-revoked:${id}`;
  private graceKey = (hash: string) => `admin:refresh-grace:${hash}`;
  private lockKey = (id: string) => `admin:refresh-lock:${id}`;

  /** `<sessionId>.<secret>` — the id up front so a presented token names the row to compare against. */
  mintRefreshToken(sessionId: string): string {
    return `${sessionId}.${randomBytes(32).toString('base64url')}`;
  }

  sessionIdFrom(refreshToken: string): string | null {
    const [sessionId] = refreshToken.split('.');

    return sessionId && sessionId.length >= 36 ? sessionId : null;
  }

  async create(input: {
    userId: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ session: AdminSession; refreshToken: string }> {
    await this.enforceLimit(input.userId);

    const now = Date.now();
    const id = Util.generateUuid();
    const refreshToken = this.mintRefreshToken(id);

    const session = await this.database.adminSession.create({
      data: {
        id,
        userId: input.userId,
        refreshTokenHash: Util.tokenHash(refreshToken),
        ip: input.ip ?? 'unknown',
        userAgent: input.userAgent ?? 'unknown',
        absoluteExpiresAt: new Date(now + ADMIN_SESSION_ABSOLUTE_MS),
      },
    });

    await this.cacheState(session);

    return { session, refreshToken };
  }

  /**
   * The state the JWT strategy needs, from Redis where possible.
   *
   * Cached for a minute, which is the compromise: a database read on every admin request is
   * needless, and a cache that outlives a revocation is dangerous. Revocation writes a separate
   * key the strategy checks first, so it takes effect on the next request rather than in a minute.
   */
  async state(sessionId: string): Promise<AdminSessionState | null> {
    if (await this.cache.get(this.revokedKey(sessionId))) return null;

    const cached = await this.cache.get<AdminSessionState>(this.sessionKey(sessionId));

    if (cached) return cached;

    const session = await this.database.adminSession.findUnique({ where: { id: sessionId } });

    if (!session) return null;

    const state = this.toState(session);

    await this.cache.set(this.sessionKey(sessionId), state, SESSION_CACHE_TTL_SECONDS);

    return state;
  }

  /** Why a live session is nonetheless unusable, or null when it is fine. */
  expiryReason(state: AdminSessionState): AdminSessionRevokeReason | null {
    if (state.revoked) return AdminSessionRevokeReason.ADMIN_REVOKED;
    if (new Date(state.absoluteExpiresAt).getTime() <= Date.now())
      return AdminSessionRevokeReason.EXPIRED;
    if (Date.now() - new Date(state.lastUsedAt).getTime() > ADMIN_SESSION_IDLE_MS)
      return AdminSessionRevokeReason.IDLE;

    return null;
  }

  /**
   * Marks the session used, at most once a minute.
   *
   * The idle timeout needs this to move, but writing a row on every request would make an admin
   * list page a write-heavy endpoint. A minute's granularity against a thirty-minute timeout is
   * not a difference anybody can feel.
   */
  async touch(sessionId: string, lastUsedAt: string): Promise<void> {
    if (Date.now() - new Date(lastUsedAt).getTime() < 60_000) return;

    const now = new Date();

    await this.database.adminSession
      .update({ where: { id: sessionId }, data: { lastUsedAt: now } })
      .catch(() => undefined);
    await this.cache.delete(this.sessionKey(sessionId));
  }

  async revoke(
    sessionId: string,
    reason: AdminSessionRevokeReason,
    revokedById?: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.database;

    await client.adminSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedReason: reason,
        revokedById: revokedById ?? null,
        // Cleared, so a reactivation later cannot revive a token issued before the revocation.
        refreshTokenHash: null,
        previousRefreshTokenHash: null,
      },
    });

    await this.blacklist(sessionId);
  }

  /** Revokes every live session for a staff member. Returns how many were live. */
  async revokeAll(input: {
    userId: string;
    reason: AdminSessionRevokeReason;
    revokedById?: string | null;
    except?: string;
    tx?: Prisma.TransactionClient;
  }): Promise<number> {
    const client = input.tx ?? this.database;
    const live = await client.adminSession.findMany({
      where: {
        userId: input.userId,
        revokedAt: null,
        ...(input.except ? { id: { not: input.except } } : {}),
      },
      select: { id: true },
    });

    if (!live.length) return 0;

    await client.adminSession.updateMany({
      where: { id: { in: live.map(session => session.id) } },
      data: {
        revokedAt: new Date(),
        revokedReason: input.reason,
        revokedById: input.revokedById ?? null,
        refreshTokenHash: null,
        previousRefreshTokenHash: null,
      },
    });

    // Spread, not nested: an array passed as one element of Promise.all is never awaited, which is
    // how the member equivalent came to report success while leaving access tokens working (B9).
    await Promise.all(live.map(session => this.blacklist(session.id)));

    return live.length;
  }

  /**
   * Serialises refresh for one session.
   *
   * Two requests refreshing at once would otherwise both rotate, and the second would invalidate
   * the first's brand-new token — which looks to the portal like being logged out at random.
   */
  async withRefreshLock<T>(sessionId: string, work: () => Promise<T>): Promise<T | null> {
    const acquired = await this.cache.setIfAbsent(this.lockKey(sessionId), 1, 5000);

    if (!acquired) return null;

    try {
      return await work();
    } finally {
      await this.cache.delete(this.lockKey(sessionId));
    }
  }

  async rememberGrace(oldToken: string, pair: unknown): Promise<void> {
    await this.cache.set(
      this.graceKey(Util.tokenHash(oldToken)),
      pair,
      Math.floor(ADMIN_REFRESH_GRACE_MS / 1000),
    );
  }

  async recallGrace<T>(oldToken: string): Promise<T | null> {
    return this.cache.get<T>(this.graceKey(Util.tokenHash(oldToken)));
  }

  async listFor(userId: string): Promise<AdminSession[]> {
    return this.database.adminSession.findMany({
      where: { userId, revokedAt: null },
      orderBy: [{ lastUsedAt: 'desc' }, { id: 'asc' }],
    });
  }

  private async blacklist(sessionId: string): Promise<void> {
    // Held for the access-token lifetime: after that the token cannot be presented anyway.
    await this.cache.set(this.revokedKey(sessionId), 1, ADMIN_ACCESS_TTL_SECONDS);
    await this.cache.delete(this.sessionKey(sessionId));
  }

  private async cacheState(session: AdminSession): Promise<void> {
    await this.cache.set(
      this.sessionKey(session.id),
      this.toState(session),
      SESSION_CACHE_TTL_SECONDS,
    );
  }

  private toState(session: AdminSession): AdminSessionState {
    return {
      id: session.id,
      userId: session.userId,
      revoked: session.revokedAt !== null,
      absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
    };
  }

  private async enforceLimit(userId: string): Promise<void> {
    const live = await this.database.adminSession.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    const excess = live.length - (ADMIN_MAX_SESSIONS - 1);

    for (const session of live.slice(0, Math.max(excess, 0))) {
      await this.revoke(session.id, AdminSessionRevokeReason.SESSION_LIMIT);
    }
  }
}
