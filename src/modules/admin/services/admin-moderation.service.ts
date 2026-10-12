import { Injectable, Logger } from '@nestjs/common';
import { ModerationDecision, Prisma, ReportTargetType, UserAccountStatus } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiException } from '@/common';
import {
  AVATAR_MEDIA_OWNER,
  MediaService,
  authorSelect,
  toAuthorView,
} from '@/modules/platform/shared';
import { SuspendUserDto } from '../dtos/admin.dto';

/** The admin queue. */
@Injectable()
export class AdminModerationService {
  private readonly logger = new Logger(AdminModerationService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
  ) {}

  // `listQueue`, `decide` and `claim` lived here and are gone (§5.9).
  //
  // `AdminQueueService` replaced all three: CSV filters, a priority and a deadline, a detail
  // endpoint, `allowedDecisions`, and decisions that actually do something — the old `decide`
  // issued no strike for `WARN_AUTHOR`, published nothing for `APPROVE` and did nothing at all for
  // an anonymous `REJECT`. The routes moved to `AdminQueueController` in the same stage, which left
  // these three unreachable from any controller.
  //
  // Deleted rather than kept for reference: two implementations of one queue, one of them wrong
  // and neither obviously dead, is how somebody wires the old one back up. What this service still
  // owns is the removal switch (`removeContent`/`restoreContent`), the action trail, and
  // `setUserStatus` — the parts the new queue calls into.

  async setUserStatus(adminId: string, userId: string, dto: SuspendUserDto) {
    const user = await this.database.user.findUnique({ where: { id: userId } });

    if (!user || user.isAnonymised) throw ApiException.notFound('That member could not be found.');

    await this.database.$transaction(async tx => {
      await tx.user.update({
        where: { id: userId },
        data: { status: dto.status as UserAccountStatus },
      });

      if (dto.status === 'SUSPENDED') {
        // Revoked immediately: a suspension that leaves a live session running is not a suspension.
        await tx.userSession.updateMany({
          where: { userId },
          data: { isActive: false, revokedAt: new Date() },
        });
      }

      await tx.moderationAction.create({
        data: {
          actorId: adminId,
          targetType: ReportTargetType.USER,
          targetId: userId,
          decision:
            dto.status === 'SUSPENDED'
              ? ModerationDecision.SUSPEND_AUTHOR
              : ModerationDecision.NO_ACTION,
          reason: dto.reason ?? null,
        },
      });
    });

    return { userId, status: dto.status };
  }

  /** The audit trail for one piece of content or one member. */
  async actionsFor(targetType: ReportTargetType, targetId: string) {
    const actions = await this.database.moderationAction.findMany({
      where: { targetType, targetId },
      orderBy: { createdAt: 'desc' },
    });

    // Resolved separately rather than joined: the table deliberately holds no foreign key to the
    // user, so the record of a decision survives the deletion of the account that made it. An
    // actor who no longer exists reads as null rather than taking the record with them.
    const actors = await this.database.user.findMany({
      where: { id: { in: [...new Set(actions.map(action => action.actorId))] } },
      select: authorSelect,
    });
    const byId = new Map(actors.map(actor => [actor.id, actor]));

    return actions.map(action => ({
      id: action.id,
      actor: toAuthorView(byId.get(action.actorId) ?? null, { sign: this.media.sign }),
      decision: action.decision,
      reason: action.reason,
      createdAt: action.createdAt.toISOString(),
    }));
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** The actual text a reviewer needs to see, fetched per target type. */
  private async resolveContent(items: Array<{ targetType: ReportTargetType; targetId: string }>) {
    const byType = new Map<ReportTargetType, string[]>();

    for (const item of items) {
      const list = byType.get(item.targetType) ?? [];

      list.push(item.targetId);
      byType.set(item.targetType, list);
    }

    const result = new Map<string, Record<string, unknown>>();

    const load = async (
      type: ReportTargetType,
      loader: (ids: string[]) => Promise<Array<{ id: string } & Record<string, unknown>>>,
    ) => {
      const ids = byType.get(type);

      if (!ids?.length) return;

      for (const row of await loader(ids)) {
        result.set(`${type}:${row.id}`, row);
      }
    };

    await Promise.all([
      load(ReportTargetType.REQUEST, ids =>
        this.database.communityRequest.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true, description: true, visibility: true, deletedAt: true },
        }),
      ),
      load(ReportTargetType.UPDATE, ids =>
        this.database.communityUpdate.findMany({
          where: { id: { in: ids } },
          select: { id: true, content: true, visibility: true, deletedAt: true },
        }),
      ),
      load(ReportTargetType.OFFER, ids =>
        this.database.communityOffer.findMany({
          where: { id: { in: ids } },
          select: { id: true, title: true, description: true, deletedAt: true },
        }),
      ),
      load(ReportTargetType.GROUP_POST, ids =>
        this.database.groupPost.findMany({
          where: { id: { in: ids } },
          select: { id: true, content: true, deletedAt: true },
        }),
      ),
      load(ReportTargetType.RESPONSE, ids =>
        this.database.requestResponse.findMany({
          where: { id: { in: ids } },
          select: { id: true, content: true, deletedAt: true },
        }),
      ),
      load(ReportTargetType.STORE_ITEM, ids =>
        this.database.storeItem.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, description: true, deletedAt: true },
        }),
      ),
    ]);

    return result;
  }

  /**
   * Takes content down, by the rule each kind has for coming down (§6.6).
   *
   * Public because the report case decide path (§7.2) removes content for exactly the same
   * reasons through a different door, and two copies of this switch would drift apart — which is
   * how the `default: break` that silently swallowed a review removal got there in the first
   * place.
   */
  async removeContent(
    tx: Prisma.TransactionClient,
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<void> {
    await this.softDeleteTarget(tx, targetType, targetId);
  }

  /**
   * Puts content back, which is the only thing an overturned appeal can mean (§5.11).
   *
   * The inverse of `removeContent`, one kind at a time, because "undelete" is not one operation:
   * most kinds soft-delete, a professional service switches off, and two of them cannot come back
   * at all — a removed message had its text blanked and a removed avatar was deleted from storage.
   * Those two return quietly rather than pretending: the appeal's own trail records that it was
   * overturned, and a reviewer reading it can see what there was to restore.
   */
  async restoreContent(
    tx: Prisma.TransactionClient,
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<void> {
    const live = { deletedAt: null };
    const where = { id: targetId };

    switch (targetType) {
      case ReportTargetType.REQUEST:
        await tx.communityRequest.updateMany({ where, data: live });
        break;
      case ReportTargetType.UPDATE:
        await tx.communityUpdate.updateMany({ where, data: live });
        break;
      case ReportTargetType.OFFER:
        await tx.communityOffer.updateMany({ where, data: live });
        break;
      case ReportTargetType.RESPONSE:
        await tx.requestResponse.updateMany({ where, data: live });
        break;
      case ReportTargetType.UPDATE_REPLY:
        await tx.updateReply.updateMany({ where, data: live });
        break;
      case ReportTargetType.GROUP_POST:
        await tx.groupPost.updateMany({ where, data: live });
        break;
      case ReportTargetType.GROUP_POST_REPLY:
        await tx.groupPostReply.updateMany({ where, data: live });
        break;
      case ReportTargetType.GUIDE:
        await tx.guide.updateMany({ where, data: live });
        break;
      case ReportTargetType.GROUP:
        await tx.group.updateMany({ where, data: live });
        break;
      case ReportTargetType.STORE:
        await tx.store.updateMany({ where, data: live });
        break;
      case ReportTargetType.STORE_ITEM:
        await tx.storeItem.updateMany({ where, data: live });
        break;
      case ReportTargetType.PROFESSIONAL_LISTING:
        await tx.professionalListing.updateMany({ where, data: live });
        break;
      case ReportTargetType.PROFESSIONAL_SERVICE:
        // Switched off rather than deleted, so switching it back on is the restore.
        await tx.professionalService.updateMany({ where, data: { isActive: true } });
        break;
      case ReportTargetType.CONNECT_PROFILE:
        await tx.connectProfile.updateMany({ where, data: live });
        break;
      case ReportTargetType.CONNECT_POST:
        await tx.connectPost.updateMany({ where, data: live });
        break;
      case ReportTargetType.CONNECT_STORY:
        await tx.connectStory.updateMany({ where, data: live });
        break;
      case ReportTargetType.REVIEW:
        await tx.review.updateMany({ where, data: live });
        break;
      default:
        // MESSAGE, USER_PROFILE, MEDIA and the member types: nothing to undelete. The words were
        // blanked or the object was deleted, and saying so in the log beats a silent no-op.
        this.logger.warn(`Nothing to restore for ${targetType} ${targetId}`);
        break;
    }
  }

  private async softDeleteTarget(
    tx: Prisma.TransactionClient,
    targetType: ReportTargetType,
    targetId: string,
  ) {
    const now = { deletedAt: new Date() };

    switch (targetType) {
      case ReportTargetType.REQUEST:
        await tx.communityRequest.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.UPDATE:
        await tx.communityUpdate.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.OFFER:
        await tx.communityOffer.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.RESPONSE:
        await tx.requestResponse.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.UPDATE_REPLY:
        await tx.updateReply.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.GROUP_POST:
        await tx.groupPost.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.GROUP_POST_REPLY:
        await tx.groupPostReply.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.GUIDE:
        await tx.guide.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.GROUP:
        await tx.group.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.STORE:
        await tx.store.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.STORE_ITEM:
        await tx.storeItem.updateMany({
          where: { id: targetId },
          data: { ...now, isAvailable: false },
        });
        break;
      case ReportTargetType.MESSAGE:
        // Tombstoned like any other deletion, so the thread does not renumber.
        await tx.message.updateMany({ where: { id: targetId }, data: { ...now, body: null } });
        break;
      case ReportTargetType.PROFESSIONAL_LISTING:
        await tx.professionalListing.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.CONNECT_PROFILE:
        await tx.connectProfile.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.CONNECT_STORY:
        await tx.connectStory.updateMany({ where: { id: targetId }, data: now });
        await tx.media.deleteMany({ where: { ownerType: 'CONNECT_STORY', ownerId: targetId } });
        break;
      case ReportTargetType.CONNECT_MEDIA: {
        // A report names one item, because a photo is what somebody objects to. Taking it down
        // leaves the rest of its post standing — unless it was the last one, because an empty
        // post is not a post and the grid cannot draw one (3.9).
        const item = await tx.media.findUnique({
          where: { id: targetId },
          select: { ownerType: true, ownerId: true },
        });

        await tx.media.delete({ where: { id: targetId } }).catch(() => undefined);

        if (item?.ownerType === 'CONNECT_POST' && item.ownerId) {
          const left = await tx.media.count({
            where: { ownerType: 'CONNECT_POST', ownerId: item.ownerId },
          });

          if (left === 0) {
            await tx.connectPost.updateMany({ where: { id: item.ownerId }, data: now });
          }
        }

        // And it stops being quoted. A removed item has to disappear from any conversation that
        // started about it, the same way a withdrawn message does.
        await tx.$executeRaw`
          UPDATE "conversations"
          SET "context_snapshot" = "context_snapshot" - 'about'
          WHERE "context_snapshot" -> 'about' ->> 'id' = ${targetId}`;
        break;
      }
      // Added with the scanner (§4.1): four kinds that are now scanned, so they are now
      // removable. Without these a staff member removing a reported review saw a success and
      // nothing happened — the switch's `default` swallowed it.
      case ReportTargetType.CONNECT_POST:
        await tx.connectPost.updateMany({ where: { id: targetId }, data: now });
        await tx.media.deleteMany({ where: { ownerType: 'CONNECT_POST', ownerId: targetId } });
        break;
      case ReportTargetType.PROFESSIONAL_SERVICE:
        // A service is never hard-deleted while a booking references it, so removal is the same
        // switch-off the owner's own delete uses.
        await tx.professionalService.updateMany({
          where: { id: targetId },
          data: { isActive: false },
        });
        break;
      case ReportTargetType.REVIEW:
        await tx.review.updateMany({ where: { id: targetId }, data: now });
        break;
      case ReportTargetType.USER_PROFILE:
        // There is no profile to delete — the member stays. Removing the *content* means clearing
        // the paragraph that was reported, which is what §6.1 scans and what §4.5 holds.
        await tx.userProfile.updateMany({
          where: { id: targetId },
          data: { bio: null, headline: null, canHelpWith: null },
        });
        break;
      case ReportTargetType.MEDIA: {
        // An image with no post of its own, which today means an avatar (§6.1). Removing it is
        // clearing what was on show and then deleting the object: the member keeps their account
        // and loses the photo, which is the whole of the content here.
        const image = await tx.media.findUnique({
          where: { id: targetId },
          select: { ownerId: true, ownerType: true, storageKey: true },
        });

        if (image?.ownerType === AVATAR_MEDIA_OWNER && image.ownerId) {
          await tx.user.updateMany({
            where: { id: image.ownerId, avatarKey: image.storageKey },
            data: { avatarKey: null },
          });
        }

        await tx.media.delete({ where: { id: targetId } }).catch(() => undefined);
        // The verdict goes with the object, for the same reason `releaseOwner` drops it: nothing
        // cascades to a polymorphic table, and a scan of nothing comes back round the sweep.
        await tx.contentSafety.deleteMany({
          where: { targetType: ReportTargetType.MEDIA, targetId },
        });
        break;
      }
      default:
        break;
    }
  }
}
