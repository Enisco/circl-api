import { BadRequestException, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '@/infrastructure';
import { ErrorMessage, SuccessMessage } from '@/common';
import {
  AdminSendVerificationTokenDto,
  AdminVerificationType,
  VerifyPasswordResetTokenDto,
} from '../dtos';
import { VerificationResponse } from '../types';
import { VerificationEventService } from './verification-event.service';

@Injectable()
export class VerificationService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly database: PrismaService,
    private readonly verificationEventService: VerificationEventService,
  ) {
    this.logger.setContext(VerificationService.name);
  }

  async sendVerifyToken(dto: AdminSendVerificationTokenDto): Promise<VerificationResponse> {
    const user = await this.database.user.findUnique({
      where: { email: dto.email, isStaff: true },
    });

    if (!user) {
      return { success: true, message: SuccessMessage.VERIFICATION_EMAIL_SENT };
    }

    await this.verificationEventService.sendVerificationEmail(user, dto.type);

    return { success: true, message: SuccessMessage.VERIFICATION_EMAIL_SENT };
  }

  async verifyPasswordResetToken(dto: VerifyPasswordResetTokenDto): Promise<VerificationResponse> {
    const isValid = await this.verificationEventService.validateCode(
      AdminVerificationType.PASSWORD_RESET,
      dto.email,
      dto.code,
    );

    if (!isValid) {
      throw new BadRequestException(ErrorMessage.INVALID_VERIFICATION_CODE);
    }

    return { success: true, message: SuccessMessage.VALID_VERIFICATION_CODE };
  }
}
