import { ContentScanStatus, ContentScanTrigger, ReportTargetType } from '@prisma/client';
import { SCANNABLE_TARGETS } from '../../shared';
import { PlatformJobsService } from '../platform-jobs.service';

/**
 * `safety.rescan-degraded`, and the one thing about it that cannot be seen from outside.
 *
 * The sweep re-queues rows whose verdict is provisional. A private message's row is written by an
 * OBSERVE scan (§6.8): there is no source table for the worker to re-read, so `finalise` can only
 * record it degraded again — which puts it straight back in the sweep's window, on every pass,
 * for ever. Nothing observable breaks; the work just never stops.
 *
 * It is not reachable through the e2e suite either, in two ways that both look like a pass: the
 * sweep does nothing at all while the classifier is switched off, and when it is on it takes the
 * 200 oldest rows, which a message written a second ago is never among.
 */
/** Everything between `database` and `classifier` in the constructor. */
const NINE = Array.from({ length: 9 }, () => ({}) as never);

const row = (targetType: ReportTargetType, overrides: Record<string, unknown> = {}) => ({
  targetType,
  targetId: `${targetType}-1`,
  scanVersion: 1,
  scanStatus: ContentScanStatus.DEGRADED,
  ...overrides,
});

const build = (rows: Array<Record<string, unknown>>) => {
  const findMany = jest.fn(async () => rows);
  const update = jest.fn(async () => ({}));
  const enqueue = jest.fn(async () => undefined);
  const service = new PlatformJobsService(
    { get: () => 'false' } as never,
    { contentSafety: { findMany, update } } as never,
    // The nine section services between them, none of which this job touches.
    ...(NINE as [never, never, never, never, never, never, never, never, never]),
    { enabled: async () => true } as never,
    { enqueue } as never,
    // The three §2.9 collaborators and the data export builder, none of which this job touches.
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  return { service, findMany, update, enqueue };
};

describe('safety.rescan-degraded', () => {
  it('asks only for targets the worker can re-read', async () => {
    const { service, findMany } = build([]);

    await service.rescanDegraded();

    const where = (findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0]
      .where;

    expect(where.targetType).toEqual({ in: SCANNABLE_TARGETS });
    expect(SCANNABLE_TARGETS).not.toContain(ReportTargetType.MESSAGE);
    // Not an empty list, which would make the line above true for the wrong reason.
    expect(SCANNABLE_TARGETS).toContain(ReportTargetType.REQUEST);
  });

  it('bumps a degraded row and re-queues it as a new scan', async () => {
    const { service, update, enqueue } = build([row(ReportTargetType.REQUEST)]);

    await service.rescanDegraded();

    expect(update).toHaveBeenCalledTimes(1);
    expect(
      (update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data,
    ).toEqual({ scanVersion: 2, scanStatus: ContentScanStatus.PENDING });
    expect(enqueue).toHaveBeenCalledWith({
      targetType: ReportTargetType.REQUEST,
      targetId: 'REQUEST-1',
      scanVersion: 2,
      trigger: ContentScanTrigger.RESCAN,
    });
  });

  it('leaves a pending row at the version the write gave it', async () => {
    const { service, update, enqueue } = build([
      row(ReportTargetType.UPDATE, { scanStatus: ContentScanStatus.PENDING }),
    ]);

    await service.rescanDegraded();

    // A PENDING row's job never arrived; re-queueing it under a new version would dedupe against
    // nothing and the worker would then find the row's version lower than the job's.
    expect(update).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ scanVersion: 1 }));
  });

  it('does nothing while the classifier is switched off', async () => {
    const findMany = jest.fn(async () => []);
    const service = new PlatformJobsService(
      { get: () => 'false' } as never,
      { contentSafety: { findMany } } as never,
      // The nine section services between them, none of which this job touches.
      ...(NINE as [never, never, never, never, never, never, never, never, never]),
      { enabled: async () => false } as never,
      { enqueue: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.rescanDegraded();

    expect(findMany).not.toHaveBeenCalled();
  });
});
