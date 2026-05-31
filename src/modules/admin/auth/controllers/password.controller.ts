import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ForgotPasswordDto, ResetPasswordDto } from '../dtos';
import { PasswordService } from '../services';
import { AuthSwagger } from '../swagger';

@Controller('password')
@ApiTags('Admin - Auth')
export class PasswordController {
  constructor(private readonly passwordService: PasswordService) {}

  @Post('forgot')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @AuthSwagger.forgotPassword
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.passwordService.forgotPassword(dto);
  }

  @Post('reset')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @AuthSwagger.resetPassword
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.passwordService.resetPassword(dto);
  }
}
