import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
  Body,
} from '@nestjs/common';
import { BaseController } from './base.controller';
import { RefreshTokenGuard } from '../guards';
import { Request, Response } from 'express'; // Response used by logout
import { CookieService, AuthService, LogOutService } from '../services';
import { User } from '@prisma/client';
import { DeviceInfo, Public } from '@/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/common/guards';
import { LogoutDto } from '../dtos';
import { AuthSwagger } from '../swagger';

@ApiTags('Auth')
@ApiBearerAuth()
@Controller()
export class TokenController extends BaseController {
  constructor(
    protected readonly cookieService: CookieService,
    private readonly authService: AuthService,
    private readonly logOutService: LogOutService,
  ) {
    super(cookieService);
  }

  @Get('refresh')
  @Public()
  @UseGuards(RefreshTokenGuard)
  @HttpCode(HttpStatus.OK)
  @AuthSwagger.refreshTokens
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async refreshToken(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = this.cookieService.extractRefreshToken(req);
    const deviceInfo = req['deviceInfo'] as DeviceInfo;

    const result = await this.authService.refreshAccessToken(refreshToken, deviceInfo);

    return this.handleAuthResponse(req, res, result);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @AuthSwagger.logout
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: LogoutDto,
  ) {
    const user = req.user as User;
    const deviceInfo = req['deviceInfo'] as DeviceInfo;

    const response = await this.logOutService.logout(user.id, deviceInfo, dto);

    return this.handleLogOutResponse(req, res, response);
  }
}
