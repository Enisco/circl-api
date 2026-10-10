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
import { CurrentUser, RateLimit, SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAuthenticated, AdminPrincipal } from '../common/admin-principal';
import { CreateNoteDto, ListNotesDto, PatchNoteDto } from '../dtos/admin-note.dto';
import { AdminNoteService } from '../services/admin-note.service';

/**
 * Notes, for every kind of subject (§4.7).
 *
 * Declared `AdminAuthenticated` rather than with a permission, because the permission these need
 * is a property of the **subject**: a note about a Guard case needs `guard:read`, one about a
 * support thread needs `support:read`. The service holds that map and refuses accordingly, which is
 * the one case where a route cannot name its permission up front — and it is declared out loud
 * because the guard denies anything that says nothing.
 */
@ApiExcludeController()
@ApiTags('Admin · Notes')
@Controller('admin/notes')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminNoteController {
  constructor(private readonly notes: AdminNoteService) {}

  @Get()
  @AdminAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The notes about one subject',
    description:
      'Pinned first, then newest. Requires the read permission of the subject — `members:read` ' +
      'for a member, `guard:read` for a Guard case, and so on.',
  })
  async list(@CurrentUser() actor: AdminPrincipal, @Query() query: ListNotesDto) {
    const data = await this.notes.list(actor, query.subjectType, query.subjectId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Notes') };
  }

  @Post()
  @AdminAuthenticated()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Leave a note',
    description:
      'The subject must exist. Notes carry no foreign key — so that one survives its subject being ' +
      'closed or anonymised — which means nothing but this check stops a typo creating a note ' +
      'about nothing on a page nobody will open.',
  })
  async create(@CurrentUser() actor: AdminPrincipal, @Body() dto: CreateNoteDto) {
    const data = await this.notes.create(actor, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Note') };
  }

  @Patch(':noteId')
  @AdminAuthenticated()
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Edit a note',
    description:
      "The author, or somebody holding `team:manage`. A note is a person's own account of what " +
      'they saw; a colleague rewriting it would leave an entry attributed to them that they never ' +
      'wrote. Both versions go into the audit entry.',
  })
  async patch(
    @CurrentUser() actor: AdminPrincipal,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() dto: PatchNoteDto,
  ) {
    const data = await this.notes.patch(actor, noteId, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Note') };
  }

  @Delete(':noteId')
  @AdminAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw a note',
    description:
      'Soft-deleted. The fact that a judgement was recorded and then withdrawn is part of the ' +
      'record, and a hard delete would leave the audit entry pointing at nothing.',
  })
  async remove(
    @CurrentUser() actor: AdminPrincipal,
    @Param('noteId', ParseUUIDPipe) noteId: string,
  ) {
    const data = await this.notes.remove(actor, noteId);

    return { data, message: 'Note withdrawn' };
  }
}
