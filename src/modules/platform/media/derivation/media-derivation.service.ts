import { Injectable, Logger } from '@nestjs/common';
import { MediaType } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { StorageProvider } from '../storage';
import { imageDimensions } from './image-dimensions';
import { videoMetadata, videoMetadataFromTail } from './video-metadata';

/**
 * How much of an object to fetch to read its header. Generous for an image because a JPEG's SOF
 * can sit behind a large EXIF block, and because this is a ranged GET: the cost is the bytes moved,
 * not the size of the file.
 */
const IMAGE_HEAD_BYTES = 256 * 1024;
const VIDEO_HEAD_BYTES = 512 * 1024;

/** An MP4 written by a phone puts its header last, so this is the second place to look. */
const VIDEO_TAIL_BYTES = 2 * 1024 * 1024;

/** Long enough for the attaching transaction to commit and release its row locks. */
const SETTLE_MS = 1500;

/**
 * The producer for the derived fields the spec has always promised (0.11.4) and nothing ever
 * wrote: `width`, `height` and a video's duration were null on everything a member uploaded, and
 * populated only on seeded rows, which is the worst possible arrangement — it looks built.
 *
 * The bytes never pass through the API, so the only way to learn anything about them is to read
 * them back out of storage. This reads the **header** rather than the file: a ranged GET of the
 * first few hundred kilobytes is enough for every format the API accepts, so deriving a 90MB
 * video's dimensions costs half a megabyte of transfer.
 *
 * It runs after the bytes are known to exist rather than at mint time, when the object does not
 * exist yet: on attach, and again from an hourly sweep for anything missed or uploaded and never
 * attached.
 */
@Injectable()
export class MediaDerivationService {
  private readonly logger = new Logger(MediaDerivationService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly storage: StorageProvider,
  ) {}

  /**
   * Fire-and-forget, like a notification: a member sending a photo must not wait on, or fail
   * because of, a metadata read. The sweep catches whatever this misses.
   */
  schedule(mediaIds: string[]): void {
    if (!mediaIds.length) return;

    // Deferred, because `attach` runs inside the caller's transaction and these rows are locked
    // until it commits. Writing to them from another connection before then would wait on that
    // lock while holding one of its own, which is a deadlock waiting for a busy pool.
    setTimeout(() => {
      void this.deriveMany(mediaIds).catch(error =>
        this.logger.warn(`Media derivation failed: ${(error as Error).message}`),
      );
    }, SETTLE_MS).unref();
  }

  async deriveMany(mediaIds: string[]): Promise<number> {
    const rows = await this.database.media.findMany({
      where: { id: { in: mediaIds }, derivedAt: null },
      select: { id: true, type: true, mimeType: true, storageKey: true },
    });

    let derived = 0;

    for (const row of rows) {
      if (await this.derive(row)) derived += 1;
    }

    return derived;
  }

  /** Returns true when something was learned. The visit is recorded either way. */
  async derive(row: {
    id: string;
    type: MediaType;
    mimeType: string;
    storageKey: string;
  }): Promise<boolean> {
    const now = new Date();

    try {
      if (row.type === MediaType.IMAGE) {
        const head = await this.storage.read(row.storageKey, { start: 0, end: IMAGE_HEAD_BYTES - 1 });
        const size = head ? imageDimensions(row.mimeType, head) : null;

        await this.database.media.update({
          where: { id: row.id },
          data: { derivedAt: now, ...(size ? { width: size.width, height: size.height } : {}) },
        });

        return size !== null;
      }

      if (row.type === MediaType.VIDEO) {
        const head = await this.storage.read(row.storageKey, { start: 0, end: VIDEO_HEAD_BYTES - 1 });

        if (!head) {
          await this.database.media.update({ where: { id: row.id }, data: { derivedAt: now } });

          return false;
        }

        const parsed = videoMetadata(head);
        let metadata = parsed.metadata;

        if (parsed.needsTail) {
          const object = await this.storage.head(row.storageKey);
          const size = object?.byteSize ?? 0;
          const tail = size
            ? await this.storage.read(row.storageKey, {
                start: Math.max(0, size - VIDEO_TAIL_BYTES),
                end: size - 1,
              })
            : null;

          if (tail) metadata = videoMetadataFromTail(tail);
        }

        await this.database.media.update({
          where: { id: row.id },
          data: {
            derivedAt: now,
            ...(metadata.width && metadata.height
              ? { width: metadata.width, height: metadata.height }
              : {}),
            // Only when the file did not already carry one from the recorder.
            ...(metadata.durationMs ? { durationMs: metadata.durationMs } : {}),
          },
        });

        return Boolean(metadata.width || metadata.durationMs);
      }

      // Audio: the recording device is the only thing that knows the duration and waveform, and it
      // already sent them (5.5). There is nothing in the header worth a round trip.
      await this.database.media.update({ where: { id: row.id }, data: { derivedAt: now } });

      return false;
    } catch (error) {
      this.logger.warn(`Could not derive ${row.storageKey}: ${(error as Error).message}`);

      // Still stamped, so one unreadable object is not re-fetched every hour for the rest of time.
      await this.database.media
        .update({ where: { id: row.id }, data: { derivedAt: now } })
        .catch(() => undefined);

      return false;
    }
  }

  /**
   * The catch-all. Anything attached but never visited, plus anything uploaded and left
   * unattached, which still gets dimensions in case it is attached later.
   */
  async sweep(limit = 200): Promise<number> {
    const rows = await this.database.media.findMany({
      where: { derivedAt: null },
      select: { id: true, type: true, mimeType: true, storageKey: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    let derived = 0;

    for (const row of rows) {
      if (await this.derive(row)) derived += 1;
    }

    if (rows.length) {
      this.logger.log(`media.derive: read ${derived} of ${rows.length} object header(s)`);
    }

    return derived;
  }
}
