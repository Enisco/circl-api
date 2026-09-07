import { PrismaService } from '@/infrastructure';
import { Injectable } from '@nestjs/common';
import { RegisterDeviceTokenDto, ReleaseDeviceTokenDto } from '../dtos';

/**
 * How many handsets one member can hold at once. Not a product limit anybody will meet: it is a
 * bound on token churn, because FCM rotates a token when an app is restored to a new device and
 * the old one may never fail loudly enough to be pruned on send. The least recently seen goes
 * first, so the phone in a pocket outlives the tablet in a drawer.
 */
const MAX_DEVICES_PER_USER = 10;

@Injectable()
export class NotificationPrefsService {
  constructor(private readonly database: PrismaService) {}

  /**
   * Called on every launch, not only the first: re-registering is how the client tells us the
   * token is still good, and how a rotated one replaces the one it replaced.
   */
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
   * Called during logout, before the client clears its keychain. Only the server can drop the
   * row: the client forgetting the token locally leaves it pointing this handset at the member
   * who just left.
   *
   * One device, not all of them. Signing out of a tablet must not stop push to the phone.
   */
  async releaseDeviceToken(userId: string, dto: ReleaseDeviceTokenDto) {
    // Releasing a token that is already gone is a success, not a 404: a failed release must never
    // block signing out.
    await this.database.pushDevice.deleteMany({ where: { userId, token: dto.token } });
  }
}
