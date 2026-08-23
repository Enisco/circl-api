import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RouterModule } from '@nestjs/core';
import { MediaController } from './controllers/media.controller';
import { MediaUploadService } from './services/media-upload.service';
import { LocalStorage, S3Storage, StorageProvider } from './storage';

/**
 * The driver is chosen from the environment at boot: S3 when MEDIA_BUCKET is set,
 * the local disk otherwise. Nothing downstream knows which one it got.
 */
@Module({
  imports: [
    RouterModule.register([{ path: 'api/v1', module: MediaModule, children: [MediaController] }]),
  ],
  controllers: [MediaController],
  providers: [
    MediaUploadService,
    LocalStorage,
    {
      provide: StorageProvider,
      inject: [ConfigService, LocalStorage],
      useFactory: (config: ConfigService, local: LocalStorage): StorageProvider =>
        config.get<string>('MEDIA_BUCKET') ? new S3Storage(config) : local,
    },
  ],
  exports: [MediaUploadService, StorageProvider],
})
export class MediaModule {}
