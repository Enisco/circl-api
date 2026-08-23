import { Controller, Get, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard } from '@/common';
import { VerificationService } from '../services/verification.service';

@Controller('verification')
@ApiTags('Trust · Verification')
@UseGuards(JwtAuthGuard)
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get('status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What this member has already proved',
    description:
      'Called before any verification step in any section. Verification does not ship this ' +
      'release (D13): every check reads NOT_STARTED apart from EMAIL, which is granted at signup ' +
      'and never re-verified. Shipping the endpoint now means the next release adds a flow rather ' +
      'than a data model. The three submit endpoints are deliberately not built.',
  })
  async status(@CurrentUserId() userId: string) {
    const data = await this.verification.status(userId);

    return { data, message: 'Verification status loaded' };
  }
}
