import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MediaPurpose } from '@prisma/client';
import { AdminJwtGuard } from '@/common/guards/admin-jwt.guard';
import { ApiErrorCode, ApiException, CurrentUser, RateLimit } from '@/common';
import { CreateUploadDto, MediaUploadService } from '@/modules/platform/media';
import { AdminBffGuard } from '../common/admin-bff.guard';
import { AdminPermissionGuard } from '../common/admin-permission.guard';
import { AdminAnyPermission, AdminPrincipal } from '../common/admin-principal';

/**
 * What staff are allowed to attach things to.
 *
 * `MESSAGE` is the one that matters: §5.15's reply takes `attachmentKeys`, and until this endpoint
 * existed there was no way for a staff member to obtain one. The member upload route is guarded by
 * the member JWT, and staff accounts are refused member authentication (B1) — so the field was
 * declared and unusable, and on an admin-only host the member route answered a 500 besides.
 *
 * `DISPUTE` comes with it, for the evidence staff add to a dispute on a member's behalf (§5.17).
 *
 * Everything else is left out deliberately. An avatar, a Connect post or a store photo is a
 * member's own content, and a staff account minting upload tickets for those is a staff account
 * writing into somebody's profile.
 */
const STAFF_PURPOSES: MediaPurpose[] = [MediaPurpose.MESSAGE, MediaPurpose.DISPUTE];

/**
 * The staff door onto the upload ticket service (§0.11).
 *
 * Same service, same key minting, same size and type rules as the member route — the only
 * differences are the guard stack and the narrower set of purposes. Bytes still never pass through
 * the API: this returns a presigned URL per file and the caller PUTs straight to the bucket.
 */
@ApiExcludeController()
@ApiTags('Admin · Media')
@Controller('admin/media')
@UseGuards(AdminBffGuard, AdminJwtGuard, AdminPermissionGuard)
export class AdminMediaController {
  constructor(private readonly uploads: MediaUploadService) {}

  @Post('uploads')
  // Whoever may answer a member may attach something to the answer. Opened on the manage
  // permissions rather than a new one of its own, because an upload ticket is not a capability in
  // its own right — it is the first half of sending a message or filing evidence.
  @AdminAnyPermission('support:manage', 'guard:manage', 'disputes:manage')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit('ADMIN_WRITE')
  @ApiOperation({
    summary: 'Reserve upload URLs for a staff attachment',
    description:
      'Returns a presigned S3 URL and an object key per file. PUT the bytes with exactly the two ' +
      'headers returned, then pass the keys as `attachmentKeys` on the reply. `purpose` must be ' +
      '`MESSAGE` or `DISPUTE`.',
  })
  async createUploads(@CurrentUser() actor: AdminPrincipal, @Body() dto: CreateUploadDto) {
    if (!STAFF_PURPOSES.includes(dto.purpose)) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Staff uploads are for a message attachment or dispute evidence.',
        {
          details: [{ field: 'purpose', message: `One of ${STAFF_PURPOSES.join(', ')}.` }],
          data: { allowed: STAFF_PURPOSES },
        },
      );
    }

    // Keyed to the staff member's own id, like every other upload. The key carries whoever
    // reserved it, so an attachment on a support reply traces to the person who sent it rather
    // than to the member whose thread it landed in.
    const data = await this.uploads.createUploads(actor.id, dto);

    return { data, message: 'Upload URLs created' };
  }
}
