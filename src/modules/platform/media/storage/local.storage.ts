import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createWriteStream, promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { PresignedUpload, StorageProvider } from './storage.interface';

const UPLOAD_TTL_SECONDS = 900;

/**
 * The no-bucket driver.
 *
 * It exists so every composer in the app can be built and tested end-to-end
 * before object storage is provisioned: the client's two-step flow is identical,
 * the "presigned URL" simply points back at this API instead of at S3.
 *
 * It is NOT a production driver. On a platform with an ephemeral filesystem —
 * Render included — anything written here is gone on the next deploy. Set
 * MEDIA_BUCKET and the S3 driver takes over with no client change.
 */
@Injectable()
export class LocalStorage extends StorageProvider {
  readonly name = 'local';

  private readonly logger = new Logger(LocalStorage.name);
  private readonly root: string;
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    super();

    this.root = resolve(config.get<string>('MEDIA_LOCAL_DIR') ?? './storage/media');
    this.baseUrl = (
      config.get<string>('PUBLIC_BASE_URL') ??
      `http://localhost:${config.get<number>('APP_PORT') ?? 4000}`
    ).replace(/\/$/, '');

    this.logger.warn(
      'Media is using the local disk driver. Uploads do not survive a redeploy — set MEDIA_BUCKET to use S3.',
    );
  }

  presignUpload(storageKey: string, mimeType: string): Promise<PresignedUpload> {
    return Promise.resolve({
      uploadUrl: `${this.baseUrl}/api/v1/media/content/${encodeURIComponent(storageKey)}`,
      uploadHeaders: { 'Content-Type': mimeType },
      expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000),
    });
  }

  publicUrl(storageKey: string): string {
    return `${this.baseUrl}/api/v1/media/content/${encodeURIComponent(storageKey)}`;
  }

  async delete(storageKey: string): Promise<void> {
    await fs.rm(this.pathFor(storageKey), { force: true }).catch(() => undefined);
  }

  async exists(storageKey: string): Promise<boolean> {
    return fs
      .stat(this.pathFor(storageKey))
      .then(() => true)
      .catch(() => false);
  }

  /** Used by the direct-upload controller this driver needs and S3 does not. */
  async write(storageKey: string, stream: Readable): Promise<void> {
    const path = this.pathFor(storageKey);

    await fs.mkdir(dirname(path), { recursive: true });
    await pipeline(stream, createWriteStream(path));
  }

  async read(storageKey: string): Promise<Buffer> {
    return fs.readFile(this.pathFor(storageKey));
  }

  /**
   * Storage keys are server-generated, but this is the one place a client-supplied
   * string reaches the filesystem, so it is checked rather than trusted.
   */
  pathFor(storageKey: string): string {
    const path = resolve(join(this.root, storageKey));

    if (!path.startsWith(this.root)) {
      throw new Error('Invalid storage key');
    }

    return path;
  }
}
