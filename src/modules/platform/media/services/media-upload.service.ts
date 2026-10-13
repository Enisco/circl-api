import { Injectable } from '@nestjs/common';
import { MediaPurpose, MediaScanStatus, MediaStatus, MediaType } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, toJsonOrUndefined } from '@/common';
import { MediaService, StorageProvider } from '../../shared';
import { CreateUploadDto, UploadFileDto } from '../dtos/create-upload.dto';

export interface UploadTicket {
  /**
   * The media row's id.
   *
   * Everything that attaches a *photo* works in keys (0.11.2), and that stays. Supporting
   * documents are referenced by id instead — `documentIds` on a listing,
   * `documents/:documentId` for a reviewer — because a document is a record with a decision
   * attached to it rather than a frame in a gallery. Without this on the ticket there was no way
   * for a client to learn the id it is required to send: a declared input nothing could populate.
   */
  id: string;
  /** The object key. */
  key: string;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  expiresAt: string;
}

/**
 * PDFs, for supporting documents and nothing else (§2.9).
 *
 * Scoped to `VERIFICATION` on purpose. A PDF is a program as much as a document — it can carry
 * JavaScript, embedded files and remote references — so the only place one is accepted is the one
 * place a human opens it deliberately, behind staff authentication, from a private prefix, with
 * `Content-Disposition: attachment`. Letting one into `COMMUNITY` would put it in a feed.
 */
const DOCUMENT_PURPOSES: MediaPurpose[] = [MediaPurpose.VERIFICATION];
const DOCUMENT_TYPES = ['application/pdf'];

/**
 * Everything a supporting document may be. Still narrower than the general image list — WebP is
 * fine for an avatar and is not what a reviewer should be handed.
 *
 * **HEIC and HEIF are accepted here now** (v2 §2.4). They were refused, and HEIC is what an iPhone
 * produces by default — so a member photographing their certificate was turned away for using
 * their phone's own camera, with nothing they could do about it. The reviewer's viewer renders it,
 * the dimension reader already knew the container, and the signature check knows it too.
 */
const VERIFICATION_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/heic',
  'image/heif',
];

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
  CONNECT: 'circl/connect',
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
      const type = this.assertType(file, dto.purpose, index);

      this.assertSize(file, type, index);
      this.assertAudioFields(file, type, index);

      // The server mints the key, so the client never invents one.
      const storageKey = this.mintKey(dto.purpose, userId, file.mimeType);
      const presigned = await this.storage.presignUpload(storageKey, file.mimeType, file.byteSize);

      const row = await this.database.media.create({
        select: { id: true },
        data: {
          uploadedById: userId,
          type,
          purpose: dto.purpose,
          status: MediaStatus.PENDING,
          mimeType: file.mimeType,
          fileName: file.fileName?.trim() || null,
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
        id: row.id,
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

  private assertType(file: UploadFileDto, purpose: MediaPurpose, index: number): MediaType {
    if (DOCUMENT_TYPES.includes(file.mimeType)) {
      if (!DOCUMENT_PURPOSES.includes(purpose)) {
        throw ApiException.unprocessable(
          ApiErrorCode.MEDIA_TYPE_NOT_ALLOWED,
          'PDFs can only be uploaded as supporting documents.',
          {
            details: [
              {
                field: `files[${index}].mimeType`,
                message: 'PDFs are accepted for VERIFICATION only.',
              },
            ],
          },
        );
      }

      return MediaType.DOCUMENT;
    }

    // A supporting document is a PDF or a photograph and nothing else (§2.9, v2 §2.4) — so the
    // refusal happens **here**, when the file is picked, rather than at submit: a member who has
    // filled in the whole form and watched four files upload should not be told at the last step
    // that one of them was never going to work.
    if (DOCUMENT_PURPOSES.includes(purpose) && !VERIFICATION_TYPES.includes(file.mimeType)) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        'Supporting documents must be a PDF, or a photograph: PNG, JPEG or HEIC.',
        {
          details: [
            {
              field: `files[${index}].mimeType`,
              message: `${file.mimeType} is not accepted here. Use a PDF, a PNG, a JPEG or a HEIC.`,
            },
          ],
        },
      );
    }

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
  'image/heif': '.heic',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'application/pdf': '.pdf',
};

const extensionFor = (mimeType: string): string => EXTENSIONS[mimeType] ?? '';
