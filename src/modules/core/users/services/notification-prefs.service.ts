import { PrismaService } from '@/infrastructure';
import { Injectable } from '@nestjs/common';
import { RegisterDeviceTokenDto, ReleaseDeviceTokenDto } from '../dtos';

/** A bound on token churn, not a product limit. Least recently seen goes first. */
const MAX_DEVICES_PER_USER = 10;

@Injectable()
export class NotificationPrefsService {
  constructor(private readonly database: PrismaService) {}

  /** Called on every launch: re-registering is how a rotated token replaces its predecessor. */
  async registerDeviceToken(userId: string, dto: RegisterDeviceTokenDto) {
    await this.database.$transaction(async tx => {
      // Keyed on the token, so a handset that changes hands MOVES to whoever signed in rather
      // than sitting on two accounts and delivering the previous member's notifications (G18).
      await tx.pushDevice.upsert({
        where: { token: dto.token },
        create: { userId, token: dto.token, platform: dto.platform ?? null },
        update: { userId, platform: dto.platform ?? null, lastSeenAt: new Date() },
      });

      const stale = await tx.pushDevice.findMany({
        where: { userId },
        orderBy: { lastSeenAt: 'desc' },
        select: { id: true },
        skip: MAX_DEVICES_PER_USER,
      });

      if (stale.length) {
        await tx.pushDevice.deleteMany({ where: { id: { in: stale.map(row => row.id) } } });
      }
    });

    return { message: 'Device token registered' };
  }

  /**
   * Logout, before the client clears its keychain: only the server can drop the row. One device,
   * so signing out of a tablet does not stop push to the phone.
   */
  async releaseDeviceToken(userId: string, dto: ReleaseDeviceTokenDto) {
    // Releasing a token that is already gone is a success, not a 404: a failed release must never
    // block signing out.
    await this.database.pushDevice.deleteMany({ where: { userId, token: dto.token } });
  }
}
