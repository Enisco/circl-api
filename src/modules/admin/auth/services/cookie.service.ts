import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AUTH_CONSTANTS, COOKIE_NAMESPACE_MAP } from '../constants';
import { ErrorMessage } from '@/common';

@Injectable()
export class CookieService {
  constructor(private readonly configService: ConfigService) {}

  setRefreshTokenInCookie(res: Response, refreshToken: string): void {
    const env = this.configService.get<string>('APP_ENV');
    const maxAge = AUTH_CONSTANTS.SESSION.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

    const cookieConfig: Record<string, { secure: boolean; sameSite: 'lax' | 'none' | 'strict' }> = {
      local: { secure: false, sameSite: 'lax' },
      development: { secure: true, sameSite: 'none' },
      staging: { secure: true, sameSite: 'strict' },
      production: { secure: true, sameSite: 'strict' },
    };

    const { secure, sameSite } = cookieConfig[env] ?? { secure: true, sameSite: 'strict' };

    res.cookie(this.getCookieName(), refreshToken, {
      ...AUTH_CONSTANTS.COOKIE.OPTIONS,
      secure,
      sameSite,
      maxAge,
    });
  }

  extractRefreshToken(req: Request): string {
    const token = req.cookies[this.getCookieName()];

    if (!token) {
      throw new UnauthorizedException(ErrorMessage.SESSION_EXPIRED);
    }

    return token;
  }

  clearRefreshTokenFromCookie(res: Response): void {
    const isLocal = this.configService.get('APP_ENV') === 'local';

    res.clearCookie(this.getCookieName(), {
      ...AUTH_CONSTANTS.COOKIE.OPTIONS,
      secure: !isLocal,
    });
  }

  private getCookieName(): string {
    const ns = COOKIE_NAMESPACE_MAP[this.configService.get<string>('APP_ENV')] ?? 'local';

    return `__Secure_ftr_adm_rt_${ns}`;
  }
}
