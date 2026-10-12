import { Injectable, UnauthorizedException } from '@nestjs/common';
import { DeviceInfo, ErrorMessage, Util } from '@/common';
import { TokenService } from './token.service';
import { SessionService } from './session.service';
import { AccountStateService } from './account-state.service';
import { PrismaService } from '@/infrastructure';
import { RefreshResult } from '../types';

@Injectable()
export class AuthService {
  constructor(
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly database: PrismaService,
    private readonly accountState: AccountStateService,
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

    // Compared as digests of the whole token. bcrypt stopped at 72 bytes, and two refresh JWTs for
    // one session agree on their first 72, so every superseded token for a session still passed
    // this check until it expired — thirty days of rotation that rotated nothing (B3).
    const isValid = Util.hashesMatch(
      Util.tokenHash(refreshToken),
      validSession.session.refreshToken,
    );

    if (!isValid) {
      throw new UnauthorizedException(ErrorMessage.SESSION_EXPIRED);
    }

    // Checked here and not only at sign-in (§13.2). Suspending a member revokes their sessions, so
    // most of the time the session lookup above has already refused — but "most of the time" is
    // not the guarantee, and this is also what gives the app somewhere to learn *why* it is being
    // turned away. Without it the only answer refresh could give was 401, which the client reads
    // as an expired session: it would clear the tokens, show the sign-in screen, and the member
    // would find out they were suspended only after typing an emailed code.
    const account = await this.database.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        status: true,
        suspendedUntil: true,
        isAnonymised: true,
        anonymisedAt: true,
      },
    });

    if (!account) {
      throw new UnauthorizedException(ErrorMessage.SESSION_EXPIRED);
    }

    await this.accountState.assertUsable(account);

    const [accessToken, newRefreshToken] = await Promise.all([
      this.tokenService.generateAccessToken({ userId, sessionId }),
      this.tokenService.generateRefreshToken({ userId, sessionId }),
    ]);

    const newRefreshTokenHash = Util.tokenHash(newRefreshToken);

    await this.sessionService.rotateRefreshToken(sessionId, newRefreshTokenHash, deviceInfo);

    return {
      sessionId,
      accessToken,
      refreshToken: newRefreshToken,
      message: 'Tokens refreshed successfully',
    };
  }
}
