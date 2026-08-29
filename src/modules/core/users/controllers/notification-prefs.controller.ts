import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard, Role, RoleGuard, USER_ROLE_CODE } from '@/common';
import { User } from '@prisma/client';
import { NotificationPrefsService } from '../services/notification-prefs.service';
import { RegisterDeviceTokenDto } from '../dtos';
import { NotificationPrefsSwagger } from '../swagger';

/** Only the device token lives here now. */
@Controller('notification-preferences')
@ApiTags('Users')
@UseGuards(JwtAuthGuard, RoleGuard)
@Role(USER_ROLE_CODE)
export class NotificationPrefsController {
  constructor(private readonly notificationPrefs: NotificationPrefsService) {}

  @Post('device-token')
  @HttpCode(HttpStatus.OK)
  @NotificationPrefsSwagger.registerDeviceToken
  async registerDeviceToken(@Req() req: Request, @Body() dto: RegisterDeviceTokenDto) {
    const user = req.user as User;

    return this.notificationPrefs.registerDeviceToken(user.id, dto);
  }
}
