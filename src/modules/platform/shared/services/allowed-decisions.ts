import {
  ContentVisibilityState,
  ModerationDecision,
  ModerationQueueState,
  ModerationQueueType,
  ReportTargetType,
} from '@prisma/client';

/**
 * Which decisions a reviewer may take on a queue item (§5.9, §6.6).
 *
 * The last piece of §6.6 that had no endpoint behind it. Until now the portal had to infer the
 * buttons from the queue type, which meant it could offer `APPROVE` on something that was never
 * held — publishing content nobody had hidden — and offer `RESTORE_REACH` on something that was,
 * which would have quietly republished held content under a label that says "restore its reach".
 *
 * A pure function of four things, and all four matter:
 *
 * 1. **The type**, because the questions differ: an anonymous post is approved or rejected, flagged
 *    content is published or removed.
 * 2. **The target type**, because a message is never hidden (§6.8). There is nothing to approve or
 *    remove — only the sender to act on — so offering `REMOVE_CONTENT` on one would be a button
 *    that cannot work.
 * 3. **The content's visibility**, because `APPROVE` and `RESTORE_REACH` are not synonyms. A HELD
 *    item is published; a LIMITED one has its reach restored. Offering both invites a reviewer to
 *    pick the wrong verb for what actually happened.
 * 4. **The item's state**, because a decided item is finished. An empty list is how the portal
 *    knows to render history rather than buttons.
 *
 * Returned to the client rather than duplicated there: these rules change with §6.6, and a copy in
 * the portal is a copy that will disagree with the one the decide endpoint enforces.
 */

/** §6.8: a private message is scanned but never hidden, so only the sender can be acted on. */
const MESSAGE_DECISIONS: readonly ModerationDecision[] = [
  ModerationDecision.NO_ACTION,
  ModerationDecision.WARN_AUTHOR,
  ModerationDecision.SUSPEND_AUTHOR,
  ModerationDecision.ESCALATE_GUARD,
];

/** The removal family, offered wherever there is content to remove. */
const REMOVALS: readonly ModerationDecision[] = [
  ModerationDecision.REMOVE_CONTENT,
  ModerationDecision.REMOVE_AND_WARN,
  ModerationDecision.REMOVE_AND_SUSPEND,
];

export interface AllowedDecisionsInput {
  type: ModerationQueueType;
  state: ModerationQueueState;
  targetType: ReportTargetType;
  /**
   * The content's current visibility, or null when there is no content row to read — a `USER` or
   * `CONVERSATION` target, or content that has since been hard-deleted.
   */
  visibilityState: ContentVisibilityState | null;
}

export const allowedDecisionsFor = (input: AllowedDecisionsInput): ModerationDecision[] => {
  // A decided item is finished. §6.6 is the only thing that may reopen one, and it does that by
  // creating work rather than by re-offering buttons on a closed row.
  if (input.state === ModerationQueueState.RESOLVED) return [];

  switch (input.type) {
    case ModerationQueueType.FLAGGED_CONTENT:
      if (input.targetType === ReportTargetType.MESSAGE) return [...MESSAGE_DECISIONS];

      return [
        ...publishOrRestore(input.visibilityState),
        ...REMOVALS,
        ModerationDecision.ESCALATE_GUARD,
      ];

    case ModerationQueueType.ANONYMOUS_POST:
      return [
        ModerationDecision.APPROVE,
        ModerationDecision.REJECT,
        ModerationDecision.ESCALATE_GUARD,
      ];

    case ModerationQueueType.GUARD_RISK:
      // Guard is about the person. When the item happens to point at content as well — a CRITICAL
      // post — publishing and removing are offered too, so held content can always leave the
      // queue rather than waiting on a safeguarding conversation that may take days.
      return [
        ModerationDecision.NO_ACTION,
        ModerationDecision.ESCALATE_GUARD,
        ...(hasContent(input.targetType)
          ? [...publishOrRestore(input.visibilityState), ModerationDecision.REMOVE_CONTENT]
          : []),
      ];

    case ModerationQueueType.AUTO_GUIDE:
      return [ModerationDecision.APPROVE, ModerationDecision.REJECT];

    case ModerationQueueType.PROFESSIONAL_REVIEW:
      // §2.9 has its own endpoint, with its own two verbs and a required message to the member.
      // Empty rather than approximate: a reviewer who presses `APPROVE` here would publish a
      // listing without the decision trail that endpoint writes.
      return [];

    // Both delegate: the decision belongs to the case or the appeal, which have their own rules,
    // their own permissions and their own side effects. An empty list is what tells the portal to
    // send the reviewer there instead of drawing buttons it cannot honour.
    case ModerationQueueType.REPORTED_CONTENT:
    case ModerationQueueType.APPEAL:
      return [];

    default:
      return [];
  }
};

/**
 * `APPROVE` or `RESTORE_REACH`, never both (§5.9's table).
 *
 * HELD and PENDING_APPROVAL are not public at all, so the decision is to publish. LIMITED is
 * public at a direct link but out of feeds, so the only thing left to give back is reach. Content
 * that is already VISIBLE needs neither, and offering one would be a button that changes nothing
 * while reading as though it had.
 */
const publishOrRestore = (state: ContentVisibilityState | null): ModerationDecision[] => {
  switch (state) {
    case ContentVisibilityState.HELD:
    case ContentVisibilityState.PENDING_APPROVAL:
    case ContentVisibilityState.REJECTED:
      return [ModerationDecision.APPROVE];
    case ContentVisibilityState.LIMITED:
      return [ModerationDecision.RESTORE_REACH];
    default:
      return [];
  }
};

/** Whether this target is a piece of content with a visibility column, rather than a person. */
const hasContent = (targetType: ReportTargetType): boolean =>
  targetType !== ReportTargetType.USER && targetType !== ReportTargetType.CONVERSATION;
