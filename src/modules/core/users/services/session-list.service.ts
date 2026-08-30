import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';

/** One row on the Security screen (G3). */
export interface SessionView {
  id: string;
  device: string;
  platform: 'IOS' | 'ANDROID' | 'WEB';
  location: string | null;
  ipCountry: string | null;
  lastSeenAt: string;
  createdAt: string;
  isCurrent: boolean;
}

/**
 * The devices signed into an account. The screen used to render three invented rows and a
 * snackbar, so a member using it to eject an attacker was being lied to.
 */
@Injectable()
export class SessionListService {
  constructor(private readonly database: PrismaService) {}

  async list(userId: string, currentSessionId: string | null) {
    const rows = await this.database.userSession.findMany({
      where: { userId, isActive: true, revokedAt: null },
      orderBy: { lastActiveAt: 'desc' },
    });

    return {
      data: rows.map(row => ({
        id: row.id,
        device: deviceLabel(row),
        platform: platformOf(row),
        // City level only. A precise location on this screen is a map of where the member lives.
        location: locationOf(row),
        ipCountry: null,
        lastSeenAt: row.lastActiveAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        isCurrent: row.id === currentSessionId,
      })) satisfies SessionView[],
    };
  }

  /** Signing the current session out belongs to Log out, which also clears the keychain. */
  async revoke(userId: string, sessionId: string, currentSessionId: string | null) {
    if (sessionId === currentSessionId) {
      throw ApiException.conflict(
        ApiErrorCode.CANNOT_REVOKE_CURRENT_SESSION,
        'Use Log out to sign this device out, so the app can clear its keys in the same step.',
      );
    }

    const session = await this.database.userSession.findFirst({
      where: { id: sessionId, userId },
      select: { id: true },
    });

    if (!session) throw ApiException.notFound('That session could not be found.');

    await this.database.userSession.update({
      where: { id: sessionId },
      data: { isActive: false, revokedAt: new Date(), refreshToken: null },
    });

    return { data: { revoked: 1 } };
  }

  /** Everything except the caller's own, so the member is not signed out of the app they are holding. */
  async revokeOthers(userId: string, currentSessionId: string | null) {
    const { count } = await this.database.userSession.updateMany({
      where: {
        userId,
        isActive: true,
        revokedAt: null,
        ...(currentSessionId ? { id: { not: currentSessionId } } : {}),
      },
      data: { isActive: false, revokedAt: new Date(), refreshToken: null },
    });

    return { data: { revoked: count } };
  }
}

type SessionRow = {
  userAgent: string;
  deviceType: string;
  browserName: string;
  operatingSystem: string;
  ipAddress: string;
};

/** Derived here rather than in the app, so a new device family does not need a release to read well. */
const deviceLabel = (row: SessionRow): string => {
  const os = row.operatingSystem?.trim();
  const browser = row.browserName?.trim();
  const unknown = (value?: string) => !value || value.toLowerCase() === 'unknown';

  if (isMobile(row)) return unknown(os) ? 'Mobile device' : os;
  if (unknown(browser)) return unknown(os) ? 'Unknown device' : os;

  return unknown(os) ? browser : `${browser} on ${os}`;
};

const isMobile = (row: SessionRow) =>
  /mobile|ios|android|iphone|ipad/i.test(`${row.deviceType} ${row.operatingSystem}`);

const platformOf = (row: SessionRow): SessionView['platform'] => {
  const haystack = `${row.deviceType} ${row.operatingSystem} ${row.userAgent}`;

  if (/ios|iphone|ipad|mac os x.*mobile/i.test(haystack)) return 'IOS';
  if (/android/i.test(haystack)) return 'ANDROID';

  return 'WEB';
};

/**
 * Null rather than a guess. A wrong city on this screen is worse than none: it is the signal a
 * member uses to decide whether a session is theirs.
 */
const locationOf = (_row: SessionRow): string | null => null;
