import { Injectable, UnauthorizedException } from '@nestjs/common';
import { DeviceInfo, ErrorMessage, Util } from '@/common';
import { TokenService } from './token.service';
import { SessionService } from './session.service';
import { RefreshResult } from '../types';

@Injectable()
export class AuthService {
  constructor(
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
  ) {}

  async refreshAccessToken(refreshToken: string, deviceInfo: DeviceInfo): Promise<RefreshResult> {
    if (!refreshToken) {
      throw new UnauthorizedException(ErrorMessage.SESSION_EXPIRED);
    }

    const tokenData = await this.tokenService.validateRefreshToken(refreshToken);

    if (!tokenData) {
      throw new UnauthorizedException(ErrorMessage.SESSION_EXPIRED);
    }

    const { userId, sessionId } = tokenData;
    const validSession = await this.sessionService.validateSession(sessionId, userId, deviceInfo);

    if (!validSession.success || !validSession.session?.refreshToken) {
      throw new UnauthorizedException(ErrorMessage.SESSION_EXPIRED);
    }

    const isValid = await Util.validateHash(refreshToken, validSession.session.refreshToken);

    if (!isValid) {
      throw new UnauthorizedException(ErrorMessage.SESSION_EXPIRED);
    }

    const [accessToken, newRefreshToken] = await Promise.all([
      this.tokenService.generateAccessToken({ userId, sessionId }),
      this.tokenService.generateRefreshToken({ userId, sessionId }),
    ]);

    const newRefreshTokenHash = await Util.generateHash(newRefreshToken);

    await this.sessionService.rotateRefreshToken(sessionId, newRefreshTokenHash);

    return {
      sessionId,
      accessToken,
      refreshToken: newRefreshToken,
      message: 'Tokens refreshed successfully',
    };
  }
}
