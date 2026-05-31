import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response, Request } from 'express';
import { ClientPlatform } from '@/common';
import { AUTH_CONSTANTS } from '../constants';

@Injectable()
export class CookieService {
  constructor(private readonly configService: ConfigService) {}

  setTokensInCookies(res: Response, refreshToken: string, accessToken: string): void {
    const env = this.configService.get('APP_ENV');
    const accessTokenMaxAge = AUTH_CONSTANTS.SESSION.ACCESS_TOKEN_TTL_MINUTES * 60 * 1000;
    const refreshTokenMaxAge = AUTH_CONSTANTS.SESSION.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

    const cookieConfig: Record<string, { secure: boolean; sameSite: 'lax' | 'none' }> = {
      local: { secure: false, sameSite: 'lax' },
      development: { secure: true, sameSite: 'none' },
      production: { secure: true, sameSite: 'lax' },
    };

    const { secure, sameSite } = cookieConfig[env] ?? { secure: true, sameSite: 'lax' };

    const baseOptions = { ...AUTH_CONSTANTS.COOKIE.OPTIONS, secure, sameSite };

    res.cookie(AUTH_CONSTANTS.COOKIE.ACCESS_TOKEN_KEY, accessToken, {
      ...baseOptions,
      maxAge: accessTokenMaxAge,
    });
    res.cookie(AUTH_CONSTANTS.COOKIE.REFRESH_TOKEN_KEY, refreshToken, {
      ...baseOptions,
      maxAge: refreshTokenMaxAge,
    });
  }

  private getRefreshTokenFromCookie(req: { cookies: Record<string, string> }): string | undefined {
    return req.cookies[AUTH_CONSTANTS.COOKIE.REFRESH_TOKEN_KEY];
  }

  extractRefreshToken(req: Request): string {
    const platform = req.headers['x-client-platform'] as string;

    if (platform === ClientPlatform.MOBILE) {
      const refreshToken = req.headers['x-refresh-token'] as string;

      if (!refreshToken) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      return refreshToken;
    }

    const refreshToken = this.getRefreshTokenFromCookie(req);

    if (!refreshToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return refreshToken;
  }

  clearTokensFromCookies(res: Response): void {
    const isLocal = this.configService.get('APP_ENV') === 'local';

    res.clearCookie(AUTH_CONSTANTS.COOKIE.ACCESS_TOKEN_KEY, {
      ...AUTH_CONSTANTS.COOKIE.OPTIONS,
      secure: !isLocal,
    });

    res.clearCookie(AUTH_CONSTANTS.COOKIE.REFRESH_TOKEN_KEY, {
      ...AUTH_CONSTANTS.COOKIE.OPTIONS,
      secure: !isLocal,
    });
  }
}
