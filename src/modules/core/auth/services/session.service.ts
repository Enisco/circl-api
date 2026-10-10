import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { CacheService, PrismaService } from '@/infrastructure';
import { ApiException, DeviceInfo, ErrorMessage, Util } from '@/common';
import { DevicePlatform, UserSession } from '@prisma/client';
import { TokenService } from './token.service';
import {
  CreateSessionParams,
  CreateSessionResponse,
  SessionValidationReason,
  ValidateSessionResponse,
} from '../types';
import { SessionRevocationService } from '@/modules/platform/shared';
import { SESSION_CONSTANTS } from '../constants';

@Injectable()
export class SessionService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
    private readonly database: PrismaService,
    private readonly tokenService: TokenService,
    private readonly cacheService: CacheService,
    private readonly revocation: SessionRevocationService,
  ) {
    this.logger.setContext(SessionService.name);
  }

  async createSession(params: CreateSessionParams): Promise<CreateSessionResponse> {
    const { deviceInfo, userId, sessionId } = params;

    await this.assertNotStaff(userId);
    await this.enforceSessionLimit(userId);

    const finalSessionId = sessionId ?? Util.generateUuid();

    const tokenPair = await this.tokenService.generateTokenPair({
      userId,
      sessionId: finalSessionId,
    });

    const deviceData = {
      userAgent: deviceInfo.userAgent,
      deviceType: deviceInfo.deviceType,
      browserName: deviceInfo.browser,
      operatingSystem: deviceInfo.os,
      ipAddress: deviceInfo.fullIp,
      deviceFingerprint: deviceInfo.deviceFingerprint,
      // Which build and which platform. "How many people are still on 2.1" is a question that can
      // only be answered from what was recorded at the time.
      appVersion: deviceInfo.appVersion ?? null,
      platform: deviceInfo.devicePlatform as DevicePlatform,
      osVersion: deviceInfo.osVersion ?? null,
    };

    // The member's current platform and build, denormalised onto the account. Written here as
    // well as by the activity gate because sign-in is the one moment a brand-new member has no
    // activity row yet, and a list row with an empty platform column on the day somebody joined
    // reads as "unknown" rather than "not yet asked".
    await this.database.user.update({
      where: { id: userId },
      data: {
        lastPlatform: deviceData.platform ?? null,
        lastAppVersion: deviceData.appVersion,
      },
    });

    const session = await this.database.userSession.upsert({
      where: {
        userId_deviceFingerprint: {
          userId,
          deviceFingerprint: deviceInfo.deviceFingerprint,
        },
      },
      update: {
        id: finalSessionId,
        user: { connect: { id: userId } },
        ...deviceData,
        isActive: true,
        lastActiveAt: new Date(),
        revokedAt: null,
        refreshToken: Util.tokenHash(tokenPair.refreshToken),
      },
      create: {
        id: finalSessionId,
        user: { connect: { id: userId } },
        ...deviceData,
        refreshToken: Util.tokenHash(tokenPair.refreshToken),
        isActive: true,
        lastActiveAt: new Date(),
      },
    });

    return { sessionId: session.id, tokenPair };
  }

  /**
   * A staff account may not hold a member session.
   *
   * Here rather than in each caller because there are three — email code, social sign-in and
   * registration — and the one that gets added next would be the one that forgot. Member sign-in
   * is an emailed code with no password and no second factor, so a staff account reachable through
   * it is an administrator login protected by an inbox (B1, S3.2). Staff who use Circl as members
   * do so with a separate personal account; `User.email` is unique, which is what makes that work.
   */
  private async assertNotStaff(userId: string): Promise<void> {
    const user = await this.database.user.findUnique({
      where: { id: userId },
      select: { isStaff: true },
    });

    if (user?.isStaff) {
      this.logger.warn({ securityEvent: 'staff_member_signin_refused', userId });

      // Deliberately the generic refusal: which accounts are staff is not something a sign-in
      // response should be able to tell anybody.
      throw ApiException.unauthorized(ErrorMessage.UNAUTHORIZED);
    }
  }

  async findSessionByFingerprint(userId: string, deviceFingerprint: string): Promise<UserSession> {
    return this.database.userSession.findUnique({
      where: {
        userId_deviceFingerprint: { userId, deviceFingerprint },
      },
    });
  }

  /**
   * Signs a member out of one session, or all of them.
   *
   * Delegated to `SessionRevocationService`, which is shared with the staff API: a suspension has
   * to revoke sessions exactly the way a sign-out does, and two copies of the blacklist key would
   * mean a revoked session that still works with nothing to show it.
   */
  async revoke(sessionId: string, userId: string, revokeAll = false): Promise<void> {
    await this.revocation.revoke(userId, revokeAll ? undefined : sessionId);
  }

  async validateSession(
    sessionId: string,
    userId: string,
    deviceInfo: DeviceInfo,
  ): Promise<ValidateSessionResponse> {
    const session = await this.database.userSession.findUnique({
      where: {
        id: sessionId,
        userId,
        deviceFingerprint: deviceInfo.deviceFingerprint,
      },
      select: {
        id: true,
        isActive: true,
        revokedAt: true,
        refreshToken: true,
        deviceFingerprint: true,
      },
    });

    if (!session) return { success: false, reason: SessionValidationReason.NOT_FOUND };

    if (!session.isActive) return { success: false, reason: SessionValidationReason.EXPIRED };

    if (!session.isActive && session.revokedAt)
      return { success: false, reason: SessionValidationReason.EXPIRED };

    if (session.deviceFingerprint !== deviceInfo.deviceFingerprint)
      return { success: false, reason: SessionValidationReason.FINGERPRINT_MISMATCH };

    return { success: true, session };
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.database.userSession.update({
      where: { id: sessionId },
      data: { lastActiveAt: new Date() },
    });
  }

  async rotateRefreshToken(
    sessionId: string,
    newRefreshTokenHash: string,
    deviceInfo?: DeviceInfo,
  ): Promise<void> {
    await this.database.userSession.update({
      where: { id: sessionId },
      data: {
        refreshToken: newRefreshTokenHash,
        lastActiveAt: new Date(),
        // Refreshed too, not only set at sign-in. A member who updates the app keeps the same
        // session for thirty days, so without this the recorded build is the one they installed
        // a month ago and "who is still on the old version" answers the wrong question.
        ...(deviceInfo
          ? {
              appVersion: deviceInfo.appVersion ?? null,
              platform: deviceInfo.devicePlatform as DevicePlatform,
              osVersion: deviceInfo.osVersion ?? null,
            }
          : {}),
      },
    });
  }

  async isSessionBlacklisted(sessionId: string): Promise<boolean> {
    return this.revocation.isBlacklisted(sessionId);
  }

  async getSession(sessionId: string) {
    return this.database.userSession.findUnique({ where: { id: sessionId } });
  }

  async revokeOtherSessionsExceptCurrent(userId: string, currentSessionId: string): Promise<void> {
    const sessions = await this.database.userSession.findMany({
      where: { userId, isActive: true },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const sessionsToRevoke = sessions.filter(session => session.id !== currentSessionId);

    await Promise.all(sessionsToRevoke.map(session => this.blacklistSession(session.id)));

    await this.database.userSession.updateMany({
      where: { userId, isActive: true, NOT: { id: currentSessionId } },
      data: { isActive: false, refreshToken: null, revokedAt: new Date() },
    });
  }

  private async enforceSessionLimit(userId: string): Promise<void> {
    const sessions = await this.database.userSession.findMany({
      where: { userId, isActive: true },
      orderBy: {
        createdAt: 'desc',
      },
      select: { id: true, createdAt: true },
    });

    if (sessions.length >= SESSION_CONSTANTS.MAX_ACTIVE_SESSIONS) {
      const oldest = sessions.reduce((oldest, current) =>
        current.createdAt < oldest.createdAt ? current : oldest,
      );

      await this.database.userSession.update({
        where: { id: oldest.id },
        data: { isActive: false, refreshToken: null, revokedAt: new Date() },
      });
      await this.blacklistSession(oldest.id);
    }
  }

  private async blacklistSession(sessionId: string): Promise<void> {
    await this.revocation.blacklist(sessionId);
  }
}
