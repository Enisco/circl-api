import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService, PrismaService } from '@/infrastructure';
import { Util } from '@/common';

/**
 * Signing a member out, in one place.
 *
 * Revocation is two writes that have to happen together: the session row stops being active, and
 * the session id goes on a Redis blacklist for as long as an access token could still carry it.
 * Doing only the first leaves every issued access token working until it expires — which is the
 * bug (B9) that made a "sign out everywhere" button a suggestion.
 *
 * Here, in platform shared, rather than on the member `SessionService`, because two callers need
 * identical behaviour: a member signing themselves out, and a staff member suspending an account.
 * The staff side cannot import the member auth module — it registers the member auth routes, and
 * an admin-only process must not serve them — so without this seam the admin API would have had
 * its own copy of the blacklist key, and a drift in that key is a revoked session that still works
 * with nothing to show it.
 */
@Injectable()
export class SessionRevocationService {
  /** The key prefix. Shared by whoever writes it and whoever checks it, which is the whole point. */
  private static readonly BLACKLIST_PREFIX = 'blacklisted:sessions';

  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Revokes one session, or every session a member has.
   *
   * Returns how many were live, because that is what a staff member is told and what the audit
   * entry records — "signed out" with no number does not say whether anything happened.
   */
  async revoke(userId: string, sessionId?: string): Promise<number> {
    const now = new Date();
    const live = await this.database.userSession.findMany({
      where: { userId, isActive: true, ...(sessionId ? { id: sessionId } : {}) },
      select: { id: true },
    });

    // Spread rather than nested: passed as one array element these writes were never awaited and
    // their failures never surfaced, so a revoke-everything could report success while leaving
    // live access tokens working (B9).
    await Promise.all([
      this.database.userSession.updateMany({
        where: { userId, ...(sessionId ? { id: sessionId } : {}) },
        data: { isActive: false, refreshToken: null, revokedAt: now },
      }),
      ...live.map(session => this.blacklist(session.id)),
    ]);

    return live.length;
  }

  async isBlacklisted(sessionId: string): Promise<boolean> {
    return !!(await this.cache.get(`${SessionRevocationService.BLACKLIST_PREFIX}:${sessionId}`));
  }

  /**
   * Holds the session id for exactly as long as an access token bearing it could still be presented.
   *
   * Taken from `JWT_ACCESS_EXPIRY` rather than fixed, so shortening the token lifetime shortens the
   * blacklist with it and lengthening it does not quietly open a window.
   */
  async blacklist(sessionId: string): Promise<void> {
    const ttl = Util.parseDurationToSeconds(this.config.getOrThrow<string>('JWT_ACCESS_EXPIRY'));

    await this.cache.set(`${SessionRevocationService.BLACKLIST_PREFIX}:${sessionId}`, true, ttl);
  }
}
