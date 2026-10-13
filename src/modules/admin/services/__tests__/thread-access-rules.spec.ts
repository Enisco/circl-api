import { ThreadAccessLinkType, ThreadKind } from '@prisma/client';
import { AdminPolicyService } from '../../common/admin-policy.service';
import { AdminPrincipal } from '../../common/admin-principal';
import { AdminThreadAccessService } from '../admin-thread-access.service';

const principal = (...permissions: string[]): AdminPrincipal =>
  ({
    id: 'staff-1',
    email: 'staff@example.test',
    firstName: 'Ada',
    lastName: 'Obi',
    roleCode: 'support',
    permissions: new Set(['messages:read', ...permissions]),
    sessionId: 'session-1',
  }) as AdminPrincipal;

/**
 * S9.1's three conditions, driven through the service with a hand-made database.
 *
 * Unit rather than e2e because the interesting cases are combinations of permission, existence and
 * who the record is about — and the e2e would need a dispute, a Guard case, an escalation and a
 * queue item each wired to the right members to produce one of them.
 */
const CONVERSATION = {
  id: 'conv-1',
  kind: ThreadKind.DIRECT,
  contextType: null,
  contextId: null,
  contextSnapshot: null,
  messageCount: 2,
  lastMessageAt: new Date(),
  createdAt: new Date(),
  guardThread: null,
  supportThread: null,
};

/** Two members, and a third who is in nothing. */
const ALICE = 'member-alice';
const BOB = 'member-bob';
const STRANGER = 'member-stranger';

type Overrides = Partial<{
  conversation: unknown;
  participants: string[];
  reportCase: unknown;
  escalation: unknown;
  guardThread: unknown;
  queueItem: unknown;
  dispute: unknown;
  supportThread: unknown;
}>;

const build = (overrides: Overrides = {}) => {
  const grants: Array<Record<string, unknown>> = [];
  const audit = { mutate: jest.fn(), note: jest.fn() };

  const database = {
    conversation: {
      findUnique: jest.fn(async () => overrides.conversation ?? CONVERSATION),
      findUniqueOrThrow: jest.fn(async () => overrides.conversation ?? CONVERSATION),
    },
    conversationParticipant: {
      findMany: jest.fn(async () =>
        (overrides.participants ?? [ALICE, BOB]).map(userId => ({
          userId,
          role: 'MEMBER',
          joinedAt: new Date(),
          leftAt: null,
          user: { id: userId },
        })),
      ),
    },
    reportCase: { findUnique: jest.fn(async () => overrides.reportCase ?? null) },
    escalation: { findUnique: jest.fn(async () => overrides.escalation ?? null) },
    guardThread: { findUnique: jest.fn(async () => overrides.guardThread ?? null) },
    moderationQueueItem: { findUnique: jest.fn(async () => overrides.queueItem ?? null) },
    dispute: { findUnique: jest.fn(async () => overrides.dispute ?? null) },
    supportThread: { findUnique: jest.fn(async () => overrides.supportThread ?? null) },
    message: { findUnique: jest.fn(async () => null) },
    threadAccessGrant: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `grant-${grants.length + 1}`, ...data };

        grants.push(row);

        return row;
      }),
    },
  };

  audit.mutate.mockImplementation(
    async (draft: unknown, work: (tx: unknown) => Promise<unknown>) => {
      const result = await work(database);

      return { result, auditId: 'audit-1', draft };
    },
  );

  const service = new AdminThreadAccessService(
    database as never,
    {} as never,
    { sign: () => null } as never,
    audit as never,
    new AdminPolicyService(database as never),
  );

  return { service, database, audit, grants };
};

const refusal = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    const typed = error as { getStatus(): number; code?: string };

    return { status: typed.getStatus(), code: typed.code ?? null };
  }

  return { status: 200, code: null };
};

const ask = (
  service: AdminThreadAccessService,
  actor: AdminPrincipal,
  linkedType: ThreadAccessLinkType,
  linkedId = 'link-1',
) =>
  service.grant(actor, 'conv-1', {
    reasonCode: 'SAFETY_CONCERN' as never,
    linkedType,
    linkedId,
  });

describe('a grant needs a real, visible, participant-linked record (S9.1)', () => {
  it('is refused when the caller cannot see that kind of record at all', async () => {
    const { service } = build({
      reportCase: { targetUserId: ALICE, targetType: 'USER', targetId: ALICE },
    });

    // `messages:read` only: enough to list a member's threads, not enough to name a report case
    // as the reason for reading one.
    expect(
      await refusal(() => ask(service, principal(), ThreadAccessLinkType.REPORT_CASE)),
    ).toEqual({ status: 422, code: 'LINK_REQUIRED' });
  });

  it('is refused when the record does not exist', async () => {
    const { service } = build();

    expect(
      await refusal(() =>
        ask(service, principal('reports:read'), ThreadAccessLinkType.REPORT_CASE),
      ),
    ).toEqual({ status: 422, code: 'LINK_REQUIRED' });
  });

  it('is refused when the record is about nobody in the conversation', async () => {
    const { service } = build({
      reportCase: { targetUserId: STRANGER, targetType: 'USER', targetId: STRANGER },
    });

    expect(
      await refusal(() =>
        ask(service, principal('reports:read'), ThreadAccessLinkType.REPORT_CASE),
      ),
    ).toEqual({ status: 422, code: 'LINK_REQUIRED' });
  });

  it('is granted when all three hold, for thirty minutes', async () => {
    const { service, grants } = build({
      reportCase: { targetUserId: ALICE, targetType: 'USER', targetId: ALICE },
    });
    const result = await ask(service, principal('reports:read'), ThreadAccessLinkType.REPORT_CASE);

    expect(result.grantId).toBe('grant-1');
    expect(result.expiresInSeconds).toBe(1800);

    const minutes = Math.round(((grants[0].expiresAt as Date).getTime() - Date.now()) / 60_000);

    expect(minutes).toBe(30);
  });

  it('is refused for a case a participant merely **filed**', async () => {
    const { service } = build({
      reportCase: { targetUserId: STRANGER, targetType: 'USER', targetId: STRANGER },
    });

    // The generous version of this rule counted the reporters, and that was the hole: a member who
    // has ever reported anybody then holds a case id that opens any thread they are in.
    expect(
      await refusal(() =>
        ask(service, principal('reports:read'), ThreadAccessLinkType.REPORT_CASE),
      ),
    ).toEqual({ status: 422, code: 'LINK_REQUIRED' });
  });

  it('accepts a case whose target is a message in this very thread', async () => {
    const { service, database } = build({
      reportCase: { targetUserId: null, targetType: 'MESSAGE', targetId: 'message-1' },
    });

    (database as unknown as { message: { findUnique: jest.Mock } }).message = {
      findUnique: jest.fn(async () => ({ conversationId: 'conv-1' })),
    };

    const result = await ask(service, principal('reports:read'), ThreadAccessLinkType.REPORT_CASE);

    expect(result.grantId).toBe('grant-1');
  });

  it('accepts a dispute from either side of the booking it is about', async () => {
    const { service } = build({
      dispute: {
        raisedById: STRANGER,
        booking: { clientId: STRANGER, professionalId: BOB },
        enquiry: null,
      },
    });

    const result = await ask(service, principal('disputes:manage'), ThreadAccessLinkType.DISPUTE);

    expect(result.grantId).toBe('grant-1');
  });

  it('refuses a dispute to somebody who cannot read disputes', async () => {
    const { service } = build({
      dispute: { raisedById: ALICE, booking: null, enquiry: { buyerId: ALICE, sellerId: BOB } },
    });

    expect(
      await refusal(() => ask(service, principal('reports:read'), ThreadAccessLinkType.DISPUTE)),
    ).toEqual({ status: 422, code: 'LINK_REQUIRED' });
  });

  it('applies R7 to a Guard thread used as the reason, not a bare support:read', async () => {
    const { service } = build({ supportThread: { memberId: ALICE, type: 'GUARD' } });

    // A support agent holds `support:read` and not `guard:read`. R7's refusal is a 404 — the
    // existence of a safeguarding case is itself the disclosure.
    expect(
      await refusal(() =>
        ask(service, principal('support:read'), ThreadAccessLinkType.SUPPORT_THREAD),
      ),
    ).toEqual({ status: 404, code: 'NOT_FOUND' });

    const safety = build({ supportThread: { memberId: ALICE, type: 'GUARD' } });
    const result = await ask(
      safety.service,
      principal('support:read', 'guard:read'),
      ThreadAccessLinkType.SUPPORT_THREAD,
    );

    expect(result.grantId).toBe('grant-1');
  });

  it('accepts a queue item about a member in the conversation', async () => {
    const { service } = build({
      queueItem: { subjectUserId: BOB, targetType: 'MESSAGE', targetId: 'message-1' },
    });

    const result = await ask(
      service,
      principal('moderation:read'),
      ThreadAccessLinkType.QUEUE_ITEM,
    );

    expect(result.grantId).toBe('grant-1');
  });
});

describe('support and Guard threads are not read here', () => {
  it('redirects a SUPPORT conversation to the inbox', async () => {
    const { service } = build({
      conversation: {
        ...CONVERSATION,
        kind: ThreadKind.SUPPORT,
        supportThread: { conversationId: 'conv-1' },
      },
    });

    expect(
      await refusal(() =>
        ask(service, principal('reports:read'), ThreadAccessLinkType.REPORT_CASE),
      ),
    ).toEqual({ status: 409, code: 'USE_SUPPORT_INBOX' });
  });

  it('redirects a Guard case to the Guard case, whatever the conversation kind says', async () => {
    const { service } = build({
      conversation: { ...CONVERSATION, guardThread: { id: 'guard-1' } },
    });

    expect(
      await refusal(() =>
        ask(service, principal('reports:read'), ThreadAccessLinkType.REPORT_CASE),
      ),
    ).toEqual({ status: 409, code: 'USE_SUPPORT_INBOX' });
  });
});
