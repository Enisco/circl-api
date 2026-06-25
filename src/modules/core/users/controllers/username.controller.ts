import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, Role, RoleGuard, USER_ROLE_CODE } from '@/common';
import { ProfileService } from '../services';
import { CheckUsernameDto } from '../dtos';
import { ProfileSwagger } from '../swagger';

@Controller('check-username')
@ApiTags('Users')
@UseGuards(JwtAuthGuard, RoleGuard)
@Role(USER_ROLE_CODE)
export class UsernameController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ProfileSwagger.checkUsername
  async checkUsername(@Query() dto: CheckUsernameDto) {
    return this.profileService.checkUsername(dto.username);
  }
}
