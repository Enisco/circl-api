import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard, Role, RoleGuard, USER_ROLE_CODE } from '@/common';
import { User } from '@prisma/client';
import { NotificationPrefsService } from '../services/notification-prefs.service';
import { RegisterDeviceTokenDto, ReleaseDeviceTokenDto } from '../dtos';
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

  @Delete('device-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Release this device\'s push token',
    description:
      'Called during logout. Releasing a token that is already gone succeeds: a failed release ' +
      'must not block signing out.',
  })
  async releaseDeviceToken(@Req() req: Request, @Body() dto: ReleaseDeviceTokenDto) {
    const user = req.user as User;

    await this.notificationPrefs.releaseDeviceToken(user.id, dto);
  }
}
