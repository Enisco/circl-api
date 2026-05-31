import { ROLE_KEY } from '@/common/decorators';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorMessage } from '../constants';

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    if (!user) {
      throw new UnauthorizedException(ErrorMessage.UNAUTHORIZED);
    }

    if (!user.userRole?.role) {
      throw new ForbiddenException(ErrorMessage.UNAUTHORIZED);
    }

    const hasRequiredRole = requiredRoles.includes(user.userRole.role.code);

    if (!hasRequiredRole) {
      throw new ForbiddenException(ErrorMessage.UNAUTHORIZED);
    }

    return true;
  }
}
