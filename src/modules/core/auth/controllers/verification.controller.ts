import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { CookieService, VerificationService, SocialAuthService } from '../services';
import { SendVerificationTokenDto, SocialAuthDto, VerifyEmailDto } from '../dtos';
import { DeviceInfo } from '@/common';
import { AuthSwagger } from '../swagger';
import { BaseController } from './base.controller';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

@Controller('verify')
@ApiTags('Auth')
export class VerificationController extends BaseController {
  constructor(
    private readonly verificationService: VerificationService,
    private readonly socialAuthService: SocialAuthService,
    protected readonly cookieService: CookieService,
  ) {
    super(cookieService);
  }

  @Post('send')
  @AuthSwagger.sendVerificationToken
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async sendVerifyToken(@Body() dto: SendVerificationTokenDto) {
    return this.verificationService.sendVerifyAccountToken(dto);
  }

  @Post('social')
  @HttpCode(HttpStatus.OK)
  @AuthSwagger.socialVerify
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async socialVerify(
    @Body() dto: SocialAuthDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const deviceInfo = req['deviceInfo'] as DeviceInfo;
    const result = await this.socialAuthService.handleSocialAuth(dto, deviceInfo);

    if (result.isNewUser) {
      return result;
    }

    return this.handleAuthResponse(req, res, result);
  }

  @Post('email')
  @AuthSwagger.verifyAccount
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async verifyAccount(
    @Body() body: VerifyEmailDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const deviceInfo = req['deviceInfo'] as DeviceInfo;
    const response = await this.verificationService.verifyAccount(body, deviceInfo);

    return this.handleAuthResponse(req, res, response);
  }
}
