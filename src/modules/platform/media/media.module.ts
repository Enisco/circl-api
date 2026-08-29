import { Module } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { MediaController } from './controllers/media.controller';
import { MediaUploadService } from './services/media-upload.service';

/** The upload endpoints. */
@Module({
  imports: [
    RouterModule.register([{ path: 'api/v1', module: MediaModule, children: [MediaController] }]),
  ],
  controllers: [MediaController],
  providers: [MediaUploadService],
  exports: [MediaUploadService],
})
export class MediaModule {}
