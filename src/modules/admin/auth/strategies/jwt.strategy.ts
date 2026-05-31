import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { SessionService } from '../services/session.service';
import { AccessTokenPayload } from '../types';
import { PrismaService } from '@/infrastructure';
import { ErrorMessage } from '@/common';
import { UserAccountStatus } from '@prisma/client';

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    configService: ConfigService,
    private readonly database: PrismaService,
    private readonly sessionService: SessionService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('ADMIN_JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: AccessTokenPayload) {
    const isBlacklisted = await this.sessionService.isSessionBlacklisted(payload.sid);

    if (isBlacklisted) {
      throw new UnauthorizedException(ErrorMessage.SESSION_EXPIRED);
    }

    const user = await this.database.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isStaff: true,
        status: true,
        userRole: {
          select: {
            role: {
              select: {
                code: true,
                isAdmin: true,
                rolePermissions: {
                  select: {
                    permission: { select: { code: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user || !user.isStaff) {
      throw new UnauthorizedException(ErrorMessage.UNAUTHORIZED);
    }

    if (user.status === UserAccountStatus.SUSPENDED) {
      throw new ForbiddenException(
        `${ErrorMessage.ACCESS_DENIED}. Please contact support for assistance.`,
      );
    }

    return user;
  }
}
