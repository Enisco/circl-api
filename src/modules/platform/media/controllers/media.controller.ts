import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { CurrentUserId, JwtAuthGuard, Public } from '@/common';
import { PrismaService } from '@/infrastructure';
import { CreateUploadDto } from '../dtos/create-upload.dto';
import { MediaUploadService } from '../services/media-upload.service';
import { LocalStorage, StorageProvider } from '../storage';

@Controller('media')
@ApiTags('Media')
export class MediaController {
  constructor(
    private readonly uploads: MediaUploadService,
    private readonly storage: StorageProvider,
    private readonly database: PrismaService,
  ) {}

  /**
   * Step 1 of the two-step upload (spec 0.11), so a large upload never blocks the
   * composer and a failed post does not lose its photos.
   */
  @Post('uploads')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Reserve upload URLs',
    description:
      'Returns a presigned URL and a media id per file. PUT the bytes to the URL, then pass the ' +
      'media ids in the create payload of the post.',
  })
  async createUploads(@CurrentUserId() userId: string, @Body() dto: CreateUploadDto) {
    const data = await this.uploads.createUploads(userId, dto);

    return { data, message: 'Upload URLs created' };
  }

  /**
   * The direct-upload target for the local driver only. With S3 configured the
   * client PUTs to the bucket and never reaches this route.
   */
  @Put('content/:storageKey')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upload bytes (local storage driver only)' })
  async upload(@Param('storageKey') storageKey: string, @Req() request: Request) {
    if (!(this.storage instanceof LocalStorage)) {
      throw new NotFoundException('Direct upload is not available with this storage driver.');
    }

    const key = decodeURIComponent(storageKey);
    const media = await this.database.media.findUnique({ where: { storageKey: key } });

    if (!media) {
      throw new NotFoundException('No upload was reserved for this key.');
    }

    await this.storage.write(key, request);
    await this.uploads.markUploaded(key);

    return { data: { mediaId: media.id }, message: 'Upload complete' };
  }

  /** Serves bytes for the local driver. With S3 the CDN serves them. */
  @Get('content/:storageKey')
  @Public()
  async serve(@Param('storageKey') storageKey: string, @Res() response: Response) {
    if (!(this.storage instanceof LocalStorage)) {
      throw new NotFoundException();
    }

    const key = decodeURIComponent(storageKey);
    const media = await this.database.media.findUnique({ where: { storageKey: key } });

    if (!media) throw new NotFoundException();

    const bytes = await this.storage.read(key).catch(() => null);

    if (!bytes) throw new NotFoundException();

    response.setHeader('Content-Type', media.mimeType);
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.send(bytes);
  }
}
