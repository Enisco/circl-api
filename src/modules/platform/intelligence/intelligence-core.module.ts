import { Module } from '@nestjs/common';
import { AutoGuideService } from './services/auto-guide.service';

/**
 * The one Intelligence service the admin API needs — no routes, and nothing else.
 *
 * Approving an `AUTO_GUIDE` queue item publishes the draft guide it is about (§5.9), so the staff
 * process has to be able to do that. Deliberately one service rather than
 * `IntelligenceModule`: that one mounts `PulseController` and provides eight more services with
 * their own dependencies, and `ADMIN_SURFACE_DEPENDENCIES` is a list whose whole value is being
 * short — every entry is something the two deployments would have to agree about forever.
 *
 * `AutoGuideService` needs only Prisma and `QueueDeadlineService`, both of which the admin surface
 * already has.
 */
@Module({ providers: [AutoGuideService], exports: [AutoGuideService] })
export class IntelligenceCoreModule {}
