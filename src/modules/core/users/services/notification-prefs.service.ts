import { PrismaService } from '@/infrastructure';
import { Injectable } from '@nestjs/common';
import { RegisterDeviceTokenDto, ReleaseDeviceTokenDto } from '../dtos';

@Injectable()
export class NotificationPrefsService {
  constructor(private readonly database: PrismaService) {}

  async registerDeviceToken(userId: string, dto: RegisterDeviceTokenDto) {
    await this.database.$transaction(async tx => {
      // A handset that changes hands moves, rather than sitting on two accounts and delivering
      // the previous member's notifications to whoever holds it now (G18).
      await tx.userNotificationPrefs.updateMany({
        where: { devicePushToken: dto.token, userId: { not: userId } },
        data: { devicePushToken: null },
      });

      await tx.userNotificationPrefs.upsert({
        where: { userId },
        create: { userId, devicePushToken: dto.token },
        update: { devicePushToken: dto.token },
      });
    });

    return { message: 'Device token registered' };
  }

  /**
   * Called during logout, before the client clears its keychain. Only the server can drop the
   * row: the client forgetting the token locally leaves it pointing this handset at the member
   * who just left.
   */
  async releaseDeviceToken(userId: string, dto: ReleaseDeviceTokenDto) {
    // Releasing a token that is already gone is a success, not a 404: a failed release must never
    // block signing out.
    await this.database.userNotificationPrefs.updateMany({
      where: { userId, devicePushToken: dto.token },
      data: { devicePushToken: null },
    });
  }
}
