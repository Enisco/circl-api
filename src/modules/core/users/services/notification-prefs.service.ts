import { PrismaService } from '@/infrastructure';
import { Injectable } from '@nestjs/common';
import { RegisterDeviceTokenDto } from '../dtos';

@Injectable()
export class NotificationPrefsService {
  constructor(private readonly database: PrismaService) {}

  async registerDeviceToken(userId: string, dto: RegisterDeviceTokenDto) {
    await this.database.userNotificationPrefs.upsert({
      where: { userId },
      create: { userId, devicePushToken: dto.token },
      update: { devicePushToken: dto.token },
    });

    return { message: 'Device token registered' };
  }
}
