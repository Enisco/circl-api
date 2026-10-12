import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { SessionService } from '../services';
import { MEMBER_TOKEN_AUDIENCE } from '../constants';
import { AccessTokenPayload } from '../types';
import { PrismaService } from '@/infrastructure';
import { AccountStateService } from '../services/account-state.service';
import { ApiErrorCode, ApiException, ErrorMessage } from '@/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    configService: ConfigService,
    private readonly sessionService: SessionService,
    private readonly database: PrismaService,
    private readonly accountState: AccountStateService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_ACCESS_SECRET'),
      // Pinned, so a token signed with a different algorithm — or none — cannot be presented here.
      algorithms: ['HS256'],
      // The audience is not pinned in the options because tokens minted before it existed are
      // still live; `validate` checks it below and says when it sees an old one.
    });
  }

  async validate(payload: AccessTokenPayload & { aud?: string | string[] }) {
    // A refresh token, a signup token or an admin token is not an access token, whatever else is
    // true of it. Checked before anything is loaded: the cheapest refusal is the best one (B12).
    if (payload.type !== 'access') {
      throw new UnauthorizedException(ErrorMessage.UNAUTHORIZED);
    }

    const audience = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];

    if (audience.length && !audience.includes(MEMBER_TOKEN_AUDIENCE)) {
      // An admin token reaching a member route. It would fail on the signature anyway — the
      // secrets differ — but the claim is checked too, so the separation does not rest on one
      // environment variable being right.
      throw new UnauthorizedException(ErrorMessage.UNAUTHORIZED);
    }

    if (!audience.length) {
      // Minted before the audience existed. Accepted for now and recorded each time, so the moment
      // the last one expires is visible in the logs and this branch can go on evidence rather than
      // on an estimate of when a thirty-day refresh window closed.
      this.logger.warn({
        securityEvent: 'member_token_without_audience',
        sessionId: payload.sid,
      });
    }

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
        suspendedUntil: true,
        isAnonymised: true,
        anonymisedAt: true,
        isStaff: true,
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

    // A deleted account is gone, not merely refused.
    if (user?.isAnonymised) {
      throw ApiException.gone(
        ApiErrorCode.ACCOUNT_ALREADY_DELETED,
        'This account has been deleted.',
      );
    }

    if (!user) {
      throw new ForbiddenException(
        `${ErrorMessage.ACCESS_DENIED}. Please, contact support for assistance.`,
      );
    }

    // Suspended, on a token minted before the suspension revoked the session. The window is the
    // seconds between the two, but the refusal has to say which refusal it is: a generic 403 on
    // every screen at once is indistinguishable from "you may not do that", and the app showed it
    // as a failed action rather than as an account that has been stopped (§13.2).
    await this.accountState.assertUsable(user);

    // Staff do not use the member app with their staff account, and the member sign-in flow is an
    // email code with no password and no second factor. Allowing both meant a staff inbox was an
    // administrator login: the account holds a role with permissions, and the admin controller
    // accepted member tokens (B1). Staff who want to use Circl as members have a personal account.
    if (user.isStaff) {
      throw new UnauthorizedException(ErrorMessage.UNAUTHORIZED);
    }

    // The session the token was minted for, so a handler can tell "this device" from the others.
    return { ...user, sessionId: payload.sid };
  }
}
