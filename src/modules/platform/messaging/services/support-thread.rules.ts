import { SupportThreadState, SupportThreadType, ThreadContextType } from '@prisma/client';

/**
 * §4.8 and §7.6: what a support thread **is**, and what a message does to it.
 *
 * Kept apart from the services because it is the part with the rules in it — three pure functions
 * over two enums — and because one of them is an access control rather than a label. Both halves
 * are worth testing exhaustively and both are the kind of thing somebody will ask about.
 */

/**
 * The type a conversation's context implies, where nobody says otherwise.
 *
 * Deliberately incomplete, and that is the important part: `GUARD` and `DEAL_PROBLEM` are **not
 * derivable**. Both are created with `contextType: SUPPORT` and a null context id, which means
 * they are the *same conversation* for a member who has had both — `ConversationFactoryService`
 * keys on `(participantKey, contextType, contextId)`, and D36 relies on that so a second
 * safeguarding disclosure continues the first thread rather than opening a second one beside it.
 *
 * So the caller that knows says so, via `EnsureConversationInput.supportType`. Guessing from the
 * context would type a safeguarding disclosure `SUPPORT`, and §5.15 lists `SUPPORT` threads to
 * every member of the support team.
 */
export const typeFromContext = (contextType: ThreadContextType | null): SupportThreadType => {
  switch (contextType) {
    case ThreadContextType.MANAGED_REQUEST:
    case ThreadContextType.BRIEF:
      return SupportThreadType.MANAGED;
    case ThreadContextType.DISPUTE:
      return SupportThreadType.DISPUTE;
    default:
      return SupportThreadType.SUPPORT;
  }
};

/**
 * The type a thread settles on when a second thing claims the same conversation.
 *
 * **`GUARD` only ever wins, in both directions.** One conversation can carry a safeguarding
 * disclosure and a deal problem, because they share a key, and the order they arrive in is
 * whatever the member happened to do first. If the later one decided, then:
 *
 *  - Guard first, deal problem second → the thread becomes `DEAL_PROBLEM`, and §5.15 puts
 *    somebody's private disclosure in front of the whole support team. A safeguarding leak caused
 *    by a member reporting a late delivery.
 *  - deal problem first, Guard second → the thread stays `DEAL_PROBLEM` and the disclosure is
 *    never seen by the people who handle them.
 *
 * Both are unacceptable, and only one rule avoids both: once a conversation has carried Guard
 * content it is a Guard thread for ever. The cost is a deal problem that a support agent cannot
 * see, which is recoverable — Trust & Safety can, and the member can write again.
 */
export const settledType = (
  current: SupportThreadType | null,
  next: SupportThreadType,
): SupportThreadType => {
  if (current === SupportThreadType.GUARD || next === SupportThreadType.GUARD) {
    return SupportThreadType.GUARD;
  }

  // Otherwise the first claim stands. A thread opened for a managed request does not become a
  // plain support thread because the member later asked an unrelated question in it.
  return current ?? next;
};

export interface StateChange {
  state: SupportThreadState;
  /** True when a member came back to something that had been settled (§7.6, `reopenCount++`). */
  reopened: boolean;
}

/**
 * What a message does to a thread's state (§7.6).
 *
 * `NEW` survives a second member message, because `NEW` means *nobody has answered* rather than
 * *one message old* — the inbox's unanswered count is what that state is for, and a member who
 * writes twice before anybody replies has been answered no more than one who wrote once.
 *
 * A staff message into a settled thread reopens it rather than leaving it settled: writing into a
 * thread is the opposite of being finished with it, and a resolved thread with an unanswered staff
 * question in it is a thread nobody is watching.
 */
export const stateAfterMessage = (
  state: SupportThreadState,
  byStaff: boolean,
  options: { keepOpen?: boolean } = {},
): StateChange => {
  if (byStaff) {
    // `keepOpen` is §5.15's "I am not waiting on them" — a note to the member that does not hand
    // the thread back, so it stays in the replier's own queue.
    const next = options.keepOpen ? SupportThreadState.OPEN : SupportThreadState.WAITING_ON_MEMBER;

    return { state: next, reopened: false };
  }

  const settled = state === SupportThreadState.RESOLVED || state === SupportThreadState.CLOSED;

  if (settled) return { state: SupportThreadState.OPEN, reopened: true };

  // `NEW` stays `NEW` until somebody answers. Everything else a member writes into is `OPEN`.
  if (state === SupportThreadState.NEW) return { state: SupportThreadState.NEW, reopened: false };

  return { state: SupportThreadState.OPEN, reopened: false };
};

/**
 * `waitingSince` (§7.6): the latest member message, when it is newer than the latest staff one and
 * the thread is somebody's to answer. Null otherwise — a thread waiting on the *member* is not
 * waiting on us, and neither is one nobody has written into.
 */
export const waitingSince = (thread: {
  state: SupportThreadState;
  lastMemberMessageAt: Date | null;
  lastStaffMessageAt: Date | null;
}): Date | null => {
  const answerable =
    thread.state === SupportThreadState.NEW || thread.state === SupportThreadState.OPEN;

  if (!answerable || !thread.lastMemberMessageAt) return null;

  if (thread.lastStaffMessageAt && thread.lastStaffMessageAt >= thread.lastMemberMessageAt) {
    return null;
  }

  return thread.lastMemberMessageAt;
};
