import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** The authenticated user, as returned by JwtStrategy.validate. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  status: string;
  /** The session this access token was minted for. */
  sessionId?: string;
  userRole?: {
    role: {
      code: string;
      rolePermissions: Array<{ permission: { code: string } }>;
    };
  } | null;
}

export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, context: ExecutionContext) => {
    const user = context.switchToHttp().getRequest().user as AuthenticatedUser;

    return field ? user?.[field] : user;
  },
);

/** Shorthand for the common case, since almost every handler wants only the id. */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    (context.switchToHttp().getRequest().user as AuthenticatedUser)?.id,
);

/** The caller's own session, which is the one they must not be able to revoke from this screen. */
export const CurrentSessionId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    (context.switchToHttp().getRequest().user as AuthenticatedUser)?.sessionId ?? null,
);

/** The user id when a token was supplied, `null` when the route is public and the caller is anonymous. */
export const OptionalUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    (context.switchToHttp().getRequest().user as AuthenticatedUser)?.id ?? null,
);
