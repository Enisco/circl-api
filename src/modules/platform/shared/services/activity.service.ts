import { Injectable } from '@nestjs/common';
import { ActivitySubject, ActivityVerb } from '@prisma/client';
import { CacheService, PrismaService } from '@/infrastructure';
import { toJsonOrUndefined } from '@/common';

export interface ActivityInput {
  userId?: string | null;
  verb: ActivityVerb;
  subject: ActivitySubject;
  subjectId?: string | null;
  cityId?: string | null;
  code?: string | null;
  term?: string | null;
  weight?: number;
  metadata?: Record<string, unknown>;
}

/**
 * The feed into Circl Intelligence.
 *
 * "One algorithm, fed by every action taken on the platform — every search, post,
 * click, engagement, and transaction." This service is that recording, and it is
 * deliberately fire-and-forget: a failure to write a behavioural event must never
 * fail the request that produced it. A member's post succeeding matters more than
 * our analytics being complete.
 */
@Injectable()
export class ActivityService {
  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /** Records an event without blocking or failing the caller. */
  record(input: ActivityInput): void {
    void this.database.activityEvent
      .create({
        data: {
          userId: input.userId ?? null,
          verb: input.verb,
          subject: input.subject,
          subjectId: input.subjectId ?? null,
          cityId: input.cityId ?? null,
          code: input.code ?? null,
          term: input.term ? input.term.trim().toLowerCase().slice(0, 120) : null,
          weight: input.weight ?? 1,
          metadata: toJsonOrUndefined(input.metadata),
        },
      })
      .catch(() => undefined);
  }

  /**
   * Increments a view counter, deduplicated per user per resource per 24 hours
   * (spec 0.13).
   *
   * There is no "increment view" endpoint: a client-driven counter is trivially
   * inflatable and adds a round trip to every screen open. So detail reads call
   * this, and the dedupe key lives in Redis because it is high-churn and
   * worthless after a day.
   *
   * Returns true when the view was counted.
   */
  async countView(resource: string, resourceId: string, viewerId: string | null): Promise<boolean> {
    if (!viewerId) return false;

    const key = `view:${resource}:${resourceId}:${viewerId}`;
    const seen = await this.cache.get<boolean>(key).catch(() => null);

    if (seen) return false;

    await this.cache.set(key, true, 86_400).catch(() => undefined);

    return true;
  }
}
