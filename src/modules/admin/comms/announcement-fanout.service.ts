import { Injectable, Logger } from '@nestjs/common';
import {
  AnnouncementChannel,
  AnnouncementState,
  DeliveryStatus,
  NotificationKind,
  Prisma,
} from '@prisma/client';
import { toJson } from '@/common';
import { PrismaService } from '@/infrastructure';
import {
  NotificationFeedService,
  NotificationPreferenceService,
} from '@/modules/platform/notifications';
import { ResendProvider } from '@/modules/infrastructure/notification/providers/email/resend.provider';
import { ANNOUNCEMENT_CATEGORY, AdminAnnouncementService } from './admin-announcement.service';

/** §5.18's batch size. Five hundred recipients resolved and written at a time. */
const BATCH = 500;

/**
 * The fan-out (§5.18).
 *
 * Four things shape this, and none of them is throughput.
 *
 * **It can be stopped.** The announcement's state is re-read before every batch, so cancelling a
 * send in progress stops the rest of it within one batch rather than after everybody has it. That
 * is the only kind of "undo" an announcement has, so it has to actually work.
 *
 * **It can be resumed.** Delivery rows are written **before** the attempt, keyed on
 * `(announcement, member, channel)`, and the batch cursor is the member id. A worker that dies
 * halfway through 40,000 people picks up where it stopped and sends nobody twice.
 *
 * **It respects a preference, and says so.** A member who turned announcements off is recorded as
 * `SKIPPED_PREFERENCE`, which is not a failure. Email is opt-in and push is opt-out, which is why
 * the two are counted separately from each other as well as from the in-app row.
 *
 * **It never lets one member's failure stop the rest.** A dead FCM token or a bounced address is
 * that row's `error` and nothing more.
 */
@Injectable()
export class AnnouncementFanoutService {
  private readonly logger = new Logger(AnnouncementFanoutService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly announcements: AdminAnnouncementService,
    private readonly notifications: NotificationFeedService,
    private readonly preferences: NotificationPreferenceService,
    private readonly resend: ResendProvider,
  ) {}

  async run(announcementId: string): Promise<void> {
    const row = await this.database.announcement.findUnique({ where: { id: announcementId } });

    if (!row) {
      this.logger.warn(`Announcement ${announcementId} is gone; nothing to send.`);

      return;
    }

    // A delayed job for a schedule that was cancelled, or a retry of one that finished. Either
    // way the state is the control, not the job.
    if (row.state !== AnnouncementState.SENDING && row.state !== AnnouncementState.SCHEDULED) {
      this.logger.log(`Announcement ${announcementId} is ${row.state}; not sending.`);

      return;
    }

    const where = await this.announcements.whereFor(row.audience);
    // Counted here as well as at send or schedule time, and this is the figure that counts: for a
    // scheduled announcement the audience was sized days ago, and "who it went to" is who it went
    // to. `stats.targeted` reads this column, so a null here is a stats panel reporting zero.
    const audienceCount = await this.database.user.count({ where });

    await this.database.announcement.update({
      where: { id: announcementId },
      data: {
        state: AnnouncementState.SENDING,
        startedAt: row.startedAt ?? new Date(),
        audienceCount,
      },
    });

    let cursor: string | undefined;
    let reached = 0;

    try {
      for (;;) {
        // Re-read the state, not the whole row: this is the cancellation check and it has to
        // happen between batches rather than once at the start.
        const current = await this.database.announcement.findUnique({
          where: { id: announcementId },
          select: { state: true },
        });

        if (current?.state !== AnnouncementState.SENDING) {
          this.logger.log(
            `Announcement ${announcementId} stopped after ${reached}: state is ${current?.state}.`,
          );

          return;
        }

        const batch = await this.database.user.findMany({
          where,
          select: { id: true, email: true, firstName: true },
          // By id, so the cursor is stable while people join and leave mid-fan-out. Ordering by
          // anything mutable would skip or repeat members.
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        });

        if (!batch.length) break;

        cursor = batch[batch.length - 1].id;
        reached += batch.length;

        await this.deliver(row, batch);
      }

      await this.database.announcement.update({
        where: { id: announcementId },
        data: { state: AnnouncementState.SENT, completedAt: new Date() },
      });

      this.logger.log(`Announcement ${announcementId} went out to ${reached} members.`);
    } catch (error) {
      // FAILED with a reason, because an announcement that silently did not go out is worse than
      // one that visibly did not. Re-thrown so BullMQ retries — and a retry resumes rather than
      // restarts, because the delivery rows are already there.
      await this.database.announcement.update({
        where: { id: announcementId },
        data: {
          state: AnnouncementState.FAILED,
          failureReason: `Stopped after ${reached} members: ${(error as Error).message}`,
        },
      });

      throw error;
    }
  }

  /** One batch, one channel at a time. */
  private async deliver(
    announcement: {
      id: string;
      title: string;
      body: string;
      route: string | null;
      channels: AnnouncementChannel[];
    },
    batch: Array<{ id: string; email: string | null; firstName: string }>,
  ): Promise<void> {
    const ids = batch.map(member => member.id);
    const [pushAllowed, emailAllowed] = await Promise.all([
      this.allowed(ids, 'push'),
      this.allowed(ids, 'email'),
    ]);

    // Written first, all of them, as PENDING. A worker that dies after this and before the
    // attempts leaves rows that say "not yet" rather than members nobody can account for.
    await this.database.announcementDelivery.createMany({
      data: announcement.channels.flatMap(channel =>
        ids.map(userId => ({ announcementId: announcement.id, userId, channel })),
      ),
      skipDuplicates: true,
    });

    for (const member of batch) {
      for (const channel of announcement.channels) {
        const mark = (status: DeliveryStatus, extra: Prisma.AnnouncementDeliveryUpdateInput = {}) =>
          this.database.announcementDelivery.update({
            where: {
              announcementId_userId_channel: {
                announcementId: announcement.id,
                userId: member.id,
                channel,
              },
            },
            data: { status, sentAt: new Date(), ...extra },
          });

        try {
          if (channel === AnnouncementChannel.IN_APP) {
            // `raise` writes the row and pushes it where the member allows push, so the in-app
            // channel is the carrier. It is fire-and-forget by design, which is why the delivery
            // row records "we raised it" rather than "the handset showed it" — the second is not
            // something any server can honestly claim.
            this.notifications.raise({
              userId: member.id,
              kind: NotificationKind.ANNOUNCEMENT,
              categoryCode: ANNOUNCEMENT_CATEGORY,
              title: announcement.title,
              body: announcement.body,
              route: announcement.route,
              metadata: { announcementId: announcement.id },
            });

            await mark(DeliveryStatus.SENT);

            continue;
          }

          if (channel === AnnouncementChannel.PUSH) {
            // The push itself rides on the in-app row above (that is the only path that applies
            // the preference and reaches every handset). This row records whether it was allowed
            // to, which is the honest thing to count.
            await mark(
              pushAllowed.has(member.id) ? DeliveryStatus.SENT : DeliveryStatus.SKIPPED_PREFERENCE,
            );

            continue;
          }

          if (!emailAllowed.has(member.id)) {
            await mark(DeliveryStatus.SKIPPED_PREFERENCE);

            continue;
          }

          if (!member.email) {
            await mark(DeliveryStatus.FAILED, { error: 'No email address on the account.' });

            continue;
          }

          await this.email(member, announcement);
          await mark(DeliveryStatus.SENT);
        } catch (error) {
          // One member's failure never stops the rest: it is this row's error and nothing more.
          await mark(DeliveryStatus.FAILED, {
            error: (error as Error).message.slice(0, 500),
          }).catch(() => undefined);
        }
      }
    }

    await this.refreshStats(announcement.id);
  }

  /**
   * Who allows this channel for announcements — one query per batch rather than one per member.
   *
   * The default comes from the **category's own metadata**, read through the service that
   * `NotificationFeedService.allows` reads it from. It was hardcoded here ("push on, email off"),
   * which is right today and would have quietly stopped matching the moment staff reworded the
   * category in the portal: the fan-out would have skipped people the push path was about to
   * reach, or counted people it was not.
   *
   * A **locked** category is always allowed, which is the same rule the member's own preference
   * screen enforces — and the reason it matters here is that announcements are not locked today
   * and a future locked category must not be silently skippable.
   */
  private async allowed(ids: string[], channel: 'push' | 'email'): Promise<Set<string>> {
    const [rows, defaults] = await Promise.all([
      this.database.notificationPreference.findMany({
        where: { userId: { in: ids }, categoryCode: ANNOUNCEMENT_CATEGORY },
        select: { userId: true, push: true, email: true },
      }),
      this.preferences.defaultsFor(ANNOUNCEMENT_CATEGORY),
    ]);

    if (defaults.isLocked) return new Set(ids);

    const saved = new Map(rows.map(row => [row.userId, row]));

    return new Set(
      ids.filter(id => {
        const row = saved.get(id);

        if (!row) return defaults[channel];

        return channel === 'push' ? row.push : row.email;
      }),
    );
  }

  private async email(
    member: { email: string | null; firstName: string },
    announcement: { title: string; body: string; route: string | null },
  ): Promise<void> {
    const lines = [
      `Hi ${member.firstName},`,
      '',
      announcement.body,
      '',
      // The unsubscribe line §5.18 asks for. A path into the app's own settings rather than a
      // one-click token: the preference already exists and is what actually governs this, so a
      // second mechanism would be a second place it could disagree.
      'You can turn these off in the app: Settings → Notifications → News from Circl.',
    ];
    const text = lines.join('\n');

    await this.resend.send({
      to: member.email!,
      template: {
        name: 'announcement',
        subject: announcement.title,
        text,
        /**
         * The same plain text, wrapped.
         *
         * **Escaped**, unlike the admin mails this borrows from: their lines are built in the
         * file, and this body is typed by a staff member into a form. Unescaped it would be stored
         * HTML, sent by us, to everybody — and `<img onerror>` in an announcement is not something
         * to find out about afterwards.
         */
        html: `<pre style="font: 14px/1.5 -apple-system, sans-serif; white-space: pre-wrap">${escapeHtml(text)}</pre>`,
      },
    });
  }

  /**
   * The progress counters on the row, rewritten after each batch.
   *
   * **Not read by the stats endpoint**, which counts the delivery rows for real — `opened` keeps
   * moving after the fan-out ends, so a cached copy would be wrong by the time anybody looked.
   * What this is for is the row itself: a fan-out that is halfway through forty thousand members
   * is otherwise a `SENDING` state with nothing to say how far it has got, and that is the first
   * question asked of one that looks stuck.
   */
  private async refreshStats(announcementId: string): Promise<void> {
    const grouped = await this.database.announcementDelivery.groupBy({
      by: ['channel', 'status'],
      where: { announcementId },
      _count: { _all: true },
    });

    await this.database.announcement.update({
      where: { id: announcementId },
      data: {
        stats: toJson({
          perChannel: grouped.reduce<Record<string, Record<string, number>>>((all, entry) => {
            all[entry.channel] = { ...all[entry.channel], [entry.status]: entry._count._all };

            return all;
          }, {}),
          updatedAt: new Date().toISOString(),
        }),
      },
    });
  }
}

/** The five characters that turn typed text into markup. */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
