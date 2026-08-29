import { Injectable } from '@nestjs/common';
import { TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import { UpdatePreferencesDto } from '../dtos';

/** What a NOTIFICATION_CATEGORY term carries in `metadata` (6.1.3). */
interface CategoryMeta {
  defaultPush?: boolean;
  defaultEmail?: boolean;
  isLocked?: boolean;
}

/** The preference matrix: one row per category, two channels (6.1.3). */
@Injectable()
export class NotificationPreferenceService {
  constructor(private readonly database: PrismaService) {}

  async matrix(userId: string) {
    return { data: { categories: await this.categories(userId) } };
  }

  async update(userId: string, dto: UpdatePreferencesDto) {
    const terms = await this.terms();
    const byCode = new Map(terms.map(term => [term.code, term]));

    for (const row of dto.categories) {
      const term = byCode.get(row.code);

      if (!term) {
        throw ApiException.unprocessable(
          ApiErrorCode.UNKNOWN_TAXONOMY_CODE,
          `"${row.code}" is not a notification category.`,
          { details: [{ field: 'categories', message: `"${row.code}" is not a category.` }] },
        );
      }

      // Rejected rather than silently ignored, so a client that draws the toggle optimistically puts it back rather than showing a state the server does not hold (6.1.3).
      if ((term.metadata as CategoryMeta | null)?.isLocked) {
        throw ApiException.unprocessable(
          ApiErrorCode.PREFERENCE_LOCKED,
          `"${term.label}" cannot be switched off.`,
          { details: [{ field: 'categories', message: `${term.label} cannot be switched off.` }] },
        );
      }
    }

    await this.database.$transaction(
      dto.categories.map(row =>
        this.database.notificationPreference.upsert({
          where: { userId_categoryCode: { userId, categoryCode: row.code } },
          create: { userId, categoryCode: row.code, push: row.push, email: row.email },
          update: { push: row.push, email: row.email },
        }),
      ),
    );

    // The full saved matrix, so the client replaces what it optimistically drew rather than merging into it.
    return { data: { categories: await this.categories(userId) } };
  }

  /** Whether a category is switched on for a channel. */
  async allows(userId: string, categoryCode: string, channel: 'push' | 'email'): Promise<boolean> {
    const [terms, saved] = await Promise.all([
      this.terms(),
      this.database.notificationPreference.findUnique({
        where: { userId_categoryCode: { userId, categoryCode } },
      }),
    ]);

    const term = terms.find(item => item.code === categoryCode);
    const meta = (term?.metadata as CategoryMeta | null) ?? {};

    if (meta.isLocked) return true;
    if (saved) return saved[channel];

    return channel === 'push' ? (meta.defaultPush ?? true) : (meta.defaultEmail ?? false);
  }

  private async categories(userId: string) {
    const [terms, saved] = await Promise.all([
      this.terms(),
      this.database.notificationPreference.findMany({ where: { userId } }),
    ]);

    const bySaved = new Map(saved.map(row => [row.categoryCode, row]));

    return terms.map(term => {
      const meta = (term.metadata as CategoryMeta | null) ?? {};
      const row = bySaved.get(term.code);
      // A locked row is always on, whatever a stale saved row says: the lock is the answer, not a hint about the default it started from.
      const isLocked = meta.isLocked === true;

      return {
        code: term.code,
        // Required and rendered verbatim.
        label: term.label,
        push: isLocked ? true : (row?.push ?? meta.defaultPush ?? true),
        email: isLocked ? true : (row?.email ?? meta.defaultEmail ?? false),
        isLocked,
      };
    });
  }

  private terms() {
    return this.database.taxonomyTerm.findMany({
      where: { kind: TaxonomyKind.NOTIFICATION_CATEGORY, isActive: true },
      orderBy: { sort: 'asc' },
    });
  }
}
