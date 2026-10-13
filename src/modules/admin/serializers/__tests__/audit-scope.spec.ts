import { AuditArea } from '@prisma/client';
import { AdminPrincipal } from '../../common/admin-principal';
import { AUDIT_ACTIONS, AuditAction } from '../../audit/audit-actions';
import { CLIENT_EVENTS } from '../../dtos/admin-audit.dto';
import { SCOPED_AREAS, auditScopeFor } from '../audit-entry.serializer';

const principal = (...permissions: string[]): AdminPrincipal =>
  ({
    id: 'staff-1',
    email: 'staff@example.test',
    firstName: 'Ada',
    lastName: 'Obi',
    roleCode: 'trust_safety',
    permissions: new Set(permissions),
    sessionId: 'session-1',
  }) as AdminPrincipal;

/**
 * R8, which is the whole of §5.23's access control.
 *
 * The rule has existed since M0 and until now had two callers and no test — and it is the kind of
 * rule that cannot be checked by reading the endpoint, because the endpoint is identical for all
 * three permission levels. What differs is a `where` fragment, so that is what this asserts.
 *
 * The failure it guards against is not an error. A scope that returns `{}` for the wrong
 * permission is a working endpoint that serves the whole trail — safeguarding entries, Guard
 * reads, a member's contact details in a `before` — to somebody who should see their own actions.
 * Nothing fails; the page is just longer than it should be.
 */
describe('audit scope (R8)', () => {
  it('gives `audit:read` everything, as an empty filter rather than a list of areas', () => {
    // `{}` and not `{ area: { in: [...all] } }`: an enumerated list would silently exclude a new
    // area until somebody remembered to add it, and the holder of this permission is defined as
    // seeing all of it.
    expect(auditScopeFor(principal('audit:read'))).toEqual({});
  });

  it('gives `audit:read_area` its two areas **and** its own actions', () => {
    // The second half is not a convenience. Somebody must always be able to account for what they
    // themselves did, including the actions outside their area — a T&S reviewer who edited a
    // member's details has a MEMBERS entry, and being unable to see it would make them the only
    // person who cannot answer for it.
    expect(auditScopeFor(principal('audit:read_area'))).toEqual({
      OR: [{ area: { in: SCOPED_AREAS } }, { actorId: 'staff-1' }],
    });
  });

  it('scopes `audit:read_area` to Trust & Safety’s own two areas and no others', () => {
    expect(SCOPED_AREAS).toEqual([AuditArea.SAFETY, AuditArea.CONTENT]);
    // In particular not AUTH, TEAM or MEMBERS: who signed in, who was promoted and whose contact
    // details were revealed are not a moderator's business.
    for (const area of [AuditArea.AUTH, AuditArea.TEAM, AuditArea.MEMBERS]) {
      expect(SCOPED_AREAS).not.toContain(area);
    }
  });

  it('gives `audit:read_self` only its own actions, with no area escape', () => {
    expect(auditScopeFor(principal('audit:read_self'))).toEqual({ actorId: 'staff-1' });
  });

  it('refuses a caller with none of the three, rather than defaulting to anything', () => {
    // Null, which every caller turns into a 403. A `{}` here would be the one-line mistake that
    // opens the whole trail to any signed-in staff member.
    expect(auditScopeFor(principal())).toBeNull();
    expect(auditScopeFor(principal('members:read', 'support:manage'))).toBeNull();
  });

  it('takes the widest permission a caller holds', () => {
    // Roles are additive, so a manager holds `audit:read` and may also hold the narrower two. The
    // order of the checks is what makes that come out as "everything" rather than "mine".
    expect(auditScopeFor(principal('audit:read', 'audit:read_self'))).toEqual({});
    expect(auditScopeFor(principal('audit:read_area', 'audit:read_self'))).toEqual({
      OR: [{ area: { in: SCOPED_AREAS } }, { actorId: 'staff-1' }],
    });
  });
});

/**
 * The client-event allowlist and the action registry are two lists that have to agree.
 *
 * `POST admin/audit/client-event` is the only path where the **caller** names what goes into an
 * append-only table, and the area is looked up from the registry. So a name in the allowlist that
 * the registry does not know would be an entry with no area — which `areaOf` cannot produce and
 * which the service has a defensive branch for. This is what keeps that branch unreachable.
 */
describe('client-recordable events', () => {
  it('is three things, all of them "somebody took a copy away"', () => {
    expect([...CLIENT_EVENTS]).toEqual([
      'analytics.chart_csv',
      'communications.stats_csv',
      'config.versions_csv',
    ]);
  });

  it('registers every one of them, so none can be filed with no area', () => {
    for (const action of CLIENT_EVENTS) {
      expect(AUDIT_ACTIONS[action as AuditAction]).toBeDefined();
    }
  });

  it('files each in the area of the screen it came from', () => {
    expect(AUDIT_ACTIONS['analytics.chart_csv']).toBe(AuditArea.ANALYTICS);
    expect(AUDIT_ACTIONS['communications.stats_csv']).toBe(AuditArea.COMMS);
    expect(AUDIT_ACTIONS['config.versions_csv']).toBe(AuditArea.CONFIG);
  });

  it('lets the client record nothing that changes anything', () => {
    // The allowlist's real job. Every name on it is a read that happened in a browser; none of
    // them is an action with an effect, so a compromised portal build cannot write
    // `member.suspended` into a table nothing deletes from.
    for (const action of CLIENT_EVENTS) {
      expect(action).toMatch(/_csv$/);
    }
  });
});
