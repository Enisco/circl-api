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
import { AUDIENCE_FLOOR } from '../dtos/admin-announcement.dto';
import { ANNOUNCEMENT_CATEGORY, AdminAnnouncementService } from './admin-announcement.service';

/** §5.18's batch size. Five hundred recipients resolved and written at a time. */
const BATCH = 500;

/**
 * The states a fan-out will pick up.
 *
 * `FAILED` is here so a failure can be resumed — by BullMQ's own retry, or by a staff member
 * pressing send again. The delivery rows make that safe: they are written before the attempt, so
 * everybody who already has it is skipped.
 */
const RESUMABLE: AnnouncementState[] = [
  AnnouncementState.SENDING,
  AnnouncementState.SCHEDULED,
  AnnouncementState.FAILED,
];

/**
 * Which attempt this is, so only the last one declares the announcement failed.
 *
 * Defaulted to the last attempt: a caller that does not say is a caller with no retry behind it,
 * and leaving a row `SENDING` with nothing coming back for it is the worse mistake.
 */
export interface Attempt {
  last: boolean;
}

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

  async run(announcementId: string, attempt: Attempt = { last: true }): Promise<void> {
    const row = await this.database.announcement.findUnique({ where: { id: announcementId } });

    if (!row) {
      this.logger.warn(`Announcement ${announcementId} is gone; nothing to send.`);

      return;
    }

    /**
     * A delayed job for a schedule that was cancelled, or a retry of one that finished. Either way
     * the state is the control, not the job.
     *
     * `FAILED` is in the list because a failed fan-out has to be resumable: the delivery rows are
     * written before each attempt, so whoever already has it is skipped. It used to be excluded,
     * which made a failure a dead end — the retry found `FAILED` and returned, and the comment
     * claiming "a retry resumes" was describing something that could not happen.
     */
    if (!RESUMABLE.includes(row.state)) {
      this.logger.log(`Announcement ${announcementId} is ${row.state}; not sending.`);

      return;
    }

    const where = await this.announcements.whereFor(row.audience);
    // Counted here as well as at send or schedule time, and this is the figure that counts: for a
    // scheduled announcement the audience was sized days ago, and "who it went to" is who it went
    // to. `stats.targeted` reads this column, so a null here is a stats panel reporting zero.
    const audienceCount = await this.database.user.count({ where });

    /**
     * The floor, again, at the moment it would actually go out (§5.18).
     *
     * Checked when it was scheduled too, but days can pass: an audience narrowed by an edit, or
     * members who left, can take a crowd below ten without anybody pressing anything. Failing with
     * the number in the reason is the honest outcome — the alternative is an announcement to four
     * people that nobody decided to send.
     */
    if (audienceCount < AUDIENCE_FLOOR) {
      await this.database.announcement.update({
        where: { id: announcementId },
        data: {
          state: AnnouncementState.FAILED,
          audienceCount,
          failureReason: `Not sent: the audience is ${audienceCount} ${audienceCount === 1 ? 'person' : 'people'} now, below the floor of ${AUDIENCE_FLOOR}.`,
        },
      });

      this.logger.warn(
        `Announcement ${announcementId} not sent: audience ${audienceCount} is below the floor.`,
      );

      return;
    }

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
      /**
       * `FAILED` only once there are no attempts left.
       *
       * An announcement that silently did not go out is worse than one that visibly did not — but
       * writing `FAILED` on the first of three attempts stopped the other two before they started,
       * because `run` refuses a state it is not expecting. So a middle attempt keeps the row
       * `SENDING` and says what went wrong in `failureReason`, and the last one marks it failed.
       *
       * Re-thrown either way, so BullMQ retries; a retry resumes rather than restarts, because the
       * delivery rows are already there.
       */
      const reason = `Stopped after ${reached} members: ${(error as Error).message}`;

      await this.database.announcement.update({
        where: { id: announcementId },
        data: attempt.last
          ? { state: AnnouncementState.FAILED, failureReason: reason }
          : { failureReason: `${reason} — retrying.` },
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
    const pushing = announcement.channels.includes(AnnouncementChannel.PUSH);
    const [pushAllowed, emailAllowed, withDevice] = await Promise.all([
      this.allowed(ids, 'push'),
      this.allowed(ids, 'email'),
      // One query per batch, not one per member. Without it the push row was marked `SENT` for
      // members with no handset at all, so the stats could report more pushes than the audience
      // preview said were reachable — and `reachable.PUSH` counts devices.
      pushing ? this.devices(ids) : Promise.resolve(new Set<string>()),
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
            /**
             * `raise` writes the feed row, and **pushes only if push was chosen**.
             *
             * The push rides on this row because that is the only path that applies the
             * preference and reaches every handset — but it used to ride on it unconditionally,
             * which made `['IN_APP']` buzz every phone on a body up to five thousand characters,
             * past the five hundred that choosing push would have enforced.
             *
             * Fire-and-forget by design, which is why the delivery row records "we raised it"
             * rather than "the handset showed it" — the second is not something any server can
             * honestly claim.
             */
            this.notifications.raise({
              userId: member.id,
              kind: NotificationKind.ANNOUNCEMENT,
              categoryCode: ANNOUNCEMENT_CATEGORY,
              title: announcement.title,
              body: announcement.body,
              route: announcement.route,
              metadata: { announcementId: announcement.id },
              push: pushing,
            });

            await mark(DeliveryStatus.SENT);

            continue;
          }

          if (channel === AnnouncementChannel.PUSH) {
            /**
             * The row records what actually happened to the push, in the order that matters.
             *
             * Preference first, because a member who turned announcements off was respected
             * rather than failed to (§5.18 counts those separately). Then the handset: no device
             * is a `FAILED` row with a reason, exactly as no email address is on the email
             * channel — the member cannot be pushed to and the file should say why, rather than
             * counting a push that never left the building.
             */
            if (!pushAllowed.has(member.id)) {
              await mark(DeliveryStatus.SKIPPED_PREFERENCE);

              continue;
            }

            if (!withDevice.has(member.id)) {
              await mark(DeliveryStatus.FAILED, { error: 'No push device on the account.' });

              continue;
            }

            await mark(DeliveryStatus.SENT);

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

  /** Who has a handset registered at all, which is what makes a push possible (§5.18). */
  private async devices(ids: string[]): Promise<Set<string>> {
    const rows = await this.database.pushDevice.findMany({
      where: { userId: { in: ids } },
      select: { userId: true },
      distinct: ['userId'],
    });

    return new Set(rows.map(row => row.userId));
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
