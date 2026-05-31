import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { SessionService } from '../services';
import { AccessTokenPayload } from '../types';
import { PrismaService } from '@/infrastructure';
import { ErrorMessage } from '@/common';
import { UserAccountStatus } from '@prisma/client';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly sessionService: SessionService,
    private readonly database: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: AccessTokenPayload) {
    const isSessionBlacklisted = await this.sessionService.isSessionBlacklisted(payload.sid);

    if (isSessionBlacklisted) {
      throw new UnauthorizedException(ErrorMessage.SESSION_EXPIRED);
    }

    const user = await this.database.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        status: true,
        userRole: {
          select: {
            role: {
              select: {
                code: true,
                rolePermissions: {
                  select: {
                    permission: {
                      select: {
                        code: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!user || user.status === UserAccountStatus.SUSPENDED) {
      throw new ForbiddenException(
        `${ErrorMessage.ACCESS_DENIED}. Please, contact support for assistance.`,
      );
    }

    return user;
  }
}
