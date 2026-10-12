import { Injectable, Logger } from '@nestjs/common';
import {
  AdminReasonCode,
  EnforcementSourceType,
  ModerationDecision,
  ReportTargetType,
} from '@prisma/client';
import { ReasonedDto } from '@/common';
import { SuspendMemberDto, WarnMemberDto } from '../dtos/admin-member-actions.dto';
import { AdminMemberActionService } from './admin-member-action.service';

/**
 * What a moderation decision does to the member behind the content (§5.9, §7.2).
 *
 * The same six decisions arrive through four doors — the queue, a report case, the content page,
 * and an appeal reversing one — and what they mean for the *member* must not depend on which door
 * it was. That is not a hypothetical: §9's B6 is this exact failure, where `WARN_AUTHOR` in the
 * queue did nothing at all while the same decision on a case issued a strike and sent an email.
 * A member warned through one screen and not the other is a moderation record that cannot be read.
 *
 * So the mapping from decision to consequence lives here, once, and the callers differ only in
 * what they say it came *from*.
 */

/** The decisions that take content down. */
export const REMOVES: ModerationDecision[] = [
  ModerationDecision.REMOVE_CONTENT,
  ModerationDecision.REMOVE_AND_WARN,
  ModerationDecision.REMOVE_AND_SUSPEND,
];

/** The decisions that warn the author. */
export const WARNS: ModerationDecision[] = [
  ModerationDecision.WARN_AUTHOR,
  ModerationDecision.REMOVE_AND_WARN,
];

/** The decisions that suspend the author. */
export const SUSPENDS: ModerationDecision[] = [
  ModerationDecision.SUSPEND_AUTHOR,
  ModerationDecision.REMOVE_AND_SUSPEND,
];

export interface EnforcementInput {
  targetUserId: string | null;
  decision: ModerationDecision;
  /** Default true (§6.9): the decisions that name a strike issue one unless told otherwise. */
  issueStrike?: boolean;
  /** Shown to the member verbatim. */
  memberMessage?: string;
  suspension?: { duration: '24h' | '7d' | '30d' | 'permanent' | 'custom'; until?: string };
  reason: { reasonCode: string; policySubtype: string | null; note: string | null };
  /** What this came out of, so the strike or suspension can be found again — and undone. */
  sourceType: EnforcementSourceType;
  sourceId: string;
  /**
   * Which kind of content `sourceId` is, for a `CONTENT` source (§5.14's `Strike` carries it).
   *
   * Required to make the id meaningful: content ids are only unique within their own table, so a
   * strike recorded against `sourceId` alone cannot be traced back to the post it was about. The
   * DTO already accepted it; this is what carries it from a caller to the row.
   */
  sourceTargetType?: ReportTargetType;
  /** For the log line if it fails. */
  describedBy: string;
}

@Injectable()
export class AdminEnforcementService {
  private readonly logger = new Logger(AdminEnforcementService.name);

  constructor(private readonly actions: AdminMemberActionService) {}

  /**
   * Applies the decision to the member, and never throws.
   *
   * By the time this runs the decision is recorded and the content has moved. An enforcement that
   * fails after that is **logged loudly and separately** rather than rolled back: unpicking the
   * decision would leave the reports answered and the item open, which is a worse state than a
   * strike a manager has to add by hand. The log line names the member and the source so it can be.
   */
  async apply(input: EnforcementInput): Promise<void> {
    if (!input.targetUserId) return;

    const strike = input.issueStrike ?? true;
    const warning = WARNS.includes(input.decision);
    const removing = REMOVES.includes(input.decision);

    // Real DTO instances rather than object literals cast into shape: `assertReasoned` is then the
    // one in `ReasonedDto`, and these calls go through exactly what the member screens go through
    // instead of through a lookalike that can drift from it.
    const reasoned = <T extends ReasonedDto>(Dto: new () => T, fields: Partial<T>): T =>
      Object.assign(new Dto(), {
        reasonCode: input.reason.reasonCode as AdminReasonCode,
        policySubtype: input.reason.policySubtype ?? undefined,
        note: input.reason.note ?? undefined,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceTargetType: input.sourceTargetType,
        ...fields,
      });

    try {
      if (SUSPENDS.includes(input.decision)) {
        await this.actions.suspend(
          input.targetUserId,
          reasoned(SuspendMemberDto, {
            // A suspending decision with no duration is a seven-day one. The validation at the
            // endpoint asks for it; this is the floor, not the intended path.
            duration: input.suspension?.duration ?? '7d',
            until: input.suspension?.until,
          }),
        );
      } else if ((warning || removing) && strike) {
        await this.actions.warn(
          input.targetUserId,
          reasoned(WarnMemberDto, {
            message:
              input.memberMessage ??
              (removing && !warning ? 'Something you posted was removed.' : undefined),
          }),
        );
      } else if (warning) {
        // A warning the reviewer asked not to strike for. The member still has to be told —
        // otherwise `issueStrike: false` silently turns "warn the author" into doing nothing at
        // all, which is the decision looking taken and nobody hearing about it.
        this.actions.notifyMember(input.targetUserId, {
          title: 'A warning about your Circl account',
          body: input.memberMessage ?? 'Something you posted broke our community guidelines.',
        });
      }
    } catch (error) {
      this.logger.error(
        `${input.describedBy} decided but enforcement failed for ${input.targetUserId}: ${
          (error as Error).message
        }`,
      );
    }
  }

  /**
   * The two numbers the portal prompts on after a decision (§5.9's decide response).
   *
   * "Consider a suspension" is a prompt rather than an automatic escalation, which is §13.1's
   * rule: nothing auto-suspends.
   */
  async aftermath(
    targetUserId: string | null,
  ): Promise<{ authorActiveStrikes: number; suggestSuspension: boolean }> {
    if (!targetUserId) return { authorActiveStrikes: 0, suggestSuspension: false };

    return this.actions.strikeStanding(targetUserId);
  }
}
