import { Injectable, Logger } from '@nestjs/common';
import { DevicePlatform } from '@prisma/client';
import { CacheService, PrismaService } from '@/infrastructure';
import { londonCalendarDay } from '@/common';

/**
 * How long one record of "they were here" stands for.
 *
 * Fifteen minutes. Nothing this feeds can tell the difference — active in the last seven days, a
 * staff member asking when somebody was last seen, a day marked present — and the alternative is a
 * write on every request, which makes reading the feed a write and makes the busiest member the
 * most expensive one.
 */
const GATE_SECONDS = 15 * 60;

@Injectable()
export class MemberActivityService {
  private readonly logger = new Logger(MemberActivityService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Notes that a member was here, at most once per gate window.
   *
   * Two writes behind one gate: the member's own `lastActiveAt`, and a row for the London day.
   * The daily row is where every active-user number comes from, and it has to be written as it
   * happens — a day somebody was present cannot be reconstructed afterwards from a single
   * "last seen" column, and the activity stream only holds the days they did something
   * deliberate rather than the days they looked.
   *
   * Fire and forget by design: this is a side effect of a request that has its own job to do, and
   * a failure here must not fail that request. A gap in the analytics is a worse outcome than no
   * gap, but a 500 on the feed because a statistic could not be written is worse than both.
   */
  record(input: {
    userId: string;
    platform?: DevicePlatform | null;
    appVersion?: string | null;
    cityId?: string | null;
  }): void {
    void this.run(input).catch(error =>
      this.logger.warn({
        event: 'member_activity_not_recorded',
        userId: input.userId,
        message: (error as Error).message,
      }),
    );
  }

  private async run(input: {
    userId: string;
    platform?: DevicePlatform | null;
    appVersion?: string | null;
    cityId?: string | null;
  }): Promise<void> {
    // The gate and the claim are the same operation: whoever sets the key does the writing, and
    // everybody else in the window does nothing. Reading then writing would let two concurrent
    // requests both decide they were first.
    const claimed = await this.cache.setIfAbsent(
      `user:active:${input.userId}`,
      1,
      GATE_SECONDS * 1000,
    );

    if (!claimed) return;

    const now = new Date();
    // Read here rather than taken from the request. The member strategy does not load the profile
    // — it has no reason to — so reading `user.profile.cityId` off the authenticated user gave
    // undefined on every request, and every row the live gate wrote had no city at all. Looked up
    // at the moment of writing instead: that is once every fifteen minutes per member, against
    // a joined column on every request, and it is the difference between a city snapshot and an
    // empty column nobody notices until a chart is built on it.
    const cityId = input.cityId ?? (await this.cityOf(input.userId));

    await Promise.all([
      this.database.user.update({
        where: { id: input.userId },
        data: {
          lastActiveAt: now,
          // The platform and build they are on *now*, which is a different question from the one
          // the session rows answer. A session lives thirty days, so "what is this member using"
          // read off the newest session is the build they installed a month ago; this gate sees
          // every fifteen minutes of real use and costs nothing extra, because the row is already
          // being written.
          ...(input.platform ? { lastPlatform: input.platform } : {}),
          ...(input.appVersion ? { lastAppVersion: input.appVersion } : {}),
        },
      }),
      // `ON CONFLICT DO NOTHING`, so the first visit of the day wins and keeps its own
      // `firstSeenAt`, platform and city. A later visit the same day must not overwrite them —
      // the row is a record of that day, not of the most recent moment in it.
      this.database.userDailyActivity.createMany({
        data: [
          {
            userId: input.userId,
            day: londonCalendarDay(now),
            firstSeenAt: now,
            platform: input.platform ?? null,
            appVersion: input.appVersion ?? null,
            cityId,
          },
        ],
        skipDuplicates: true,
      }),
    ]);
  }

  /** Where they are today, which is what the day's row is a snapshot of. */
  private async cityOf(userId: string): Promise<string | null> {
    const profile = await this.database.userProfile.findUnique({
      where: { userId },
      select: { cityId: true },
    });

    return profile?.cityId ?? null;
  }
}
