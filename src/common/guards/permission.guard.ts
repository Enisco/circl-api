import { PERMISSIONS_KEY } from '../decorators';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorMessage } from '../constants';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> | never {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredPermissions || !requiredPermissions.length) {
      return true;
    }

    const userWithRoles = context.switchToHttp().getRequest().user;

    if (!userWithRoles?.userRole?.role) {
      throw new ForbiddenException(ErrorMessage.NO_REQUIRED_PERMISSIONS);
    }

    const userPermissions = new Set(
      userWithRoles.userRole.role.rolePermissions.map(rp => rp.permission.code),
    );

    if (userPermissions.has('manage:all')) {
      return true;
    }

    const hasRequiredPermissions = requiredPermissions.every(permission =>
      userPermissions.has(permission),
    );

    if (hasRequiredPermissions) {
      return true;
    } else {
      throw new ForbiddenException(ErrorMessage.NO_REQUIRED_PERMISSIONS);
    }
  }
}
