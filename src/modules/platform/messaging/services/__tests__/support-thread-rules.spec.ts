import { SupportThreadState, SupportThreadType, ThreadContextType } from '@prisma/client';
import {
  settledType,
  stateAfterMessage,
  typeFromContext,
  waitingSince,
} from '../support-thread.rules';

/**
 * §4.8's type rule and §7.6's state machine.
 *
 * The type rule is an **access control**, not a label: §5.15 excludes `GUARD` threads from the
 * support inbox for anybody without `guard:read`, and lists every other type to the whole support
 * team. So "which type does this conversation settle on" decides whether a safeguarding
 * disclosure is private, and it is decided by a four-line pure function. This is that function's
 * test.
 */
describe('which type a conversation settles on', () => {
  it('derives the two that a context can tell you', () => {
    expect(typeFromContext(ThreadContextType.MANAGED_REQUEST)).toBe(SupportThreadType.MANAGED);
    expect(typeFromContext(ThreadContextType.BRIEF)).toBe(SupportThreadType.MANAGED);
    expect(typeFromContext(ThreadContextType.DISPUTE)).toBe(SupportThreadType.DISPUTE);
  });

  /**
   * The context `SUPPORT` is shared by a plain support thread, a Guard disclosure and a deal
   * problem — all three with a null context id, so all three are one conversation for one member.
   * Derivation cannot separate them, and the safe answer to "I cannot tell" is the least
   * privileged one.
   */
  it('and falls back to SUPPORT rather than guessing at the two it cannot', () => {
    expect(typeFromContext(ThreadContextType.SUPPORT)).toBe(SupportThreadType.SUPPORT);
    expect(typeFromContext(null)).toBe(SupportThreadType.SUPPORT);
  });

  it('never derives GUARD, which has to be declared by the caller that knows', () => {
    for (const context of [...Object.values(ThreadContextType), null]) {
      expect(typeFromContext(context)).not.toBe(SupportThreadType.GUARD);
    }
  });

  /**
   * The leak this prevents: a member opens a Guard disclosure, then reports a problem with a
   * delivery. Both land in the same conversation. If the later claim won, §5.15 would list that
   * disclosure to the whole support team — a safeguarding leak caused by a late parcel.
   */
  it('keeps a Guard thread Guard whatever claims it afterwards', () => {
    for (const next of Object.values(SupportThreadType)) {
      expect(settledType(SupportThreadType.GUARD, next)).toBe(SupportThreadType.GUARD);
    }
  });

  /** And the other order: the disclosure must not be lost behind a deal problem. */
  it('and raises an existing thread to Guard when Guard arrives second', () => {
    for (const current of Object.values(SupportThreadType)) {
      expect(settledType(current, SupportThreadType.GUARD)).toBe(SupportThreadType.GUARD);
    }
  });

  it('otherwise the first claim stands', () => {
    expect(settledType(SupportThreadType.MANAGED, SupportThreadType.SUPPORT)).toBe(
      SupportThreadType.MANAGED,
    );
    expect(settledType(SupportThreadType.DISPUTE, SupportThreadType.DEAL_PROBLEM)).toBe(
      SupportThreadType.DISPUTE,
    );
  });

  it('and a conversation with no row yet takes what it was given', () => {
    expect(settledType(null, SupportThreadType.DEAL_PROBLEM)).toBe(SupportThreadType.DEAL_PROBLEM);
    expect(settledType(null, SupportThreadType.GUARD)).toBe(SupportThreadType.GUARD);
  });
});

describe('what a message does to the state', () => {
  const member = (state: SupportThreadState) => stateAfterMessage(state, false);
  const staff = (state: SupportThreadState, keepOpen = false) =>
    stateAfterMessage(state, true, { keepOpen });

  it('hands the thread back to the member on a staff reply', () => {
    for (const state of [SupportThreadState.NEW, SupportThreadState.OPEN]) {
      expect(staff(state)).toEqual({
        state: SupportThreadState.WAITING_ON_MEMBER,
        reopened: false,
      });
    }
  });

  it('unless the replier says they are not waiting', () => {
    expect(staff(SupportThreadState.OPEN, true).state).toBe(SupportThreadState.OPEN);
  });

  /**
   * `NEW` is "nobody has answered", not "one message old". The inbox's unanswered count is what
   * the state is for, and a member who writes twice before anybody replies has been answered no
   * more than one who wrote once.
   */
  it('leaves NEW alone when the member writes again', () => {
    expect(member(SupportThreadState.NEW)).toEqual({
      state: SupportThreadState.NEW,
      reopened: false,
    });
  });

  it('takes a thread waiting on the member back to OPEN when they answer', () => {
    expect(member(SupportThreadState.WAITING_ON_MEMBER)).toEqual({
      state: SupportThreadState.OPEN,
      reopened: false,
    });
  });

  it('reopens a settled thread, and counts it', () => {
    for (const state of [SupportThreadState.RESOLVED, SupportThreadState.CLOSED]) {
      expect(member(state)).toEqual({ state: SupportThreadState.OPEN, reopened: true });
    }
  });

  it('and only a member reopens: staff writing in a settled thread is not a reopen', () => {
    expect(staff(SupportThreadState.RESOLVED).reopened).toBe(false);
  });

  it('has an answer for every state, from both sides', () => {
    for (const state of Object.values(SupportThreadState)) {
      expect(Object.values(SupportThreadState)).toContain(member(state).state);
      expect(Object.values(SupportThreadState)).toContain(staff(state).state);
    }
  });
});

describe('waitingSince', () => {
  const at = (iso: string) => new Date(iso);

  it('is the member’s last message when it is the latest word', () => {
    expect(
      waitingSince({
        state: SupportThreadState.OPEN,
        lastMemberMessageAt: at('2026-10-10T10:00:00Z'),
        lastStaffMessageAt: at('2026-10-09T10:00:00Z'),
      }),
    ).toEqual(at('2026-10-10T10:00:00Z'));
  });

  it('is null once staff have answered', () => {
    expect(
      waitingSince({
        state: SupportThreadState.OPEN,
        lastMemberMessageAt: at('2026-10-09T10:00:00Z'),
        lastStaffMessageAt: at('2026-10-10T10:00:00Z'),
      }),
    ).toBeNull();
  });

  /** A thread waiting on the member is not waiting on us, whatever the timestamps say. */
  it('and null in a state that is not ours to answer', () => {
    for (const state of [
      SupportThreadState.WAITING_ON_MEMBER,
      SupportThreadState.RESOLVED,
      SupportThreadState.CLOSED,
    ]) {
      expect(
        waitingSince({
          state,
          lastMemberMessageAt: at('2026-10-10T10:00:00Z'),
          lastStaffMessageAt: null,
        }),
      ).toBeNull();
    }
  });

  it('and null where nobody has written at all', () => {
    expect(
      waitingSince({
        state: SupportThreadState.NEW,
        lastMemberMessageAt: null,
        lastStaffMessageAt: null,
      }),
    ).toBeNull();
  });
});
