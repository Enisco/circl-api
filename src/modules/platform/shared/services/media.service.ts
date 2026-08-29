import { Injectable } from '@nestjs/common';
import { Media, MediaScanStatus, MediaStatus, MediaType, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import { StorageProvider } from '../../media/storage/storage.interface';
import { UrlSigner } from '../serializers/media.serializer';

export interface MediaRules {
  maxImages: number;
  allowVideo: boolean;
  allowAudio: boolean;
}

/** The default post rules from 0.11: 5 images or 1 video, never both. */
export const POST_MEDIA_RULES: MediaRules = { maxImages: 5, allowVideo: true, allowAudio: false };

/** One still image. Avatars, store logos, group photos (0.16.2, 4.1.2, 1.7.3). */
export const SINGLE_IMAGE_RULES: MediaRules = {
  maxImages: 1,
  allowVideo: false,
  allowAudio: false,
};

/** `Media.ownerType` for an avatar, so replacing one releases the last. */
export const AVATAR_MEDIA_OWNER = 'USER_AVATAR';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
export const AUDIO_TYPES = ['audio/m4a', 'audio/mp4', 'audio/aac', 'audio/x-m4a'];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Claims uploaded media for a resource. */
@Injectable()
export class MediaService {
  /** Whether an attach waits for the S3 event handler to mark a key clean (0.11.4). */
  private readonly scanRequired: boolean;

  constructor(
    private readonly database: PrismaService,
    private readonly storage: StorageProvider,
    config: ConfigService,
  ) {
    this.scanRequired = config.get<string>('MEDIA_SCAN_REQUIRED') === 'true';
  }

  /** Signs a stored key into a URL for a response (0.11.3). */
  readonly sign: UrlSigner = (storageKey: string) => this.storage.readUrl(storageKey);

  static typeFor(mimeType: string): MediaType | null {
    if (IMAGE_TYPES.includes(mimeType)) return MediaType.IMAGE;
    if (VIDEO_TYPES.includes(mimeType)) return MediaType.VIDEO;
    if (AUDIO_TYPES.includes(mimeType)) return MediaType.AUDIO;

    return null;
  }

  static maxBytesFor(type: MediaType): number {
    switch (type) {
      case MediaType.VIDEO:
        return MAX_VIDEO_BYTES;
      case MediaType.AUDIO:
        return MAX_AUDIO_BYTES;
      default:
        return MAX_IMAGE_BYTES;
    }
  }

  /** Validates a set of media ids against the rules and returns them in the order the client sent, which is the order they render in. */
  async validate(
    mediaKeys: string[] | undefined,
    ownerId: string,
    rules: MediaRules = POST_MEDIA_RULES,
    field = 'mediaKeys',
  ): Promise<Media[]> {
    if (!mediaKeys?.length) return [];

    // Keyed by storageKey, because the client now sends keys rather than ids (0.11.2).
    const rows = await this.database.media.findMany({
      where: { storageKey: { in: mediaKeys }, uploadedById: ownerId },
    });

    if (rows.length !== mediaKeys.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_NOT_FOUND,
        'One or more of the attached files could not be found. Please re-upload them.',
        { details: [{ field, message: 'One or more attachments could not be found.' }] },
      );
    }

    const alreadyUsed = rows.find(row => row.ownerId !== null);

    if (alreadyUsed) {
      // Uploads start when a photo is picked rather than on submit, so a member can attach a key, abandon the composer, and reach the same key again later.
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_ALREADY_ATTACHED,
        'One of these files is already attached to another post.',
        { details: [{ field, message: 'This file is already attached to another post.' }] },
      );
    }

    // A key that has not finished scanning is not attachable (0.11.4).
    if (this.scanRequired) {
      const unscanned = rows.filter(row => row.scanStatus !== MediaScanStatus.CLEAN);

      if (unscanned.length) {
        const infected = unscanned.find(row => row.scanStatus === MediaScanStatus.INFECTED);

        if (infected) {
          throw ApiException.unprocessable(
            ApiErrorCode.MEDIA_TYPE_NOT_ALLOWED,
            'That file could not be accepted.',
            { details: [{ field, message: 'This file could not be accepted.' }] },
          );
        }

        throw ApiException.unprocessable(
          ApiErrorCode.MEDIA_NOT_READY,
          'Your upload is still being processed. Try again in a moment.',
          { details: [{ field, message: 'Still processing.' }] },
        );
      }
    }

    const images = rows.filter(row => row.type === MediaType.IMAGE);
    const videos = rows.filter(row => row.type === MediaType.VIDEO);
    const audio = rows.filter(row => row.type === MediaType.AUDIO);

    // Images and video together is not allowed. One or the other (0.11).
    if (images.length && videos.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_MIXED_TYPES,
        'Attach photos or a video, not both.',
        { details: [{ field, message: 'Attach photos or a video, not both.' }] },
      );
    }

    if (images.length > rules.maxImages) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_LIMIT_EXCEEDED,
        `You can attach up to ${rules.maxImages} photos.`,
        { details: [{ field, message: `You can attach up to ${rules.maxImages} photos.` }] },
      );
    }

    if (videos.length > (rules.allowVideo ? 1 : 0)) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_LIMIT_EXCEEDED,
        rules.allowVideo ? 'You can attach one video.' : 'Video is not supported here.',
        { details: [{ field, message: 'You can attach one video.' }] },
      );
    }

    if (audio.length > (rules.allowAudio ? 1 : 0)) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_LIMIT_EXCEEDED,
        rules.allowAudio ? 'You can attach one voice note.' : 'Audio is not supported here.',
        { details: [{ field, message: 'You can attach one voice note.' }] },
      );
    }

    const order = new Map(mediaKeys.map((key, index) => [key, index]));

    return rows.sort((a, b) => (order.get(a.storageKey) ?? 0) - (order.get(b.storageKey) ?? 0));
  }

  /** Stamps the owner so the orphan sweeper leaves these alone. */
  async attach(
    tx: Prisma.TransactionClient,
    media: Media[],
    ownerType: string,
    ownerId: string,
  ): Promise<void> {
    if (!media.length) return;

    await Promise.all(
      media.map((item, index) =>
        tx.media.update({
          where: { id: item.id },
          data: {
            ownerType,
            ownerId,
            position: index,
            status: MediaStatus.ATTACHED,
            attachedAt: new Date(),
            expiresAt: null,
          },
        }),
      ),
    );
  }

  /** Everything attached to one resource, in render order. */
  async forOwner(ownerType: string, ownerId: string): Promise<Media[]> {
    return this.database.media.findMany({
      where: { ownerType, ownerId },
      orderBy: { position: 'asc' },
    });
  }

  /** Media for a page of resources, grouped by owner id, in one query. */
  async forOwners(ownerType: string, ownerIds: string[]): Promise<Map<string, Media[]>> {
    const grouped = new Map<string, Media[]>();

    if (!ownerIds.length) return grouped;

    const rows = await this.database.media.findMany({
      where: { ownerType, ownerId: { in: ownerIds } },
      orderBy: { position: 'asc' },
    });

    for (const row of rows) {
      const key = row.ownerId!;

      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }

    return grouped;
  }

  /** Detaches and removes media when its owning resource is hard-deleted. */
  async releaseOwner(tx: Prisma.TransactionClient, ownerType: string, ownerId: string) {
    await tx.media.deleteMany({ where: { ownerType, ownerId } });
  }
}
