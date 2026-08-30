import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard, Role, RoleGuard, USER_ROLE_CODE } from '@/common';
import { User } from '@prisma/client';
import { ProfileService } from '../services';
import { UpdateProfileDto } from '../dtos';
import { ProfileSwagger } from '../swagger';

@ApiBearerAuth()
@Controller('profile')
@ApiTags('Users')
@UseGuards(JwtAuthGuard, RoleGuard)
@Role(USER_ROLE_CODE)
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ProfileSwagger.getProfile
  async getProfile(@Req() req: Request) {
    const user = req.user as User;

    return this.profileService.getProfile(user.id);
  }

  @Patch()
  @HttpCode(HttpStatus.OK)
  @ProfileSwagger.updateProfile
  async updateProfile(@Req() req: Request, @Body() dto: UpdateProfileDto) {
    const user = req.user as User;

    return this.profileService.updateProfile(user.id, dto);
  }
}
