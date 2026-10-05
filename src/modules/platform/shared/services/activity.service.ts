import { Injectable } from '@nestjs/common';
import { ActivitySubject, ActivityVerb, SearchScope } from '@prisma/client';
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

export interface SearchInput {
  userId?: string | null;
  /** Which search box, which is what a member filtering the published list is asking about. */
  scope: SearchScope;
  term: string;
  cityId?: string | null;
  /** The category the search was filtered to, where it was filtered to one. */
  code?: string | null;
  /**
   * Whether it found anything. Recorded now because it cannot be worked out later: by the time the
   * job runs the catalogue has changed, and "searched and found nothing" is the metric a
   * prospective seller or guide writer most wants.
   */
  hadResults: boolean;
}

/** The feed into Circl Intelligence. */
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
   * A free-text search, for the published demand lists (6.3). Counted, never attributed: `userId`
   * is kept only so a term can be required to come from several different people before it is
   * shown, which is what stops a rare and specific search identifying whoever typed it.
   *
   * Never awaited. A search must not be slower, or fail, because of what we record about it.
   */
  recordSearch(input: SearchInput): void {
    const term = input.term.trim();

    // A single character is a keystroke, not a search.
    if (term.length < 2) return;

    void this.database.activityEvent
      .create({
        data: {
          userId: input.userId ?? null,
          verb: ActivityVerb.SEARCH,
          subject: ActivitySubject.SEARCH_TERM,
          cityId: input.cityId ?? null,
          code: input.code ?? null,
          term: term.toLowerCase().slice(0, 120),
          scope: input.scope,
          hadResults: input.hadResults,
        },
      })
      .catch(() => undefined);
  }

  /** Increments a view counter, deduplicated per user per resource per 24 hours (spec 0.13). */
  async countView(
    resource: string,
    resourceId: string,
    viewerId: string | null,
    ownerId?: string | null,
  ): Promise<boolean> {
    if (!viewerId) return false;
    if (ownerId && ownerId === viewerId) return false;

    const key = `view:${resource}:${resourceId}:${viewerId}`;
    const seen = await this.cache.get<boolean>(key).catch(() => null);

    if (seen) return false;

    await this.cache.set(key, true, 86_400).catch(() => undefined);

    return true;
  }
}
