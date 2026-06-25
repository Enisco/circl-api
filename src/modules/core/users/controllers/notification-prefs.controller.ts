import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard, Role, RoleGuard, USER_ROLE_CODE } from '@/common';
import { User } from '@prisma/client';
import { NotificationPrefsService } from '../services/notification-prefs.service';
import { RegisterDeviceTokenDto, UpdateNotificationPrefsDto } from '../dtos';
import { NotificationPrefsSwagger } from '../swagger';

@Controller('notification-preferences')
@ApiTags('Users')
@UseGuards(JwtAuthGuard, RoleGuard)
@Role(USER_ROLE_CODE)
export class NotificationPrefsController {
  constructor(private readonly notificationPrefs: NotificationPrefsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @NotificationPrefsSwagger.getPrefs
  async getPrefs(@Req() req: Request) {
    const user = req.user as User;

    return this.notificationPrefs.getPrefs(user.id);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @NotificationPrefsSwagger.updatePrefs
  async updatePrefs(@Req() req: Request, @Body() dto: UpdateNotificationPrefsDto) {
    const user = req.user as User;

    return this.notificationPrefs.updatePrefs(user.id, dto);
  }

  @Post('device-token')
  @HttpCode(HttpStatus.OK)
  @NotificationPrefsSwagger.registerDeviceToken
  async registerDeviceToken(@Req() req: Request, @Body() dto: RegisterDeviceTokenDto) {
    const user = req.user as User;

    return this.notificationPrefs.registerDeviceToken(user.id, dto);
  }
}
