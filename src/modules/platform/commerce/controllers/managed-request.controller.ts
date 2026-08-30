import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard } from '@/common';
import { ManagedRequestDto } from '../../professionals/dtos/booking.dto';
import { ManagedRequestService } from '../services/managed-request.service';

@ApiBearerAuth()
@Controller('managed-requests')
@ApiTags('Managed requests')
@UseGuards(JwtAuthGuard)
export class ManagedRequestController {
  constructor(private readonly managed: ManagedRequestService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Ask Circl to take something on',
    description:
      'One resource for both the managed storefront upsell and the professional manual-placement ' +
      "fallback: from the member's side they are the same request, and they land in one team inbox. " +
      'The store, contact details and item count are attached server-side from records already held.',
  })
  async create(@CurrentUserId() userId: string, @Body() dto: ManagedRequestDto) {
    const data = await this.managed.create(userId, dto);

    return { data, message: 'Our team will be in touch' };
  }
}
