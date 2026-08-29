import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  PresignedUpload,
  READ_URL_TTL_SECONDS,
  StorageProvider,
  signingAnchor,
} from './storage.interface';
import { presignGetV4 } from './sigv4';

const DEFAULT_UPLOAD_TTL_SECONDS = 900;

/** The production driver. */
@Injectable()
export class S3Storage extends StorageProvider {
  readonly name = 's3';

  private readonly logger = new Logger(S3Storage.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly region: string;
  private readonly uploadTtlSeconds: number;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;

  /** Read URLs for the current day. */
  private urlCache = new Map<string, string>();
  private urlCacheAnchor = 0;

  constructor(config: ConfigService) {
    super();

    // One set of AWS credentials.
    this.bucket = config.getOrThrow<string>('MEDIA_BUCKET');
    this.region = config.getOrThrow<string>('AWS_REGION');
    this.accessKeyId = config.getOrThrow<string>('AWS_ACCESS_KEY_ID');
    this.secretAccessKey = config.getOrThrow<string>('AWS_SECRET_ACCESS_KEY');
    this.uploadTtlSeconds =
      Number(config.get<string>('MEDIA_UPLOAD_URL_TTL_SECONDS')) || DEFAULT_UPLOAD_TTL_SECONDS;

    this.client = new S3Client({
      region: this.region,
      credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey },
    });
  }

  /** A presigned PUT with the content type and length signed into it (0.11.1). */
  async presignUpload(
    storageKey: string,
    mimeType: string,
    byteSize: number,
  ): Promise<PresignedUpload> {
    const uploadUrl = await getSignedUrl(
      // The presigner ships its own copy of the client types, so structurally identical S3Clients do not unify.
      this.client as unknown as Parameters<typeof getSignedUrl>[0],
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ContentType: mimeType,
        ContentLength: byteSize,
      }),
      {
        expiresIn: this.uploadTtlSeconds,
        // Without this the presigner signs `host` only, so the two headers would be
        // returned to the client and enforced by nobody.
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );

    return {
      uploadUrl,
      // Exactly two headers, both signed.
      uploadHeaders: { 'Content-Type': mimeType, 'Content-Length': String(byteSize) },
      expiresAt: new Date(Date.now() + this.uploadTtlSeconds * 1000),
    };
  }

  /** A presigned GET anchored to UTC midnight (0.11.3). */
  readUrl(storageKey: string): string {
    const anchor = signingAnchor();

    if (this.urlCacheAnchor !== anchor.getTime()) {
      this.urlCache.clear();
      this.urlCacheAnchor = anchor.getTime();
    }

    const cached = this.urlCache.get(storageKey);

    if (cached) return cached;

    const url = presignGetV4({
      bucket: this.bucket,
      region: this.region,
      key: storageKey,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      expiresIn: READ_URL_TTL_SECONDS,
      signingDate: anchor,
    });

    this.urlCache.set(storageKey, url);

    return url;
  }

  async put(storageKey: string, body: Buffer, mimeType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: body,
        ContentType: mimeType,
      }),
    );
  }

  async delete(storageKey: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }))
      .catch(error => this.logger.warn(`Failed to delete ${storageKey}: ${String(error)}`));
  }

  async exists(storageKey: string): Promise<boolean> {
    return (await this.head(storageKey)) !== null;
  }

  async head(storageKey: string): Promise<{ byteSize: number; mimeType: string } | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );

      return {
        byteSize: result.ContentLength ?? 0,
        mimeType: result.ContentType ?? 'application/octet-stream',
      };
    } catch {
      return null;
    }
  }
}
