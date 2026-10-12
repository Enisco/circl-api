import { UserAccountStatus } from '@prisma/client';
import { SocialAuthService } from '../social-auth.service';
import { AccountStateService } from '../account-state.service';

/**
 * §13.2: signing in with Google or Apple is not a way round a suspension.
 *
 * A unit test rather than an e2e one, and deliberately so. The e2e suite can only present an
 * invalid Google token, which `verifyGoogleToken` rejects before the account is ever looked up —
 * so an end-to-end assertion here passes whether the check exists or not. Checked by injecting the
 * fault: commenting the guard out leaves the e2e suite green and fails this.
 *
 * The provider verification is stubbed, which is the only way to get past it, and the assertion is
 * on the thing that matters: that no session is minted.
 */
const build = (status: UserAccountStatus) => {
  const createSession = jest.fn(async () => ({
    sessionId: 'session-1',
    tokenPair: { accessToken: 'a', refreshToken: 'r' },
  }));
  const database = {
    user: {
      findUnique: jest.fn(async () => ({
        id: 'user-1',
        status,
        suspendedUntil: new Date('2026-12-01T00:00:00Z'),
        isAnonymised: false,
        socialAuths: [{ provider: 'GOOGLE', providerId: 'google-1' }],
        profile: { onboardingCompleted: true, onboardingStep: 4 },
      })),
    },
    suspension: {
      findFirst: jest.fn(async () => ({
        startsAt: new Date('2026-11-01T00:00:00Z'),
        endsAt: new Date('2026-12-01T00:00:00Z'),
        note: 'Repeatedly messaging people who asked them to stop.',
      })),
    },
    userSocialAuth: { upsert: jest.fn(async () => ({})) },
  };
  const accountState = new AccountStateService(
    database as never,
    {
      get: () => 'support@circl.test',
    } as never,
  );

  const service = new SocialAuthService(
    { setContext: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() } as never,
    { get: jest.fn(), getOrThrow: jest.fn(() => 'client-id') } as never,
    { verifyAsync: jest.fn() } as never,
    database as never,
    { createSession } as never,
    { sign: jest.fn() } as never,
    accountState,
  );

  // The only part that cannot be reached from outside: a real provider token.
  Object.assign(service as never, {
    verifyGoogleToken: async () => ({ email: 'member@example.test', providerId: 'google-1' }),
  });

  return { service, createSession };
};

const signIn = (service: SocialAuthService) =>
  service.handleSocialAuth(
    { provider: 'GOOGLE', idToken: 'verified-by-the-stub', email: 'member@example.test' } as never,
    { devicePlatform: 'IOS' } as never,
  );

describe('social sign-in for a suspended member', () => {
  it('is refused with ACCOUNT_SUSPENDED, not handed a session', async () => {
    const { service, createSession } = build(UserAccountStatus.SUSPENDED);

    await expect(signIn(service)).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('carries the end date, so the app can say when it ends', async () => {
    const { service } = build(UserAccountStatus.SUSPENDED);

    await expect(signIn(service)).rejects.toMatchObject({
      data: { state: 'SUSPENDED', canUseApp: false },
    });
  });

  it('still lets an active member in', async () => {
    const { service, createSession } = build(UserAccountStatus.ACTIVE);

    await expect(signIn(service)).resolves.toMatchObject({ isNewUser: false });
    expect(createSession).toHaveBeenCalled();
  });
});

/**
 * The refusal shape, which the app parses once for both walls.
 *
 * Driven through `refusalFor` because the 410 originally carried no `data` at all: the `DELETED`
 * branch that writes its copy was unreachable, so a client told to render from `data.state` would
 * have found nothing there. And `deletedAt` was hardcoded null on every branch — a field somebody
 * could read, branch on, and never get an answer from.
 */
describe('the refusal payload', () => {
  const build = () => {
    const database = {
      suspension: {
        findFirst: jest.fn(async () => ({
          startsAt: new Date('2026-11-01T00:00:00Z'),
          endsAt: null,
          note: 'Repeatedly messaging people who asked them to stop.',
        })),
      },
    };

    return new AccountStateService(
      database as never,
      {
        get: () => 'support@circl.test',
      } as never,
    );
  };

  it('answers a deleted account with the same shape as a suspended one', async () => {
    const refusal = await build().refusalFor({
      id: 'user-1',
      status: UserAccountStatus.SUSPENDED,
      isAnonymised: true,
      anonymisedAt: new Date('2026-09-02T10:14:00Z'),
    });

    expect(refusal?.getStatus()).toBe(410);

    const body = refusal?.getResponse() as { data?: Record<string, unknown> };

    expect(body.data?.state).toBe('DELETED');
    expect(body.data?.canUseApp).toBe(false);
    expect(body.data?.suspension).toBeNull();
    // Read off the row rather than hardcoded null, which is what it was on every branch.
    expect(body.data?.deletedAt).toBe('2026-09-02T10:14:00.000Z');
    expect(typeof body.data?.headline).toBe('string');
  });

  it('says a suspension with no end date is permanent, rather than leaving it to be inferred', async () => {
    const refusal = await build().refusalFor({
      id: 'user-1',
      status: UserAccountStatus.SUSPENDED,
      isAnonymised: false,
      suspendedUntil: null,
    });

    expect(refusal?.getStatus()).toBe(403);

    const body = refusal?.getResponse() as { data?: { suspension?: Record<string, unknown> } };

    // `endsAt: null` is also what a legacy row looks like, so a client reading it as "permanent"
    // would one day tell somebody their account was gone for good when the row simply predates
    // the column. `isPermanent` is the field that answers.
    expect(body.data?.suspension?.endsAt).toBeNull();
    expect(body.data?.suspension?.isPermanent).toBe(true);
    expect(body.data?.suspension?.reason).toBe(
      'Repeatedly messaging people who asked them to stop.',
    );
  });

  it('refuses nobody who is simply active', async () => {
    expect(await build().refusalFor({ id: 'user-1', status: UserAccountStatus.ACTIVE })).toBeNull();
  });
});
