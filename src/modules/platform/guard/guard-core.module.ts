import { Module } from '@nestjs/common';
import { GuardService } from './services/guard.service';

/**
 * Circl Guard's thread handling — the service, with no routes.
 *
 * Split out from `CirclGuardModule` so the admin surface can open a Guard case without also
 * mounting `GuardController`. A staff process serving `POST guard/threads` would be a
 * member-facing endpoint in a place nobody is looking for one, which is the same reason
 * `AccountCoreModule` exists.
 *
 * Staff need this because §5.12's manual escalation opens **the member's existing thread** (D36)
 * rather than a second one beside it. That rule lives in one transaction here, and a copy of it in
 * the admin service would be a second place for it to drift — which matters more than usual,
 * because the failure mode is a safeguarding conversation split across two threads where each half
 * looks complete.
 */
@Module({ providers: [GuardService], exports: [GuardService] })
export class GuardCoreModule {}
