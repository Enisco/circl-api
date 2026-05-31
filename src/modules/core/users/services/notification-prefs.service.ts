import { ErrorMessage, SuccessMessage } from '@/common';
import { PrismaService } from '@/infrastructure';
import { Injectable, NotFoundException } from '@nestjs/common';
import { RegisterDeviceTokenDto } from '../dtos';

@Injectable()
export class NotificationPrefsService {
  constructor(private readonly database: PrismaService) {}

  async getPrefs(userId: string) {
    const prefs = await this.database.userNotificationPrefs.findUnique({
      where: { userId },
      select: {
        devicePushToken: true,
        updatedAt: true,
      },
    });

    if (!prefs)
      throw new NotFoundException(ErrorMessage.RESOURCE_NOT_FOUND('notification preferences'));

    return { message: SuccessMessage.RESOURCE_FETCHED('Notification preferences'), data: prefs };
  }

  async registerDeviceToken(userId: string, dto: RegisterDeviceTokenDto) {
    await this.database.userNotificationPrefs.upsert({
      where: { userId },
      create: { userId, devicePushToken: dto.token },
      update: { devicePushToken: dto.token },
    });

    return { message: 'Device token registered' };
  }
}
