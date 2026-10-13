import { Module } from '@nestjs/common';
import { BookingService } from './services/booking.service';
import { DisputeService } from './services/dispute.service';

/**
 * Bookings and disputes — the services, with no routes.
 *
 * Split out from `ProfessionalsModule` so the admin surface can create a booking **on a member's
 * behalf** (§5.16's brief placement) and read a dispute's subject (§5.17) without also mounting
 * four member controllers. A staff process serving `POST /professionals/bookings` would be a
 * member endpoint in a place nobody is looking for one — the same reason `ModerationCoreModule`,
 * `GuardCoreModule` and `AccountCoreModule` exist.
 *
 * The placement is the interesting one. §5.16 says staff place a member by creating the booking
 * they would have created themselves, which means the same state, the same thread, the same
 * notification to the professional and the same `NOT_ACCEPTING_WORK` refusal. A second
 * implementation in the admin service would be a second definition of what a booking is, and the
 * failure mode is a staff placement the professional's own screens do not recognise.
 */
@Module({
  providers: [BookingService, DisputeService],
  exports: [BookingService, DisputeService],
})
export class ProfessionalsCoreModule {}
