import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { User } from '@prisma/client';
import { AdminJwtGuard } from '@/common/guards';
import { DeviceInfo, Public } from '@/common';
import { LogoutDto } from '../dtos';
import { AuthService, CookieService, LogoutService } from '../services';
import { AdminRefreshTokenGuard } from '../guards';
import { AuthSwagger } from '../swagger';
import { BaseController } from './base.controller';
import { Throttle } from '@nestjs/throttler';

@ApiTags('Admin - Auth')
@Controller()
export class TokenController extends BaseController {
  constructor(
    protected readonly cookieService: CookieService,
    private readonly authService: AuthService,
    private readonly logoutService: LogoutService,
  ) {
    super(cookieService);
  }

  @Get('refresh')
  @Public()
  @UseGuards(AdminRefreshTokenGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @AuthSwagger.refreshTokens
  async refreshToken(@Req() req: Request) {
    const refreshToken = this.cookieService.extractRefreshToken(req);
    const deviceInfo = req['deviceInfo'] as DeviceInfo;

    return this.authService.refreshAccessToken(refreshToken, deviceInfo);
  }

  @Post('logout')
  @UseGuards(AdminJwtGuard)
  @HttpCode(HttpStatus.OK)
  @AuthSwagger.logout
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: LogoutDto,
  ) {
    const user = req.user as User;
    const deviceInfo = req['deviceInfo'] as DeviceInfo;
    const response = await this.logoutService.logout(user.id, deviceInfo, dto);

    return this.handleLogOutResponse(res, response);
  }
}
