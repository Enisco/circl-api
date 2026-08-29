import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId, JwtAuthGuard } from '@/common';
import { CreateUploadDto } from '../dtos/create-upload.dto';
import { MediaUploadService } from '../services/media-upload.service';

@Controller('media')
@ApiTags('Media')
export class MediaController {
  constructor(private readonly uploads: MediaUploadService) {}

  /** Step 1 of the two-step upload (spec 0.11), so a large upload never blocks the composer and a failed post does not lose its photos. */
  @Post('uploads')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Reserve upload URLs',
    description:
      'Returns a presigned S3 URL and an object key per file. PUT the bytes straight to the ' +
      'bucket with exactly the two headers returned, then pass the keys in the create payload ' +
      'of the post (0.11.5). The bytes never pass through this API.',
  })
  async createUploads(@CurrentUserId() userId: string, @Body() dto: CreateUploadDto) {
    const data = await this.uploads.createUploads(userId, dto);

    return { data, message: 'Upload URLs created' };
  }
}
