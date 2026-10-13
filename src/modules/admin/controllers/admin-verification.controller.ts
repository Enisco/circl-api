import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Idempotent, SuccessMessage } from '@/common';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminPermissions, AdminPrincipal } from '../common/admin-principal';
import {
  DecideVerificationDto,
  ListVerificationsDto,
  RevokeVerificationDto,
  SetVerificationExpiryDto,
} from '../dtos/admin-verification.dto';
import { AdminVerificationService } from '../services/admin-verification.service';

/**
 * The review queue of Professionals v2 (§12).
 *
 * It is no longer "a listing awaiting approval" — it is a **`(professional, category)`
 * verification** awaiting a decision, with the documents attached and the subcategories it was
 * submitted under. One professional may have several, in different states, independently.
 *
 * `admin/professional-reviews` is kept beside this: it still answers a different question — has a
 * human looked at this profile at all — and it is no longer what gates selling.
 */
@ApiExcludeController()
@ApiTags('Admin · Category verifications')
@Controller('admin/verifications')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminVerificationController {
  constructor(private readonly verifications: AdminVerificationService) {}

  @Get()
  @AdminPermissions('content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The verification queue',
    description:
      'Oldest submission first, which is the order a queue is worked in. Filter by `status`, ' +
      '`categoryCode` or `memberId` — a professional may hold several records in different ' +
      'states, and they are independent of each other.\n\n' +
      '`servicesInCategory` is what a decision here would publish or take down. It is the number ' +
      'the screen should warn with **before** a revocation, because a reviewer should not learn ' +
      'the size of what they did from the support queue.',
  })
  async list(@Query() query: ListVerificationsDto) {
    const { data, meta } = await this.verifications.list(query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Verifications') };
  }

  @Get(':id')
  @AdminPermissions('content:read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One verification, with its documents listed',
    description:
      'The documents are **metadata only** — name, type, size, pages. The bytes come from the ' +
      'route below, through the staff guard stack; no URL for one is ever minted.\n\n' +
      '`submittedForSubcategories` is what the member said the documents were for. It does not ' +
      'scope the approval — approval is category-wide — but it is what a reviewer reads to know ' +
      'which licence they should be looking for.',
  })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.verifications.detail(id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Verification') };
  }

  @Get(':id/documents/:documentId')
  @AdminPermissions('content:moderate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One supporting document',
    description:
      'The file bytes. **No redirect and no presigned URL**: a presigned URL is a bearer token ' +
      'for somebody’s licence — it works for anybody holding it, outlives the session that minted ' +
      'it, and lands in browser history and any proxy on the way.\n\n' +
      '`Content-Disposition: attachment` with `nosniff` and `no-store`, so nothing a member ' +
      'uploads renders in the portal and no copy is left in a cache. PDF, PNG, JPEG or HEIC — ' +
      'HEIC is what an iPhone produces, and it is accepted now (v2 §2.4), so a viewer that cannot ' +
      'render it should offer the download rather than a broken frame.\n\n' +
      'Audited as `verification.document_viewed`, once per staff member per document per fifteen ' +
      'minutes: "who looked at my licence" is a question a member is entitled to an answer to.',
  })
  async document(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res() response: ExpressResponse,
  ) {
    const file = await this.verifications.document(actor, id, documentId);

    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', file.bytes.length);
    // The filename came off a member's device: quoted, and stripped of anything that could break
    // the header.
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName.replace(/[^\w.\- ]/g, '_')}"`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.send(file.bytes);
  }

  @Post(':id/decide')
  @AdminPermissions('content:moderate')
  @HttpCode(HttpStatus.OK)
  @Idempotent({ required: true })
  @ApiOperation({
    summary: 'Approve or decline',
    description:
      '**The note reaches the member verbatim**, so write it to them: it is the only thing that ' +
      'tells somebody what to fix, and it is required on a decline.\n\n' +
      '`licenceSeen` records which licence or registration was actually in front of the reviewer. ' +
      'That is the mitigation for category-wide approval (v2 §2.3): approving Immigration unlocks ' +
      '*Immigration solicitor* as well, and this is the field that would make narrowing it later a ' +
      'rule change rather than a data recovery.\n\n' +
      '**Approving publishes every waiting service in that category at once** — nothing walks ' +
      'them, because a service’s status is derived from this record. The response says how many ' +
      'were affected.',
  })
  async decide(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideVerificationDto,
  ) {
    const data = await this.verifications.decide(actor, id, dto);

    return {
      data,
      message: `Verification ${dto.decision === 'APPROVE' ? 'approved' : 'declined'}`,
    };
  }

  @Post(':id/revoke')
  @AdminPermissions('content:moderate')
  @HttpCode(HttpStatus.OK)
  @Idempotent({ required: true })
  @ApiOperation({
    summary: 'Withdraw an approval',
    description:
      '**Every live service in that category is suspended with it**, and the response says how ' +
      'many. Warn with `servicesInCategory` from the queue *before* calling this: a reviewer ' +
      'taking down eleven live services should know that while they can still change their mind.\n\n' +
      'The note reaches the member verbatim, and here it matters more than anywhere — their work ' +
      'has just come off the platform.',
  })
  async revoke(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeVerificationDto,
  ) {
    const data = await this.verifications.revoke(actor, id, dto);

    return { data, message: 'Verification revoked' };
  }

  @Patch(':id/expiry')
  @AdminPermissions('content:moderate')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOperation({
    summary: 'Set or clear when it lapses',
    description:
      'A licence with a renewal date is the normal case in regulated work. `null` clears it, ' +
      'which is a different answer from omitting the field.\n\n' +
      'An expiry in the past is refused: it would suspend their services the moment it was saved, ' +
      'and if that is what somebody means they should revoke it and say why.',
  })
  async setExpiry(
    @CurrentUser() actor: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetVerificationExpiryDto,
  ) {
    const data = await this.verifications.setExpiry(actor, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Verification') };
  }
}
