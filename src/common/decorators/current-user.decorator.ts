import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** The authenticated user, as returned by JwtStrategy.validate. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  status: string;
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

/** The user id when a token was supplied, `null` when the route is public and the caller is anonymous. */
export const OptionalUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    (context.switchToHttp().getRequest().user as AuthenticatedUser)?.id ?? null,
);
