import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Idempotent, RateLimit, SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAuthenticated, AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import {
  CreateCityDto,
  ListCitiesDto,
  ListSupportResourcesDto,
  PatchSupportResourceDto,
  UpdateCityDto,
  UpsertSupportResourceDto,
} from '../dtos/admin-places.dto';
import { AdminPlacesService } from '../services/admin-places.service';

/**
 * §5.20: cities, and the numbers the platform hands somebody in trouble.
 *
 * Reading is `config:read`. Changing either is `config:taxonomy` — the same permission as the
 * vocabularies, because this is the same kind of act: editing a list the whole product renders
 * from.
 */
@ApiExcludeController()
@ApiTags('Admin · Places')
@AdminAuthenticated()
@Controller('admin')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminPlacesController {
  constructor(private readonly places: AdminPlacesService) {}

  @Get('cities')
  @AdminPermissions('config:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Every city, with what is in it',
    description:
      '`memberCount` and `contentCount` are the two numbers that decide whether a city can be ' +
      'deactivated safely. `contentCount` is one figure summed across requests, offers, listings ' +
      'and shops, because somebody asking "is anything here" does not want four numbers to add ' +
      'up themselves.\n\n' +
      '`q` matches the id or the name, so searching "milton keynes" finds `MILTON_KEYNES`.',
  })
  async cities(@Query() query: ListCitiesDto) {
    return {
      data: await this.places.listCities(query),
      message: SuccessMessage.RESOURCE_FETCHED('Cities'),
    };
  }

  @Post('cities')
  @AdminPermissions('config:taxonomy')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Add a city',
    description:
      'The `id` is UPPER_SNAKE and **permanent**: every piece of content references it, so a ' +
      'rename would be a silent rewrite of where things happened. There is no rename endpoint ' +
      'and there will not be one — the way out of a mistake is to deactivate it and add the right ' +
      'one.\n\n' +
      'An id that already exists is a 409 **carrying the city**, deactivated or not, because the ' +
      'likeliest cause is one somebody switched off and the right answer is to switch it back on ' +
      'rather than invent `MILTON_KEYNES_2`.\n\n' +
      'Coordinates are optional but worth setting: “near me” and the brief distance scores are ' +
      'computed from them, and a city without them simply never scores on distance.',
  })
  async createCity(@CurrentUser() actor: AdminPrincipal, @Body() dto: CreateCityDto) {
    return { data: await this.places.createCity(actor, dto), message: 'City added' };
  }

  @Patch('cities/:id')
  @AdminPermissions('config:taxonomy')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Edit a city, or take it out of the pickers',
    description:
      'The name is a label and may be changed. The id may not.\n\n' +
      '`isActive: false` hides it from every picker; content already filed against it still ' +
      'resolves to a name, because nothing is deleted from a list that has shipped.\n\n' +
      'Takes effect on the next read: the city cache is five minutes long and is cleared here, ' +
      'because a staff member who renames a city and cannot find the new name concludes the save ' +
      'failed.',
  })
  async updateCity(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: UpdateCityDto,
  ) {
    return { data: await this.places.updateCity(actor, id, dto), message: 'City updated' };
  }

  @Get('support-resources')
  @AdminPermissions('config:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The crisis and advice lines',
    description:
      'In the member’s own order — crisis lines first — so the staff list reads as the app ' +
      'renders it. These are what `GET /guard/resources` serves, and what the force-update gate ' +
      'lets through on a build it is otherwise refusing.',
  })
  async resources(@Query() query: ListSupportResourcesDto) {
    return {
      data: await this.places.listResources(query),
      message: SuccessMessage.RESOURCE_FETCHED('Support resources'),
    };
  }

  @Post('support-resources')
  @AdminPermissions('config:taxonomy')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Add a line',
    description:
      'A line needs a phone number or a URL — 422 otherwise, because a name on its own is ' +
      'something a member in trouble can do nothing with.\n\n' +
      'The key is `(countryCode, name)`, so re-adding a line that was deactivated switches it ' +
      'back on rather than failing: that is the common case, and a second “Samaritans” row is ' +
      'not what anybody wanted.',
  })
  async createResource(
    @CurrentUser() actor: AdminPrincipal,
    @Body() dto: UpsertSupportResourceDto,
  ) {
    return { data: await this.places.createResource(actor, dto), message: 'Resource added' };
  }

  @Patch('support-resources/:id')
  @AdminPermissions('config:taxonomy')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @Idempotent()
  @ApiOperation({
    summary: 'Edit a line, or mark it checked',
    description:
      '`lastCheckedAt: "now"` stamps today as the date the list was verified. It moves **only** ' +
      'when sent: the app renders it as “last checked”, and that line is the only thing telling ' +
      'a member in crisis whether these numbers are current — so an edit that corrected the ' +
      'opening hours must not claim the number was re-verified.\n\n' +
      'An active line still needs a number or a link.',
  })
  async updateResource(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchSupportResourceDto,
  ) {
    return { data: await this.places.updateResource(actor, id, dto), message: 'Resource updated' };
  }

  @Delete('support-resources/:id')
  @AdminPermissions('config:taxonomy')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Take a line off the list',
    description:
      'Deactivates rather than deletes, like every other vocabulary here. The row stays so the ' +
      'audit trail still names what was removed, and `POST` with the same name brings it back.',
  })
  async deactivateResource(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      data: await this.places.deactivateResource(actor, id),
      message: 'Resource deactivated',
    };
  }
}
