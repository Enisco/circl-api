import { Injectable, Logger } from '@nestjs/common';
import {
  AnnouncementChannel,
  AnnouncementState,
  DeliveryStatus,
  Prisma,
  UserAccountStatus,
} from '@prisma/client';
import { ApiErrorCode, ApiException, buildPageMeta, toJson } from '@/common';
import { PrismaService } from '@/infrastructure';
import { MediaService } from '@/modules/platform/shared';
import { NotificationPreferenceService } from '@/modules/platform/notifications';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../common/admin-principal';
import { MemberFilterBuilder } from '../filters/member-filter.builder';
import { POPULATION_FLOOR } from '../analytics/suppression';
import { StaffRefView, staffRefSelect, toStaffRef } from '../serializers/admin-staff.serializer';
import {
  AUDIENCE_FLOOR,
  AnnouncementAudienceDto,
  AnnouncementInputDto,
  AudienceSection,
  BODY_MAX,
  ListAnnouncementsDto,
  PUSH_BODY_MAX,
  ScheduleAnnouncementDto,
  SendAnnouncementDto,
  UpdateAnnouncementDto,
} from '../dtos/admin-announcement.dto';
import { MAX_SCHEDULE_DAYS, MIN_SCHEDULE_MINUTES, AnnouncementQueue } from './announcement.queue';
import { isAllowedRoute } from './app-routes';

/** How far the count may move between the preview somebody read and the send they pressed. */
const STALE_AUDIENCE_TOLERANCE = 0.05;

/** The states an announcement can still be edited or sent from. */
const EDITABLE: AnnouncementState[] = [AnnouncementState.DRAFT, AnnouncementState.SCHEDULED];

/** The preference category every announcement sits in (§6.1.3). */
export const ANNOUNCEMENT_CATEGORY = 'ANNOUNCEMENTS';

export interface ChannelStats {
  sent: number;
  delivered: number;
  failed: number;
  skippedPreference: number;
  opened: number | null;
}

export interface AnnouncementStatsView {
  targeted: number;
  perChannel: Record<string, ChannelStats>;
  updatedAt: string;
}

/**
 * §5.18: one message from Circl to many members.
 *
 * The most consequential write in the portal after a suspension, and the only one whose mistakes
 * are unrecoverable — a message is on thousands of phones the moment it goes, and there is no
 * unsend. So the shape of this is built around the four ways that goes wrong:
 *
 *  - **Addressing more people than you meant.** `everyone: true` is required to send with no
 *    filter, because an empty filter must not mean the whole platform by default. And the sender
 *    confirms the count they were shown: if a fresh count has moved by more than 5%, the send is
 *    refused rather than delivered to a population nobody looked at.
 *  - **Addressing almost nobody.** Under ten recipients is refused outright (§2.7's floor applied
 *    to an act rather than a chart): an "announcement" to four people is a message, and a message
 *    should be sent as one.
 *  - **Sending somewhere nobody meant.** The deep link is an allowlisted pattern, never a URL.
 *  - **Sending it twice.** The delivery row's key is `(announcement, member, channel)` and the
 *    worker writes it before attempting, so a resumed fan-out skips whoever it already reached.
 *
 * Suspended members are excluded, which the shared population rule does not do on its own: being
 * suspended and still receiving "News from Circl" is the platform talking past its own decision.
 */
@Injectable()
export class AdminAnnouncementService {
  private readonly logger = new Logger(AdminAnnouncementService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly filters: MemberFilterBuilder,
    private readonly preferences: NotificationPreferenceService,
    private readonly queue: AnnouncementQueue,
    private readonly audit: AuditService,
  ) {}

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async list(query: ListAnnouncementsDto) {
    query.assertDepth();

    const where: Prisma.AnnouncementWhereInput = {
      ...(query.state?.length ? { state: { in: query.state } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await this.database.$transaction([
      this.database.announcement.count({ where }),
      this.database.announcement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.currentPage - 1) * query.size,
        take: query.size,
      }),
    ]);

    const staff = await this.staffFor(rows.flatMap(row => [row.createdById, row.sentById]));

    return {
      data: rows.map(row => this.toRow(row, staff)),
      meta: buildPageMeta({ currentPage: query.currentPage, perPage: query.size }, total),
    };
  }

  async detail(id: string) {
    const row = await this.database.announcement.findUnique({ where: { id } });

    if (!row) throw ApiException.notFound('No such announcement.');

    const staff = await this.staffFor([row.createdById, row.sentById]);

    return {
      ...this.toRow(row, staff),
      body: row.body,
      route: row.route,
      audience: row.audience,
      stats: await this.stats(row),
      failureReason: row.failureReason,
    };
  }

  /**
   * §5.18's stats, counted from the delivery rows.
   *
   * **Counted while there are rows to count**, and never from the fan-out's progress cache. The
   * comment here once claimed the column was read and it was not — the worker maintains
   * `announcements.stats` as batches land, which is the kind of half-wired cache that later gets
   * trusted. The one thing on that column this *does* read is the figure retention freezes there
   * when the rows are deleted, which is a different fact and carries a flag saying so.
   *
   * Counting is the right answer: the group-by is over `(announcement_id, status)`, which is
   * indexed, so it is cheap even at forty thousand rows — and `opened` keeps moving for days after
   * the last batch, because it is the member reading the notification rather than anything the
   * fan-out did. A cached `opened` would be wrong by the time anybody looked at it.
   *
   * The column stays because §5.18 names it, because it is the one place a fan-out's progress is
   * visible while it runs — to somebody looking at the row rather than calling the endpoint — and
   * because of the one case where counting is not possible at all, below.
   */
  async stats(row: {
    id: string;
    channels: AnnouncementChannel[];
    audienceCount: number | null;
    state: AnnouncementState;
    stats?: Prisma.JsonValue | null;
  }): Promise<AnnouncementStatsView | null> {
    if (row.state === AnnouncementState.DRAFT || row.state === AnnouncementState.SCHEDULED) {
      return null;
    }

    /**
     * Unless the rows it would count are gone.
     *
     * §13.6 keeps delivery rows a year and the announcement's stats for ever, which is only
     * possible if the figures are written down before the rows go: `retention.purge` freezes them
     * onto this column with `final: true`, and from then on this is the answer. Without it a
     * year-old announcement would report zeros the day after the purge ran — a send to forty
     * thousand people, recorded as having reached nobody.
     */
    const frozen = finalStats(row.stats);

    if (frozen) return frozen;

    const grouped = await this.database.announcementDelivery.groupBy({
      by: ['channel', 'status'],
      where: { announcementId: row.id },
      _count: { _all: true },
    });

    const opened = await this.database.announcementDelivery.groupBy({
      by: ['channel'],
      where: { announcementId: row.id, openedAt: { not: null } },
      _count: { _all: true },
    });
    const openedByChannel = new Map(opened.map(entry => [entry.channel, entry._count._all]));

    const perChannel: Record<string, ChannelStats> = {};

    for (const channel of row.channels) {
      const of = (status: DeliveryStatus) =>
        grouped.find(entry => entry.channel === channel && entry.status === status)?._count._all ??
        0;

      perChannel[channel] = {
        // Attempted: everything that is not still pending and not skipped.
        sent: of(DeliveryStatus.SENT) + of(DeliveryStatus.FAILED),
        delivered: of(DeliveryStatus.SENT),
        failed: of(DeliveryStatus.FAILED),
        // Its own figure, never folded into `failed`: a member who turned announcements off was
        // respected, not failed to, and counting the two together makes a working fan-out look
        // broken.
        skippedPreference: of(DeliveryStatus.SKIPPED_PREFERENCE),
        // Null for EMAIL on purpose (§4.10's Decision): email opens need a tracking pixel, and
        // one of those on a message to every member is surveillance the product does not do.
        opened: channel === AnnouncementChannel.EMAIL ? null : (openedByChannel.get(channel) ?? 0),
      };
    }

    return {
      targeted: row.audienceCount ?? 0,
      perChannel,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Writes the figures down, because the rows behind them are about to be deleted (§13.6).
   *
   * Called by `retention.purge` **before** it removes a year-old announcement's deliveries, while
   * there is still something to count. `final: true` is what tells `stats` to stop counting and
   * read this instead; the fan-out's progress cache in the same column carries no such flag, so a
   * send in flight is never mistaken for a finished one.
   *
   * `opened` stops moving at this point, which is the whole point of freezing: an open recorded on
   * a year-old announcement after its rows are gone is a number nobody can reconstruct anyway.
   */
  async freezeStats(id: string): Promise<AnnouncementStatsView | null> {
    const row = await this.database.announcement.findUnique({
      where: { id },
      select: { id: true, channels: true, audienceCount: true, state: true, stats: true },
    });

    if (!row) return null;

    /**
     * Frozen once, and never refrozen.
     *
     * A fan-out that ran across two days has deliveries of two ages, so the purge can reach it on
     * two separate nights. The first freeze happens while *every* row is still there and is
     * therefore the complete figure; a second one would count what was left after the first delete
     * and overwrite forty thousand with forty. Keeping the first is keeping the true one.
     */
    const frozen = finalStats(row.stats);

    if (frozen) return frozen;

    const view = await this.stats({ ...row, stats: null });

    if (!view) return null;

    await this.database.announcement.update({
      where: { id },
      data: { stats: toJson({ ...view, final: true }) },
    });

    return view;
  }

  // ─── Audience ──────────────────────────────────────────────────────────────

  /**
   * How many people this would reach, per channel, before anybody sends it.
   *
   * `members` is the audience; `reachable` is how many of them each channel can actually land on —
   * push needs a device and the member's permission, and email is **opt-in** (the `ANNOUNCEMENTS`
   * category defaults to push on, email off). Showing one number for "audience" and letting
   * somebody assume the email went to all of them is the misunderstanding this exists to prevent.
   *
   * Counts below ten come back null with `suppressed: true`, as every other count in the portal
   * does (§2.7).
   */
  async preview(audience: AnnouncementAudienceDto, channels: AnnouncementChannel[]) {
    const where = await this.audienceWhere(audience);
    const members = await this.database.user.count({ where });
    const suppressed = members > 0 && members < POPULATION_FLOOR;

    const reachable: Record<string, number | null> = {};

    for (const channel of channels) {
      if (suppressed) {
        reachable[channel] = null;

        continue;
      }

      reachable[channel] = await this.database.user.count({
        where: { ...where, ...(await this.channelWhere(channel)) },
      });
    }

    return {
      members: suppressed ? null : members,
      suppressed,
      reachable,
    };
  }

  /**
   * The audience, as a query.
   *
   * Three things on top of the shared filter, and each is a decision:
   *
   *  - **No default date range.** Every analytics endpoint imposes thirty days; here that would
   *    mean "everyone" quietly meaning "everyone who joined this month".
   *  - **`from`/`to` are the sign-up date**, as on the member list.
   *  - **Suspended members are excluded.** The shared population rule drops staff, anonymised and
   *    deleted accounts, and leaves suspended ones in — right for a chart about the platform,
   *    wrong for a message from it.
   */
  private async audienceWhere(audience: AnnouncementAudienceDto): Promise<Prisma.UserWhereInput> {
    const hasFilter = narrowsAudience(audience);

    if (!audience.everyone && !hasFilter) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Say who this is for: a filter, or `everyone: true`.',
        { details: [{ field: 'audience', message: 'A filter or everyone: true is required.' }] },
      );
    }

    const resolved = await this.filters.resolve(audience.filter ?? {}, {
      defaultRange: false,
      dateField: 'createdAt',
    });

    return {
      ...resolved.where,
      status: { not: UserAccountStatus.SUSPENDED },
      ...(audience.sections?.length ? { OR: audience.sections.map(sectionWhere) } : {}),
    };
  }

  /**
   * What a channel needs to be able to land on somebody.
   *
   * The clause depends on the category's **default**, which is why it is read rather than assumed:
   * a default-on channel is "no row saying no" and a default-off one is "a row saying yes", and
   * those are different queries. The first version hardcoded push-on and email-off — right today,
   * and silently wrong the moment staff reword the category in the portal, which would have made
   * the preview disagree with the fan-out about who is reachable.
   */
  private async channelWhere(channel: AnnouncementChannel): Promise<Prisma.UserWhereInput> {
    if (channel === AnnouncementChannel.IN_APP) {
      // A notification row is always written, so everybody in the audience is reachable in-app.
      return {};
    }

    const defaults = await this.preferences.defaultsFor(ANNOUNCEMENT_CATEGORY);

    // A locked category cannot be turned off by anybody, so everybody allows it.
    const permission: Prisma.UserWhereInput = defaults.isLocked
      ? {}
      : channel === AnnouncementChannel.PUSH
        ? defaults.push
          ? {
              notificationPreferences: {
                none: { categoryCode: ANNOUNCEMENT_CATEGORY, push: false },
              },
            }
          : {
              notificationPreferences: {
                some: { categoryCode: ANNOUNCEMENT_CATEGORY, push: true },
              },
            }
        : defaults.email
          ? {
              notificationPreferences: {
                none: { categoryCode: ANNOUNCEMENT_CATEGORY, email: false },
              },
            }
          : {
              notificationPreferences: {
                some: { categoryCode: ANNOUNCEMENT_CATEGORY, email: true },
              },
            };

    // A push also needs a handset. An email needs an address, which every account has.
    return channel === AnnouncementChannel.PUSH
      ? { ...permission, pushDevices: { some: {} } }
      : permission;
  }

  /** The audience as a `where`, for the worker. Public so the fan-out resolves it the same way. */
  async whereFor(audience: unknown): Promise<Prisma.UserWhereInput> {
    return this.audienceWhere(audience as AnnouncementAudienceDto);
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  async create(actor: AdminPrincipal, dto: AnnouncementInputDto) {
    this.assertSendable(dto.body, dto.channels, dto.route);
    // Resolved now as well as at send time, so a filter that cannot be resolved is a 400 on the
    // draft rather than a failure nobody sees until the fan-out runs.
    await this.audienceWhere(dto.audience);

    const { result } = await this.audit.mutate(
      (created: { id: string }) => ({
        action: 'announcement.created' as const,
        targetType: 'ANNOUNCEMENT' as const,
        targetId: created.id,
        targetLabel: dto.title,
        after: { title: dto.title, channels: dto.channels, audience: dto.audience },
      }),
      tx =>
        tx.announcement.create({
          data: {
            title: dto.title,
            body: dto.body,
            route: dto.route ?? null,
            channels: dto.channels,
            audience: toJson(dto.audience),
            createdById: actor.id,
          },
        }),
    );

    return this.detail(result.id);
  }

  async update(actor: AdminPrincipal, id: string, dto: UpdateAnnouncementDto) {
    const row = await this.live(id);

    const channels = dto.channels ?? row.channels;
    const body = dto.body ?? row.body;
    const route = dto.route === undefined ? row.route : dto.route;

    this.assertSendable(body, channels, route ?? undefined);

    if (dto.audience) await this.audienceWhere(dto.audience);

    await this.audit.mutate(
      {
        action: 'announcement.updated' as const,
        targetType: 'ANNOUNCEMENT' as const,
        targetId: id,
        targetLabel: dto.title ?? row.title,
        before: { title: row.title, channels: row.channels, audience: row.audience },
        after: { title: dto.title ?? row.title, channels, audience: dto.audience ?? row.audience },
      },
      tx =>
        tx.announcement.update({
          where: { id },
          data: {
            ...(dto.title ? { title: dto.title } : {}),
            ...(dto.body ? { body: dto.body } : {}),
            ...(dto.route === undefined ? {} : { route: dto.route }),
            ...(dto.channels ? { channels: dto.channels } : {}),
            ...(dto.audience ? { audience: toJson(dto.audience) } : {}),
          },
        }),
    );

    return this.detail(id);
  }

  /** §5.18: the audience is counted fresh, and the sender's number has to still be right. */
  async send(actor: AdminPrincipal, id: string, dto: SendAnnouncementDto) {
    const row = await this.live(id);

    this.assertSendable(row.body, row.channels, row.route ?? undefined);

    const where = await this.audienceWhere(row.audience as unknown as AnnouncementAudienceDto);
    const count = await this.database.user.count({ where });

    if (count < AUDIENCE_FLOOR) {
      throw ApiException.unprocessable(
        ApiErrorCode.AUDIENCE_TOO_SMALL,
        `That reaches ${count} ${count === 1 ? 'person' : 'people'}. An announcement is for a crowd — send a message instead.`,
        { data: { members: count, floor: AUDIENCE_FLOOR } },
      );
    }

    // ±5%: the filter is evaluated twice, minutes apart, and members join and leave in between.
    // The tolerance is there so an ordinary drift does not block a send, and the refusal is there
    // so a *meaningful* change does — somebody who read "1,200 people" must not reach 12,000.
    const drift = Math.abs(count - dto.confirmAudienceCount) / Math.max(count, 1);

    if (drift > STALE_AUDIENCE_TOLERANCE) {
      throw ApiException.conflict(
        ApiErrorCode.STALE_AUDIENCE,
        `The audience is ${count} now, not ${dto.confirmAudienceCount}. Check who this is going to and send again.`,
        { data: { members: count, confirmed: dto.confirmAudienceCount } },
      );
    }

    await this.audit.mutate(
      {
        action: 'announcement.sent' as const,
        targetType: 'ANNOUNCEMENT' as const,
        targetId: id,
        targetLabel: row.title,
        before: { state: row.state },
        after: { state: AnnouncementState.SENDING, audienceCount: count },
        metadata: { channels: row.channels, confirmed: dto.confirmAudienceCount },
      },
      tx =>
        tx.announcement.update({
          where: { id },
          data: {
            state: AnnouncementState.SENDING,
            audienceCount: count,
            sentById: actor.id,
            startedAt: new Date(),
            scheduledAt: null,
          },
        }),
    );

    // After the row says SENDING, so a queue that is down leaves an announcement visibly stuck
    // rather than one that looks like a draft and has already been audited as sent.
    await this.queue.enqueue(id);

    return this.detail(id);
  }

  async schedule(actor: AdminPrincipal, id: string, dto: ScheduleAnnouncementDto) {
    const row = await this.live(id);

    this.assertSendable(row.body, row.channels, row.route ?? undefined);

    const when = new Date(dto.scheduledAt);
    const earliest = Date.now() + MIN_SCHEDULE_MINUTES * 60_000;
    const latest = Date.now() + MAX_SCHEDULE_DAYS * 86_400_000;

    if (when.getTime() < earliest) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        `Schedule it at least ${MIN_SCHEDULE_MINUTES} minutes out, so it can still be cancelled.`,
        { details: [{ field: 'scheduledAt', message: 'Too soon.' }] },
      );
    }

    if (when.getTime() > latest) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        `Schedule it within ${MAX_SCHEDULE_DAYS} days.`,
        { details: [{ field: 'scheduledAt', message: 'Too far out.' }] },
      );
    }

    // Counted now, so a schedule over four people is refused when it is set rather than at 3am
    // when it fires and nobody is watching.
    const count = await this.database.user.count({
      where: await this.audienceWhere(row.audience as unknown as AnnouncementAudienceDto),
    });

    if (count < AUDIENCE_FLOOR) {
      throw ApiException.unprocessable(
        ApiErrorCode.AUDIENCE_TOO_SMALL,
        `That reaches ${count} ${count === 1 ? 'person' : 'people'} today. An announcement is for a crowd.`,
        { data: { members: count, floor: AUDIENCE_FLOOR } },
      );
    }

    await this.audit.mutate(
      {
        action: 'announcement.scheduled' as const,
        targetType: 'ANNOUNCEMENT' as const,
        targetId: id,
        targetLabel: row.title,
        before: { state: row.state, scheduledAt: row.scheduledAt?.toISOString() ?? null },
        after: { state: AnnouncementState.SCHEDULED, scheduledAt: when.toISOString() },
      },
      tx =>
        tx.announcement.update({
          where: { id },
          data: {
            state: AnnouncementState.SCHEDULED,
            scheduledAt: when,
            sentById: actor.id,
            // Stored, not just checked. It was only written by `send`, so a **scheduled**
            // announcement reached SENT with a null count and its stats reported `targeted: 0`
            // forever — the number was computed right here for the floor check and then thrown
            // away. The fan-out refreshes it when it actually runs, because the audience two days
            // from now is not this one.
            audienceCount: count,
          },
        }),
    );

    // Re-queued, which replaces an earlier delayed job for the same id: rescheduling twice must
    // not leave the first time still armed.
    await this.queue.cancel(id);
    await this.queue.enqueue(id, when);

    return this.detail(id);
  }

  /**
   * Stops a schedule, or a fan-out between batches.
   *
   * A `SENDING` announcement is not unsent — whoever has already received it has received it — and
   * the response says so by leaving the delivery rows alone. What cancelling does is stop the rest.
   */
  async cancel(actor: AdminPrincipal, id: string) {
    const row = await this.database.announcement.findUnique({ where: { id } });

    if (!row) throw ApiException.notFound('No such announcement.');

    const stoppable: AnnouncementState[] = [AnnouncementState.SCHEDULED, AnnouncementState.SENDING];

    if (!stoppable.includes(row.state)) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        row.state === AnnouncementState.SENT
          ? 'That has gone out. There is no unsend.'
          : `A ${row.state.toLowerCase()} announcement has nothing to cancel.`,
        { data: { state: row.state } },
      );
    }

    await this.audit.mutate(
      {
        action: 'announcement.cancelled' as const,
        targetType: 'ANNOUNCEMENT' as const,
        targetId: id,
        targetLabel: row.title,
        before: { state: row.state },
        after: { state: AnnouncementState.CANCELLED },
        // The honest detail: a cancelled fan-out had already reached people, and how many is the
        // first thing anybody asks.
        metadata: {
          alreadyDelivered: await this.database.announcementDelivery.count({
            where: { announcementId: id, status: DeliveryStatus.SENT },
          }),
        },
      },
      tx =>
        tx.announcement.update({
          where: { id },
          data: { state: AnnouncementState.CANCELLED, cancelledAt: new Date() },
        }),
    );

    await this.queue.cancel(id);

    return this.detail(id);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async live(id: string) {
    const row = await this.database.announcement.findUnique({ where: { id } });

    if (!row) throw ApiException.notFound('No such announcement.');

    if (!EDITABLE.includes(row.state)) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        row.state === AnnouncementState.SENT
          ? 'That has gone out. Write a new one rather than editing it.'
          : `A ${row.state.toLowerCase()} announcement cannot be changed.`,
        { data: { state: row.state } },
      );
    }

    return row;
  }

  /** The three rules that have to hold before anything can go out. */
  private assertSendable(body: string, channels: AnnouncementChannel[], route?: string): void {
    const pushing = channels.includes(AnnouncementChannel.PUSH);
    const limit = pushing ? PUSH_BODY_MAX : BODY_MAX;

    if (body.length > limit) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        pushing
          ? `With push selected the body has to be ${PUSH_BODY_MAX} characters or fewer — the OS cuts off the rest, and a message nobody can finish reading is not one.`
          : `The body has to be ${BODY_MAX} characters or fewer.`,
        { details: [{ field: 'body', message: `${body.length} characters, limit ${limit}.` }] },
      );
    }

    if (route && !isAllowedRoute(route)) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        `"${route}" is not a screen an announcement may link to. Pick one from admin/meta/app-routes.`,
        { details: [{ field: 'route', message: 'Not an allowlisted app route.' }] },
      );
    }
  }

  private async staffFor(ids: Array<string | null>) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];

    if (!wanted.length) return new Map<string, StaffRefView>();

    const rows = await this.database.user.findMany({
      where: { id: { in: wanted } },
      select: staffRefSelect,
    });

    return new Map(rows.map(row => [row.id, toStaffRef(row, this.media.sign)]));
  }

  private toRow(
    row: {
      id: string;
      title: string;
      channels: AnnouncementChannel[];
      state: AnnouncementState;
      audienceCount: number | null;
      scheduledAt: Date | null;
      completedAt: Date | null;
      createdById: string;
      sentById: string | null;
      createdAt: Date;
    },
    staff: Map<string, StaffRefView>,
  ) {
    return {
      id: row.id,
      title: row.title,
      channels: row.channels,
      state: row.state,
      audienceCount: row.audienceCount,
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdBy: staff.get(row.createdById) ?? null,
      sentBy: row.sentById ? (staff.get(row.sentById) ?? null) : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * Every member-filter key an audience may narrow on.
 *
 * Listed rather than read off the DTO's own `hasMemberAttributeFilters` getter, and that is a fix
 * for a real bug rather than a style choice: the audience is stored as **JSON** and read back as a
 * plain object with no prototype, so the getter was `undefined` on every send and schedule — which
 * made a perfectly good announcement refuse itself with "say who this is for". The create path
 * passed because it still had the class instance, which is exactly why it went unnoticed.
 */
const AUDIENCE_FILTER_KEYS = [
  'cityIds',
  'gender',
  'ageBands',
  'countriesOfOrigin',
  'heritage',
  'journeyStages',
  'interests',
  'languages',
  'platforms',
  'appVersions',
  'signupMethods',
  'statuses',
] as const;

/** Whether an audience narrows the population at all — on a DTO or on a row read back from JSON. */
const narrowsAudience = (audience: AnnouncementAudienceDto): boolean => {
  const filter = (audience.filter ?? {}) as Record<string, unknown>;

  if (AUDIENCE_FILTER_KEYS.some(key => (filter[key] as unknown[] | undefined)?.length)) return true;
  if (filter.onboarding !== undefined) return true;
  if (filter.from || filter.to) return true;

  return Boolean(audience.sections?.length);
};

/** "Has that side of the product set up", per section. */
const sectionWhere = (section: AudienceSection): Prisma.UserWhereInput => {
  if (section === 'PROFESSIONAL') return { professionalListing: { isNot: null } };
  if (section === 'CONNECT') return { connectProfile: { isNot: null } };

  return { store: { isNot: null } };
};

/**
 * The figures `retention.purge` wrote down, if it has.
 *
 * `announcements.stats` holds two different things: the fan-out's progress while it runs, and —
 * once the delivery rows are past their year and gone — the final figures, flagged. Only the
 * flagged form is served, because the other one is a snapshot of a send in flight and the
 * endpoint can always count that for real.
 */
const finalStats = (stored: Prisma.JsonValue | null | undefined): AnnouncementStatsView | null => {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;

  const held = stored as Record<string, unknown>;

  if (held.final !== true) return null;

  return {
    targeted: typeof held.targeted === 'number' ? held.targeted : 0,
    perChannel: (held.perChannel ?? {}) as AnnouncementStatsView['perChannel'],
    updatedAt: typeof held.updatedAt === 'string' ? held.updatedAt : new Date().toISOString(),
  };
};
