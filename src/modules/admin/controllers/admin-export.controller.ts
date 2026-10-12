import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RateLimit, SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import { CreateExportDto, ListExportsDto } from '../dtos/admin-export.dto';
import { AdminExportService } from '../exports/admin-export.service';

/**
 * CSV exports (§5.26).
 *
 * Every route needs `exports:csv`, and that is only the first half: the kind's own list permission
 * is checked in the service, because "may export" and "may see members" are different grants and a
 * staff member who holds only the first should not be able to turn it into the second.
 */
@ApiExcludeController()
@ApiTags('Admin · Exports')
@Controller('admin/exports')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminExportController {
  constructor(private readonly exports: AdminExportService) {}

  @Post()
  @AdminPermissions('exports:csv')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Ask for a CSV',
    description:
      'Answers 202 with the export in `QUEUED`: the file is built by a worker, and poll ' +
      '`GET admin/exports/:id` or the list for `READY`. Twenty an hour per staff member, then ' +
      '429 `EXPORT_LIMIT`.\n\n' +
      '`filters` takes the list endpoint’s filter params and is validated by the list’s own ' +
      'DTO — a filter the list refuses is refused here rather than dropped, because a dropped ' +
      'filter widens an export instead of narrowing it. Paging params are refused by name for the ' +
      'same reason: an export covers every matching row.\n\n' +
      '`columns` comes from the kind’s allowlist (§13.18); `email` and `phone` additionally ' +
      'need `members:pii_reveal`, checked here and again at download.',
  })
  async request(@CurrentUser() actor: AdminPrincipal, @Body() body: CreateExportDto) {
    const data = await this.exports.request(actor, body);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Export') };
  }

  @Get()
  @AdminPermissions('exports:csv')
  @ApiOperation({
    summary: 'Your exports, newest first',
    description:
      '`all=true` returns everyone’s and needs `exports:read_all` (seeded to managers and super ' +
      'admins), which adds `requestedBy` to each row. Without that permission the flag is ' +
      'ignored rather than refused — the answer a staff member is entitled to is their own list, ' +
      'not an error. Seeing everybody’s exports is oversight; **downloading** one is still ' +
      'owner-only.',
  })
  async list(@CurrentUser() actor: AdminPrincipal, @Query() query: ListExportsDto) {
    const { data, meta } = await this.exports.list(actor, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Exports') };
  }

  @Get(':id')
  @AdminPermissions('exports:csv')
  @ApiOperation({
    summary: 'One export',
    description:
      'Somebody else’s export is a 404 rather than a 403 unless you hold `exports:read_all`: a ' +
      '403 would confirm that an id taken from a log is an export, and who is exporting what is ' +
      'itself worth not leaking.',
  })
  async get(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    const data = await this.exports.get(actor, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Export') };
  }

  @Post(':id/download')
  @AdminPermissions('exports:csv')
  @HttpCode(HttpStatus.OK)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'A five-minute link to the file',
    description:
      'A signed storage URL, valid five minutes, and never the storage key itself. **Owner ' +
      'only** — a manager with `exports:read_all` can see that an export happened but not ' +
      'download somebody else’s copy of it (403).\n\n' +
      'Permissions are re-checked at this point, not trusted from the request: losing ' +
      '`members:pii_reveal` loses access to exports of contact details made while you had it. ' +
      'Not ready, failed or past its seven days → 409 `NOT_READY`. Each download is audited.',
  })
  async download(@CurrentUser() actor: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    const { auditId, ...data } = await this.exports.download(actor, id);

    return {
      data,
      ...(auditId ? { meta: { auditId } } : {}),
      message: SuccessMessage.ACTION_SUCCESSFUL('Download link created'),
    };
  }
}
