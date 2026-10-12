import { Injectable } from '@nestjs/common';
import { ModerationQueueType, ReportCasePriority, RiskLevel } from '@prisma/client';
import { SYSTEM_CONFIG_KEYS } from '@/common';
import { SystemConfigService } from './system-config.service';
import { queueDueBy, queuePriorityFor } from './queue-priority';

/**
 * The one place a queue item gets its priority and its deadline (§5.9).
 *
 * Eight things raise queue items — the content scanner, the message scanner, auto-guides, Guard
 * twice, report cases, appeals and listing reviews. Eight copies of "how urgent is this and when is
 * it due" is eight chances for one of them to disagree, and the one that disagrees is invisible:
 * the item simply sorts in the wrong place and nobody can say why.
 *
 * So the rule lives here and the column is non-nullable, which between them make a producer that
 * forgets a compile error rather than a quiet one.
 */
@Injectable()
export class QueueDeadlineService {
  constructor(private readonly config: SystemConfigService) {}

  /**
   * `{ priority, dueAt }`, ready to spread into a create or an upsert.
   *
   * `riskLevel` defaults to `NONE` because most producers have no risk band to offer — an appeal,
   * an auto-guide draft, a listing waiting for approval. None of those is urgent by nature, and
   * the type decides the rest.
   */
  async stamp(input: {
    type: ModerationQueueType;
    riskLevel?: RiskLevel | null;
    /** When the clock starts. Defaults to now; a backdated item is a backdated deadline. */
    createdAt?: Date;
    /** Overrides the computed priority, for a producer that already knows better (an appeal's SLA). */
    priority?: ReportCasePriority;
  }): Promise<{ priority: ReportCasePriority; dueAt: Date }> {
    const [slaMinutes, anonymousWorkingMinutes, workingHours] = await Promise.all([
      this.config.get(SYSTEM_CONFIG_KEYS.REPORT_SLA_MINUTES),
      this.config.get(SYSTEM_CONFIG_KEYS.ANONYMOUS_SLA_WORKING_MINUTES),
      this.config.get(SYSTEM_CONFIG_KEYS.WORKING_HOURS),
    ]);

    const createdAt = input.createdAt ?? new Date();
    const priority =
      input.priority ??
      queuePriorityFor({ type: input.type, riskLevel: input.riskLevel ?? RiskLevel.NONE });

    return {
      priority,
      dueAt: queueDueBy({
        type: input.type,
        priority,
        createdAt,
        slaMinutes,
        anonymousWorkingMinutes,
        workingHours,
      }),
    };
  }
}
