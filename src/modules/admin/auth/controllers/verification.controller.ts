import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminSendVerificationTokenDto, VerifyPasswordResetTokenDto } from '../dtos';
import { VerificationService } from '../services';
import { AuthSwagger } from '../swagger';

@Controller('verify')
@ApiTags('Admin - Auth')
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @AuthSwagger.sendVerificationToken
  async sendVerifyToken(@Body() dto: AdminSendVerificationTokenDto) {
    return this.verificationService.sendVerifyToken(dto);
  }

  @Post('password-reset')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @AuthSwagger.verifyPasswordResetToken
  async verifyPasswordResetToken(@Body() dto: VerifyPasswordResetTokenDto) {
    return this.verificationService.verifyPasswordResetToken(dto);
  }
}
