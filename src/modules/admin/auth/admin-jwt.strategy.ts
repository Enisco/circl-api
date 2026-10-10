import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserAccountStatus } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import { AdminPrincipal } from '../common/admin-principal';
import { adminContext } from '../common/admin-context';
import { AdminSessionService } from './admin-session.service';
import { AdminPermissionService } from './admin-permission.service';

export const ADMIN_TOKEN_ISSUER = 'circl-api';
export const ADMIN_TOKEN_AUDIENCE = 'circl-admin';
export const ADMIN_TOKEN_TYPE = 'admin_access';

interface AdminAccessPayload {
  sub: string;
  sid: string;
  typ?: string;
  role?: string;
}

/**
 * The strategy `AdminJwtGuard` has always referenced and which has never existed — so until now
 * the guard threw at runtime and the admin routes ran on the member guard instead (B2).
 *
 * Deliberately does four things rather than one. A valid signature proves the token was minted
 * here; it does not prove the session still exists, that the account is still staff, that it has
 * not been deactivated, or what the role may now do. Each of those is a way an administrator keeps
 * access they were supposed to lose, so each is checked per request.
 */
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    config: ConfigService,
    private readonly database: PrismaService,
    private readonly sessions: AdminSessionService,
    private readonly permissions: AdminPermissionService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('ADMIN_JWT_ACCESS_SECRET'),
      algorithms: ['HS256'],
      issuer: ADMIN_TOKEN_ISSUER,
      audience: ADMIN_TOKEN_AUDIENCE,
    });
  }

  async validate(payload: AdminAccessPayload): Promise<AdminPrincipal> {
    // Defence in depth. A member token fails on the signature already, because the secrets differ
    // and startup refuses a deployment where they do not — but the separation should not rest on
    // one environment variable being right.
    if (payload.typ !== ADMIN_TOKEN_TYPE) throw new UnauthorizedException();

    const state = await this.sessions.state(payload.sid);

    if (!state || state.userId !== payload.sub || this.sessions.expiryReason(state)) {
      // Its own code: the portal refreshes once on a 401 and logs out on this one, so "your
      // session is gone" has to be distinguishable from "your access token aged out".
      throw ApiException.unauthorized(
        'That admin session is no longer valid.',
        ApiErrorCode.SESSION_REVOKED,
      );
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
        adminCredential: { select: { deactivatedAt: true } },
        userRole: { select: { role: { select: { code: true, isAdmin: true } } } },
      },
    });

    const role = user?.userRole?.role;

    if (
      !user ||
      !user.isStaff ||
      user.status !== UserAccountStatus.ACTIVE ||
      !user.adminCredential ||
      user.adminCredential.deactivatedAt !== null ||
      !role?.isAdmin
    ) {
      throw ApiException.unauthorized(
        'That admin session is no longer valid.',
        ApiErrorCode.SESSION_REVOKED,
      );
    }

    const principal: AdminPrincipal = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roleCode: role.code,
      permissions: await this.permissions.forRole(role.code),
      sessionId: payload.sid,
    };

    // So every audit entry written during this request names its actor without being told.
    adminContext.identify({
      id: principal.id,
      roleCode: principal.roleCode,
      sessionId: principal.sessionId,
    });

    await this.sessions.touch(payload.sid, state.lastUsedAt);

    return principal;
  }
}
