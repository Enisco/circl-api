/**
 * Guard's public surface.
 *
 * What other modules — the admin API in particular — may depend on. A deep import into
 * `services/guard.service` couples a caller to this module's file layout; this barrel is the seam.
 */
export { GuardCoreModule } from './guard-core.module';
export { CirclGuardModule } from './guard.module';
export { GuardService } from './services/guard.service';
