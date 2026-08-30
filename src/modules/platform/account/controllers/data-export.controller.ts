import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard, RateLimit, SuccessMessage } from '@/common';
import { DataExportService } from '../services/data-export.service';
import { EmailChangeService } from '../services/email-change.service';
import { ChangeEmailDto, ConfirmEmailChangeDto } from '../dtos/account.dto';

/** Download my data (G9) and change my email (G10). */
@Controller('users/me')
@ApiTags('Users')
@UseGuards(JwtAuthGuard)
export class AccountSettingsController {
  constructor(
    private readonly exports: DataExportService,
    private readonly emailChange: EmailChangeService,
  ) {}

  @Post('data-export')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a copy of my data',
    description:
      'A subject access request under UK GDPR. A second request while one is pending returns 409 ' +
      'rather than queuing a duplicate.',
  })
  async requestExport(@CurrentUserId() userId: string) {
    const { data } = await this.exports.request(userId);

    return { data, message: 'We are putting your data together and will email you a link.' };
  }

  @Get('data-export')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The latest export request', description: 'Null data when there is none.' })
  async latestExport(@CurrentUserId() userId: string) {
    const { data } = await this.exports.latest(userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Data export') };
  }

  @Post('email/change')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit('OTP')
  @ApiOperation({
    summary: 'Start changing the sign-in address',
    description:
      'Sends a six-digit code to the NEW address, because that is the one being proved. 409 ' +
      'EMAIL_TAKEN if it is already on another account.',
  })
  async changeEmail(@CurrentUserId() userId: string, @Body() dto: ChangeEmailDto) {
    return this.emailChange.request(userId, dto);
  }

  @Post('email/change/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finish changing the sign-in address',
    description:
      'Returns the updated user so the row refreshes in place. Deliberately does not invalidate ' +
      'the session: being thrown out mid-flow for changing an email is the worse outcome.',
  })
  async confirmEmailChange(
    @CurrentUserId() userId: string,
    @Body() dto: ConfirmEmailChangeDto,
  ) {
    return this.emailChange.confirm(userId, dto);
  }
}
