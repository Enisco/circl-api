import { Injectable } from '@nestjs/common';
import { MediaStatus, MediaType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, toJsonOrUndefined } from '@/common';
import { MediaService } from '../../shared';
import { StorageProvider } from '../storage';
import { CreateUploadDto, UploadFileDto } from '../dtos/create-upload.dto';

export interface UploadTicket {
  mediaId: string;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  expiresAt: string;
}

/** Orphan media is deleted after 24 hours if never attached to a post (0.11). */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class MediaUploadService {
  constructor(
    private readonly database: PrismaService,
    private readonly storage: StorageProvider,
  ) {}

  /**
   * Step 1 of 0.11: reserve a row and a presigned URL per file.
   *
   * Limits are enforced here, before a byte moves, so a member on a slow
   * connection is told their video is too long at the start rather than after
   * three minutes of upload.
   */
  async createUploads(userId: string, dto: CreateUploadDto): Promise<UploadTicket[]> {
    const tickets: UploadTicket[] = [];

    for (const [index, file] of dto.files.entries()) {
      const type = this.assertType(file, index);

      this.assertSize(file, type, index);

      const mediaId = randomUUID();
      const storageKey = `uploads/${userId}/${mediaId}${extensionFor(file.mimeType)}`;
      const presigned = await this.storage.presignUpload(storageKey, file.mimeType, file.byteSize);

      await this.database.media.create({
        data: {
          id: mediaId,
          uploadedById: userId,
          type,
          status: MediaStatus.PENDING,
          mimeType: file.mimeType,
          byteSize: file.byteSize,
          storageKey,
          url: this.storage.publicUrl(storageKey),
          durationMs: file.durationMs ?? null,
          waveform: toJsonOrUndefined(file.waveform),
          expiresAt: new Date(Date.now() + ORPHAN_TTL_MS),
        },
      });

      tickets.push({
        mediaId,
        uploadUrl: presigned.uploadUrl,
        uploadHeaders: presigned.uploadHeaders,
        expiresAt: presigned.expiresAt.toISOString(),
      });
    }

    return tickets;
  }

  private assertType(file: UploadFileDto, index: number): MediaType {
    const type = MediaService.typeFor(file.mimeType);

    if (!type) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        `${file.mimeType} files are not supported.`,
        {
          details: [
            { field: `files[${index}].mimeType`, message: `${file.mimeType} is not supported.` },
          ],
        },
      );
    }

    return type;
  }

  private assertSize(file: UploadFileDto, type: MediaType, index: number): void {
    const max = MediaService.maxBytesFor(type);

    if (file.byteSize > max) {
      const megabytes = Math.floor(max / (1024 * 1024));

      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_TOO_LARGE,
        `Files of this type must be under ${megabytes}MB.`,
        {
          details: [
            { field: `files[${index}].byteSize`, message: `Must be under ${megabytes}MB.` },
          ],
        },
      );
    }
  }

  /**
   * Marks a reservation as uploaded. Called by the local driver's direct-upload
   * route, and available for an S3 completion callback later.
   */
  async markUploaded(storageKey: string, byteSize?: number): Promise<void> {
    await this.database.media.updateMany({
      where: { storageKey },
      data: {
        status: MediaStatus.UPLOADED,
        ...(byteSize !== undefined ? { byteSize } : {}),
      },
    });
  }

  /**
   * Sweeps media that was reserved and never attached. Runs on a schedule; the
   * bytes go too, not just the row.
   */
  async sweepOrphans(): Promise<number> {
    const orphans = await this.database.media.findMany({
      where: { ownerId: null, expiresAt: { lt: new Date() } },
      select: { id: true, storageKey: true },
      take: 500,
    });

    if (!orphans.length) return 0;

    await Promise.all(orphans.map(media => this.storage.delete(media.storageKey)));
    await this.database.media.deleteMany({ where: { id: { in: orphans.map(m => m.id) } } });

    return orphans.length;
  }
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
};

const extensionFor = (mimeType: string): string => EXTENSIONS[mimeType] ?? '';
