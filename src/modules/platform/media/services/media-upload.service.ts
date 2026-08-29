import { Injectable } from '@nestjs/common';
import { MediaPurpose, MediaScanStatus, MediaStatus, MediaType } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, toJsonOrUndefined } from '@/common';
import { MediaService, StorageProvider } from '../../shared';
import { CreateUploadDto, UploadFileDto } from '../dtos/create-upload.dto';

export interface UploadTicket {
  /** The object key. */
  key: string;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  expiresAt: string;
}

/** Orphan media is deleted after 24 hours if never attached (0.11.1). */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

/** One prefix per purpose (0.11.1), so a key is attributable without a database lookup and a prefix can be lifecycled on its own. */
const PREFIXES: Record<MediaPurpose, string> = {
  AVATAR: 'circl/avatars',
  COMMUNITY: 'circl/community',
  PROFESSIONAL: 'circl/professionals',
  COMMERCE: 'circl/commerce',
  MESSAGE: 'circl/messages',
  VERIFICATION: 'circl/verification',
  DISPUTE: 'circl/disputes',
};

@Injectable()
export class MediaUploadService {
  constructor(
    private readonly database: PrismaService,
    private readonly storage: StorageProvider,
  ) {}

  /** Step 1 of 0.11.1: mint a key and a presigned PUT per file. */
  async createUploads(userId: string, dto: CreateUploadDto): Promise<UploadTicket[]> {
    const tickets: UploadTicket[] = [];

    for (const [index, file] of dto.files.entries()) {
      const type = this.assertType(file, index);

      this.assertSize(file, type, index);
      this.assertAudioFields(file, type, index);

      // The server mints the key, so the client never invents one.
      const storageKey = this.mintKey(dto.purpose, userId, file.mimeType);
      const presigned = await this.storage.presignUpload(storageKey, file.mimeType, file.byteSize);

      await this.database.media.create({
        data: {
          uploadedById: userId,
          type,
          purpose: dto.purpose,
          status: MediaStatus.PENDING,
          mimeType: file.mimeType,
          byteSize: file.byteSize,
          storageKey,
          // Marked clean up front when no scanner is deployed, so the attach gate in MediaService is a no-op until MEDIA_SCAN_REQUIRED is on.
          scanStatus: MediaScanStatus.PENDING,
          durationMs: file.durationMs ?? null,
          waveform: toJsonOrUndefined(file.waveform),
          expiresAt: new Date(Date.now() + ORPHAN_TTL_MS),
        },
      });

      tickets.push({
        key: storageKey,
        uploadUrl: presigned.uploadUrl,
        uploadHeaders: presigned.uploadHeaders,
        expiresAt: presigned.expiresAt.toISOString(),
      });
    }

    return tickets;
  }

  /** `circl/{purpose}/{userId}/{filename}` (0.11.1). */
  private mintKey(purpose: MediaPurpose, userId: string, mimeType: string): string {
    // A timestamp reads well in a bucket listing; the suffix removes any chance of two files picked in the same millisecond colliding.
    const filename = `${Date.now()}-${randomBytes(4).toString('hex')}${extensionFor(mimeType)}`;

    return `${PREFIXES[purpose]}/${userId}/${filename}`;
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
          details: [{ field: `files[${index}].byteSize`, message: `Must be under ${megabytes}MB.` }],
        },
      );
    }
  }

  /** Duration and waveform belong to audio and nowhere else. */
  private assertAudioFields(file: UploadFileDto, type: MediaType, index: number): void {
    if (type === MediaType.AUDIO) return;

    if (file.durationMs !== undefined || file.waveform !== undefined) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Duration and waveform apply to voice notes only.',
        { details: [{ field: `files[${index}].durationMs`, message: 'Voice notes only.' }] },
      );
    }
  }

  /** Marks a key as uploaded. */
  async markUploaded(storageKey: string, byteSize?: number): Promise<void> {
    await this.database.media.updateMany({
      where: { storageKey },
      data: {
        status: MediaStatus.UPLOADED,
        ...(byteSize !== undefined ? { byteSize } : {}),
      },
    });
  }

  /** Sweeps media reserved and never attached. */
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
