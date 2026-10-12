import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import { MediaService } from '@/modules/platform/shared';
import { StaffRefView, staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';

/**
 * Which permission makes somebody assignable on each queue.
 *
 * Assignability is "can act on it", not "can see it": handing a guard thread to somebody with
 * `guard:read` puts it in a queue they cannot clear, and it stops looking unassigned to everybody
 * else. So the lists are keyed on the *manage* permission even though the endpoint opens on the
 * read one.
 */
const ASSIGNABLE: Record<string, string> = {
  guard: 'guard:manage',
  moderation: 'moderation:decide',
  support: 'support:manage',
};

export const ASSIGNEE_QUEUES = Object.keys(ASSIGNABLE);

/**
 * Who a piece of work can be given to (§5.27).
 *
 * Exists so Trust & Safety and Support can pick an assignee **without `team:read`** (§5.27,
 * Decision). The alternative was giving every moderator the staff directory — names, roles,
 * sessions, invite state — to populate one dropdown, which is a much larger grant than the task
 * needs.
 *
 * So this returns only what a dropdown draws, and only for the one queue asked about.
 */
@Injectable()
export class AdminAssigneeService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
  ) {}

  async forQueue(queue: string): Promise<StaffRefView[]> {
    const permission = ASSIGNABLE[queue];

    if (!permission) return [];

    const rows = await this.database.user.findMany({
      where: {
        isStaff: true,
        deletedAt: null,
        anonymisedAt: null,
        // Active means the credential has not been deactivated. A staff member who has been
        // switched off must not appear in a dropdown: the work would be assigned to somebody who
        // cannot sign in to do it, and it would stop reading as unassigned.
        adminCredential: { deactivatedAt: null },
        userRole: {
          role: { rolePermissions: { some: { permission: { code: permission } } } },
        },
      },
      select: staffRefSelect,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
    });

    return rows.map(row => toStaffRef(row, key => this.media.sign(key)));
  }

  /**
   * That this person can actually do the work before it is handed to them.
   *
   * The mirror of `forQueue`: that one answers "who may I pick", this one enforces it for a write
   * that names somebody directly. Both are needed, because the dropdown is a convenience and the
   * request body is the contract — a PATCH carrying any staff id at all would otherwise assign
   * safeguarding work to somebody holding `guard:read`, who would see it in a queue they cannot
   * clear while it stopped reading as unassigned to everybody who could.
   *
   * `field` names the property in the caller's own body, so the 400 points at what the client
   * sent rather than at whatever this file happens to call it.
   */
  async assertHolds(userId: string, needed: string[], field: string): Promise<void> {
    const person = await this.database.user.findUnique({
      where: { id: userId },
      select: {
        isStaff: true,
        adminCredential: { select: { deactivatedAt: true } },
        userRole: {
          select: {
            role: {
              select: { rolePermissions: { select: { permission: { select: { code: true } } } } },
            },
          },
        },
      },
    });

    if (!person?.isStaff || person.adminCredential?.deactivatedAt) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'That is not an active staff account.',
        { details: [{ field, message: 'Not an active staff account.' }] },
      );
    }

    const held = new Set(
      person.userRole?.role.rolePermissions.map(entry => entry.permission.code) ?? [],
    );

    if (!needed.some(code => held.has(code))) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'They cannot work that kind of item.',
        { details: [{ field, message: `Needs one of: ${needed.join(', ')}.` }] },
      );
    }
  }
}
