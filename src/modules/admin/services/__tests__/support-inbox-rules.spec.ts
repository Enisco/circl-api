import { SupportThreadState, SupportThreadType } from '@prisma/client';
import { HttpStatus } from '@nestjs/common';
import { PrismaService } from '@/infrastructure';
import { AdminPolicyService } from '../../common/admin-policy.service';
import { AdminPrincipal } from '../../common/admin-principal';
import { SUPPORT_TRANSITIONS, cleanTags } from '../admin-support.service';
import {
  DONE_SUPPORT_STATES,
  OPEN_SUPPORT_STATES,
  SUPPORT_STATE_TARGETS,
} from '../../dtos/admin-support.dto';

const principal = (...permissions: string[]): AdminPrincipal =>
  ({
    id: 'staff-1',
    email: 'staff@example.test',
    firstName: 'Ada',
    lastName: 'Obi',
    roleCode: 'support',
    permissions: new Set(permissions),
    sessionId: 'session-1',
  }) as AdminPrincipal;

/** The real roles, as `prisma/seeders/role.seeder.ts` grants them. */
const SUPPORT = principal('support:read', 'support:manage');
const TRUST_SAFETY = principal('support:read', 'guard:read', 'guard:manage');
const READ_ONLY_SAFETY = principal('support:read', 'guard:read');

const status = (run: () => void): number => {
  try {
    run();
  } catch (error) {
    return (error as { getStatus(): number }).getStatus();
  }

  return HttpStatus.OK;
};

describe('support thread transitions', () => {
  it('has an answer for every state, so a new one cannot be silently un-transitionable', () => {
    expect(Object.keys(SUPPORT_TRANSITIONS).sort()).toEqual(
      [...Object.values(SupportThreadState)].sort(),
    );
  });

  it('lets anything open be resolved', () => {
    for (const from of OPEN_SUPPORT_STATES) {
      expect(SUPPORT_TRANSITIONS[from]).toContain(SupportThreadState.RESOLVED);
    }
  });

  it('lets anything settled be reopened', () => {
    for (const from of DONE_SUPPORT_STATES) {
      expect(SUPPORT_TRANSITIONS[from]).toEqual([SupportThreadState.OPEN]);
    }
  });

  it('never offers CLOSED as a target, because that is what seven days of silence does', () => {
    for (const from of Object.values(SupportThreadState)) {
      expect(SUPPORT_TRANSITIONS[from]).not.toContain(SupportThreadState.CLOSED);
    }

    expect([...SUPPORT_STATE_TARGETS]).not.toContain(SupportThreadState.CLOSED);
  });

  it('refuses a resolution of something already resolved', () => {
    expect(SUPPORT_TRANSITIONS[SupportThreadState.RESOLVED]).not.toContain(
      SupportThreadState.RESOLVED,
    );
  });

  it('offers no state the DTO will not accept', () => {
    const targets = new Set<string>(SUPPORT_STATE_TARGETS);

    for (const allowed of Object.values(SUPPORT_TRANSITIONS)) {
      for (const state of allowed) expect(targets.has(state)).toBe(true);
    }
  });

  it('keeps WAITING_ON_MEMBER in the open states — an unanswered reply is still work', () => {
    expect(OPEN_SUPPORT_STATES).toContain(SupportThreadState.WAITING_ON_MEMBER);
    expect(DONE_SUPPORT_STATES).not.toContain(SupportThreadState.WAITING_ON_MEMBER);
  });

  it('splits every state into exactly one of open and done', () => {
    for (const state of Object.values(SupportThreadState)) {
      expect(OPEN_SUPPORT_STATES.includes(state) !== DONE_SUPPORT_STATES.includes(state)).toBe(
        true,
      );
    }
  });
});

describe('thread tags', () => {
  it('lower-cases, trims and de-duplicates, so one idea is one tag', () => {
    expect(cleanTags([' Refund ', 'refund', 'REFUND'])).toEqual(['refund']);
  });

  it('collapses runs of whitespace rather than keeping two spellings of one phrase', () => {
    expect(cleanTags(['late  delivery', 'late delivery'])).toEqual(['late delivery']);
  });

  it('drops the empties a trimmed form sends', () => {
    expect(cleanTags(['', '   ', 'scam'])).toEqual(['scam']);
  });

  it('clears the list when asked to, because tags are replaced and not merged', () => {
    expect(cleanTags([])).toEqual([]);
  });
});

/**
 * R7, which is the whole of this stage's access control.
 *
 * Worth testing exhaustively rather than reading, because the thing it protects is invisible in
 * the data: a safeguarding disclosure and a question about a delivery are both
 * `ThreadKind.SUPPORT` with `contextType: SUPPORT` and a null context id (D36), so the only
 * difference between "Support may read this" and "Support must never read this" is one enum
 * column. The M0 endpoints checked `contextType`, which is identical for both, and that is exactly
 * the bug these assertions would have caught.
 */
describe('who may see a support thread (R7)', () => {
  const policy = new AdminPolicyService(null as unknown as PrismaService);

  it('hides a Guard thread from support as a 404, not a 403', () => {
    // A 403 would confirm that the id names a Guard thread, which for the member who disclosed
    // something is most of the disclosure.
    expect(status(() => policy.assertMaySeeSupportThread(SUPPORT, SupportThreadType.GUARD))).toBe(
      HttpStatus.NOT_FOUND,
    );
  });

  it('refuses support a reply in a Guard thread', () => {
    expect(
      status(() => policy.assertMaySeeSupportThread(SUPPORT, SupportThreadType.GUARD, 'write')),
    ).toBe(HttpStatus.NOT_FOUND);
  });

  it('lets trust & safety read and answer one', () => {
    expect(
      status(() => policy.assertMaySeeSupportThread(TRUST_SAFETY, SupportThreadType.GUARD)),
    ).toBe(HttpStatus.OK);
    expect(
      status(() =>
        policy.assertMaySeeSupportThread(TRUST_SAFETY, SupportThreadType.GUARD, 'write'),
      ),
    ).toBe(HttpStatus.OK);
  });

  it('lets a reader of Guard cases read one without being able to speak into it', () => {
    expect(
      status(() => policy.assertMaySeeSupportThread(READ_ONLY_SAFETY, SupportThreadType.GUARD)),
    ).toBe(HttpStatus.OK);
    expect(
      status(() =>
        policy.assertMaySeeSupportThread(READ_ONLY_SAFETY, SupportThreadType.GUARD, 'write'),
      ),
    ).toBe(HttpStatus.FORBIDDEN);
  });

  it('lets support read and answer every other type', () => {
    for (const type of Object.values(SupportThreadType)) {
      if (type === SupportThreadType.GUARD) continue;

      expect(status(() => policy.assertMaySeeSupportThread(SUPPORT, type))).toBe(HttpStatus.OK);
      expect(status(() => policy.assertMaySeeSupportThread(SUPPORT, type, 'write'))).toBe(
        HttpStatus.OK,
      );
    }
  });

  it('refuses trust & safety a reply in an ordinary thread, which they hold read-only', () => {
    // Not an oversight in the role: §4.13 gives Trust & Safety `support:read` so an escalation can
    // be understood without being acted on. The point of the assertion is that the *route* admits
    // either manage permission, so without this check holding `guard:manage` would have been a way
    // into every support thread on the platform.
    expect(
      status(() => policy.assertMaySeeSupportThread(TRUST_SAFETY, SupportThreadType.SUPPORT)),
    ).toBe(HttpStatus.OK);
    expect(
      status(() =>
        policy.assertMaySeeSupportThread(TRUST_SAFETY, SupportThreadType.SUPPORT, 'write'),
      ),
    ).toBe(HttpStatus.FORBIDDEN);
  });

  it('keeps Guard threads out of a support agent’s list, and in a reviewer’s', () => {
    expect(policy.maySeeGuardThreads(SUPPORT)).toBe(false);
    expect(policy.maySeeGuardThreads(TRUST_SAFETY)).toBe(true);
  });

  it('defaults a brand-new thread type to the support permissions, not to nothing', () => {
    // `assertMaySeeSupportThread` branches on `GUARD` and treats everything else as support work.
    // Spelled out so that adding a sixth type is a decision about whether it is safeguarding,
    // rather than a type that silently becomes readable by the whole team.
    expect(
      status(() => policy.assertMaySeeSupportThread(SUPPORT, 'SOMETHING_NEW' as SupportThreadType)),
    ).toBe(HttpStatus.OK);
  });
});
