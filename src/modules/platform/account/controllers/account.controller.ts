import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard } from '@/common';
import { ConfirmDeletionDto } from '../dtos/deletion.dto';
import { AccountDeletionService } from '../services/account-deletion.service';

@Controller('users/me/deletion')
@ApiTags('Account')
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(private readonly deletion: AccountDeletionService) {}

  @Post('request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request account deletion',
    description:
      'Sends a 6-digit code to the email ON THE ACCOUNT, valid 10 minutes, rate limited to 3 an ' +
      'hour. The code never goes to an address supplied in the request: proving the person can ' +
      'read that inbox is the whole control, and it is what makes a deletion triggered by someone ' +
      'who picked up an unlocked phone fail.',
  })
  async request(@CurrentUserId() userId: string) {
    const data = await this.deletion.requestDeletion(userId);

    return { data, message: data.message };
  }

  @Post('confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Confirm deletion',
    description:
      'Anonymises in one transaction and revokes every session. There is no grace period, no ' +
      'soft-delete window and no reversal. Identity is destroyed, not flagged; content is kept and ' +
      're-attributed, because a request thread, a booking and a review are shared records and ' +
      'erasing one side leaves the other with holes. Open bookings and orders are cancelled with a ' +
      'system message telling the other party why.',
  })
  async confirm(@CurrentUserId() userId: string, @Body() dto: ConfirmDeletionDto) {
    await this.deletion.confirmDeletion(userId, dto.code);
  }
}
