import { Injectable } from '@nestjs/common';
import { Media, MediaStatus, MediaType, Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';

export interface MediaRules {
  maxImages: number;
  allowVideo: boolean;
  allowAudio: boolean;
}

/** The default post rules from 0.11: 5 images or 1 video, never both. */
export const POST_MEDIA_RULES: MediaRules = { maxImages: 5, allowVideo: true, allowAudio: false };

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
export const AUDIO_TYPES = ['audio/m4a', 'audio/mp4', 'audio/aac', 'audio/x-m4a'];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Claims uploaded media for a resource.
 *
 * Media is reserved first and attached second (0.11), so a large upload never
 * blocks the composer and a failed post does not lose its photos. This service is
 * the second half: it verifies the caller owns the rows, enforces the per-post
 * rules, and stamps the polymorphic owner.
 */
@Injectable()
export class MediaService {
  constructor(private readonly database: PrismaService) {}

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

  /**
   * Validates a set of media ids against the rules and returns them in the order
   * the client sent, which is the order they render in.
   */
  async validate(
    mediaIds: string[] | undefined,
    ownerId: string,
    rules: MediaRules = POST_MEDIA_RULES,
    field = 'mediaIds',
  ): Promise<Media[]> {
    if (!mediaIds?.length) return [];

    const rows = await this.database.media.findMany({
      where: { id: { in: mediaIds }, uploadedById: ownerId },
    });

    if (rows.length !== mediaIds.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_NOT_FOUND,
        'One or more of the attached files could not be found. Please re-upload them.',
        { details: [{ field, message: 'One or more attachments could not be found.' }] },
      );
    }

    const alreadyUsed = rows.find(row => row.ownerId !== null);

    if (alreadyUsed) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_ALREADY_ATTACHED,
        'One of these files is already attached to another post.',
        { details: [{ field, message: 'This file is already attached to another post.' }] },
      );
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

    const order = new Map(mediaIds.map((id, index) => [id, index]));

    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
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
