import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { Request } from 'express';
import { CookieService } from '../services/cookie.service';
import { ErrorMessage } from '@/common';

@Injectable()
export class AdminRefreshTokenStrategy extends PassportStrategy(Strategy, 'admin-refresh-token') {
  constructor(
    configService: ConfigService,
    private readonly cookieService: CookieService,
  ) {
    super({
      jwtFromRequest: (req: Request) => this.extractRefreshToken(req),
      secretOrKey: configService.get<string>('ADMIN_JWT_REFRESH_SECRET'),
      passReqToCallback: true,
      ignoreExpiration: false,
    });
  }

  validate(_req: Request, payload: any) {
    if (!payload?.sub) {
      throw new UnauthorizedException(ErrorMessage.SESSION_EXPIRED);
    }

    return true;
  }

  private extractRefreshToken(req: Request): string | null {
    const token = this.cookieService.extractRefreshToken(req);

    if (typeof token === 'string') {
      return token;
    }

    throw new UnauthorizedException(ErrorMessage.SESSION_EXPIRED);
  }
}
