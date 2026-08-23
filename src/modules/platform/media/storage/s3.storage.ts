import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PresignedUpload, StorageProvider } from './storage.interface';

const UPLOAD_TTL_SECONDS = 900;

/**
 * The production driver. Presigns a PUT so the bytes go straight from the device
 * to the bucket and never through this API — a 100MB video routed through a
 * Node process is a 100MB video occupying a Node process.
 */
@Injectable()
export class S3Storage extends StorageProvider {
  readonly name = 's3';

  private readonly logger = new Logger(S3Storage.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly cdnUrl: string | null;

  constructor(private readonly config: ConfigService) {
    super();

    this.bucket = config.getOrThrow<string>('MEDIA_BUCKET');
    this.cdnUrl = config.get<string>('MEDIA_CDN_URL')?.replace(/\/$/, '') ?? null;
    this.client = new S3Client({
      region: config.get<string>('AWS_REGION') ?? 'eu-west-2',
      credentials: config.get<string>('AWS_ACCESS_KEY_ID')
        ? {
            accessKeyId: config.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
            secretAccessKey: config.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
          }
        : undefined,
    });
  }

  async presignUpload(
    storageKey: string,
    mimeType: string,
    byteSize: number,
  ): Promise<PresignedUpload> {
    // The presigner is published as its own package and pins its own copy of the
    // AWS client types, so structurally identical S3Clients do not unify. The
    // cast is the documented workaround, not a papered-over bug.
    const uploadUrl = await getSignedUrl(
      this.client as unknown as Parameters<typeof getSignedUrl>[0],
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ContentType: mimeType,
        ContentLength: byteSize,
      }),
      { expiresIn: UPLOAD_TTL_SECONDS },
    );

    return {
      uploadUrl,
      uploadHeaders: { 'Content-Type': mimeType },
      expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000),
    };
  }

  publicUrl(storageKey: string): string {
    return this.cdnUrl
      ? `${this.cdnUrl}/${storageKey}`
      : `https://${this.bucket}.s3.${this.config.get('AWS_REGION') ?? 'eu-west-2'}.amazonaws.com/${storageKey}`;
  }

  async delete(storageKey: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }))
      .catch(error => this.logger.warn(`Failed to delete ${storageKey}: ${String(error)}`));
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }));

      return true;
    } catch {
      return false;
    }
  }
}
