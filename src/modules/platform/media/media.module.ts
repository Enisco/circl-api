import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { MediaController } from './controllers/media.controller';
import { MediaUploadService } from './services/media-upload.service';

/**
 * The upload ticket service, without the member route in front of it.
 *
 * Staff need the service — a support reply carries attachments (§5.15) — and must not be served
 * the member route, which is guarded by the member JWT and therefore answered `500` on the admin
 * surface. `POST admin/media/uploads` is the staff door onto the same service.
 */
@Module({
  providers: [MediaUploadService],
  exports: [MediaUploadService],
})
export class MediaCoreModule {}

/** The member upload endpoint. */
@Module({
  imports: [
    MediaCoreModule,
    RouterModule.register([{ path: 'api/v1', module: MediaModule, children: [MediaController] }]),
  ],
  controllers: [MediaController],
  exports: [MediaCoreModule],
})
export class MediaModule {}
