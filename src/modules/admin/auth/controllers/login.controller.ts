import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { User } from '@prisma/client';
import { DeviceInfo } from '@/common';
import { AdminLoginDto } from '../dtos';
import { CookieService, LoginService } from '../services';
import { AdminLocalAuthGuard } from '../guards';
import { AuthSwagger } from '../swagger';
import { BaseController } from './base.controller';

@Controller('login')
@ApiTags('Admin - Auth')
export class LoginController extends BaseController {
  constructor(
    private readonly loginService: LoginService,
    protected readonly cookieService: CookieService,
  ) {
    super(cookieService);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AdminLocalAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @AuthSwagger.login
  async login(
    @Body() _dto: AdminLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = req.user as User;
    const deviceInfo = req['deviceInfo'] as DeviceInfo;
    const sessionId = req.headers['x-session-id'] as string;
    const response = await this.loginService.login(user, deviceInfo, sessionId);

    return this.handleAuthResponse(res, response);
  }
}
