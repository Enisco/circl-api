import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { RegisterUserDto } from '../dtos';
import { RegisterService, CookieService } from '../services';
import { AuthSwagger } from '../swagger';
import { BaseController } from './base.controller';
import { DeviceInfo } from '@/common';
import { Throttle } from '@nestjs/throttler';

@Controller()
@ApiTags('Auth')
export class RegisterController extends BaseController {
  constructor(
    private readonly registerService: RegisterService,
    protected readonly cookieService: CookieService,
  ) {
    super(cookieService);
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @AuthSwagger.register
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async register(
    @Body() dto: RegisterUserDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const deviceInfo = req['deviceInfo'] as DeviceInfo;
    const response = await this.registerService.register(dto, deviceInfo);

    return this.handleAuthResponse(req, res, response);
  }
}
