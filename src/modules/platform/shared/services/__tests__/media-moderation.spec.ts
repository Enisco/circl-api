import { ContentVisibilityState, ReportTargetType } from '@prisma/client';
import { SYSTEM_CONFIG_DEFAULTS } from '@/common';
import { ContentSafetyService } from '../content-safety.service';
import { queueDueBy, queuePriorityFor } from '../queue-priority';
import { AVATAR_MEDIA_OWNER } from '../media.service';

/**
 * §6.1's last line: an image's verdict propagates to whatever was showing it.
 *
 * For an avatar that means clearing `users.avatar_key`, and it is tested here rather than end to
 * end because the only thing that can hold an image is the classifier — there is nothing in a JPEG
 * for a lexicon to match, so with the classifier off (its default, and this environment's) an
 * avatar scan always concludes VISIBLE and the propagation never runs.
 */
const build = () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    $executeRawUnsafe: jest.fn(async (sql: string, ...params: unknown[]) => {
      statements.push({ sql, params });

      return 1;
    }),
  };
  const service = new ContentSafetyService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      // The real rule, not a fixed answer: a stub that always says NORMAL cannot see an
      // escalation, which is exactly what the tests below are about.
      stamp: async ({ type, riskLevel, createdAt }: Record<string, never>) => ({
        priority: queuePriorityFor({ type, riskLevel: riskLevel ?? 'NONE' }),
        dueAt: queueDueBy({
          type,
          priority: queuePriorityFor({ type, riskLevel: riskLevel ?? 'NONE' }),
          createdAt: createdAt ?? new Date('2026-06-10T09:00:00Z'),
          slaMinutes: SYSTEM_CONFIG_DEFAULTS['reports.slaMinutes'],
          anonymousWorkingMinutes: SYSTEM_CONFIG_DEFAULTS['moderation.anonymousSlaWorkingMinutes'],
          workingHours: SYSTEM_CONFIG_DEFAULTS['moderation.workingHours'],
        }),
      }),
    } as never,
  );

  return { service, tx, statements };
};

const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('a verdict on an image', () => {
  it('clears the avatar it was showing when the image is held', async () => {
    const { service, tx, statements } = build();

    await service.mirror(
      tx as never,
      ReportTargetType.MEDIA,
      'media-1',
      ContentVisibilityState.HELD,
    );

    expect(statements).toHaveLength(2);
    expect(normalise(statements[0].sql)).toContain('UPDATE "media" SET "moderation_state"');

    const avatar = statements[1];

    expect(normalise(avatar.sql)).toContain('UPDATE "users" SET "avatar_key" = NULL');
    // Only if it is still the avatar on show: a held photo already replaced is history.
    expect(normalise(avatar.sql)).toContain('"users"."avatar_key" = m."storage_key"');
    expect(avatar.params).toEqual(['media-1', AVATAR_MEDIA_OWNER]);
  });

  it('puts it back when the image is released, unless a newer one is set', async () => {
    const { service, tx, statements } = build();

    await service.mirror(
      tx as never,
      ReportTargetType.MEDIA,
      'media-1',
      ContentVisibilityState.VISIBLE,
    );

    const avatar = normalise(statements[1].sql);

    expect(avatar).toContain('SET "avatar_key" = m."storage_key"');
    expect(avatar).toContain('"users"."avatar_key" IS NULL');
  });

  it('leaves a LIMITED image on show', async () => {
    const { service, tx, statements } = build();

    await service.mirror(
      tx as never,
      ReportTargetType.MEDIA,
      'media-1',
      ContentVisibilityState.LIMITED,
    );

    // LIMITED means "out of feeds", and an avatar is not a feed item. Every upload passes through
    // it while the classifier thinks (§6.5), so clearing here would blank every member's photo
    // for as long as a scan takes.
    expect(normalise(statements[1].sql)).toContain('SET "avatar_key" = m."storage_key"');
  });

  it('does not touch avatars for any other target', async () => {
    const { service, tx, statements } = build();

    await service.mirror(
      tx as never,
      ReportTargetType.REQUEST,
      'request-1',
      ContentVisibilityState.HELD,
    );

    expect(statements).toHaveLength(1);
    expect(normalise(statements[0].sql)).toContain('UPDATE "community_requests"');
  });
});
