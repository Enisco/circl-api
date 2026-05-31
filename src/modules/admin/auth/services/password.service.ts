import { BadRequestException, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '@/infrastructure';
import { ErrorMessage, SuccessMessage, Util } from '@/common';
import { ForgotPasswordDto, ResetPasswordDto, AdminVerificationType } from '../dtos';
import { SessionService } from './session.service';
import { VerificationEventService } from './verification-event.service';

@Injectable()
export class PasswordService {
  constructor(
    private readonly database: PrismaService,
    private readonly sessionService: SessionService,
    private readonly verificationEventService: VerificationEventService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PasswordService.name);
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.database.user.findUnique({
      where: { email: dto.email, isStaff: true },
    });

    if (!user) {
      return { message: SuccessMessage.PASSWORD_RESET_EMAIL_SENT };
    }

    await this.verificationEventService.sendVerificationEmail(
      user,
      AdminVerificationType.PASSWORD_RESET,
    );

    return { message: SuccessMessage.PASSWORD_RESET_EMAIL_SENT };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const user = await this.database.user.findUnique({
      where: { email: dto.email, isStaff: true },
      select: {
        id: true,
        email: true,
        firstName: true,
        userAuth: { select: { password: true } },
      },
    });

    if (!user) {
      throw new BadRequestException(ErrorMessage.RESOURCE_NOT_FOUND('user'));
    }

    const isSamePassword = await Util.validateHash(dto.password, user.userAuth.password);

    if (isSamePassword) {
      throw new BadRequestException(ErrorMessage.PASSWORD_SAME_AS_OLD);
    }

    const isCodeValid = await this.verificationEventService.validateCode(
      AdminVerificationType.PASSWORD_RESET,
      dto.email,
      dto.code,
    );

    if (!isCodeValid) {
      throw new BadRequestException(ErrorMessage.INVALID_VERIFICATION_CODE);
    }

    await this.verificationEventService.deleteCode(AdminVerificationType.PASSWORD_RESET, dto.email);

    await this.database.userAuth.update({
      where: { userId: user.id },
      data: { password: await Util.generateHash(dto.password), passwordUpdatedAt: new Date() },
    });

    await this.sessionService.revoke(null, user.id, true);

    return { message: SuccessMessage.PASSWORD_RESET_SUCCESSFUL };
  }
}
