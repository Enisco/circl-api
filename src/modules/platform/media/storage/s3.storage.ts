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

const DEFAULT_UPLOAD_TTL_SECONDS = 900;

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
  private readonly region: string;
  private readonly cdnUrl: string | null;
  private readonly uploadTtlSeconds: number;

  constructor(config: ConfigService) {
    super();

    this.bucket = config.getOrThrow<string>('MEDIA_BUCKET');
    // Media can sit in a different region from SES, so it has its own setting
    // and falls back rather than assuming they are the same.
    this.region = config.get<string>('MEDIA_REGION') || config.get<string>('AWS_REGION') || 'eu-west-2';
    this.cdnUrl = config.get<string>('MEDIA_CDN_URL')?.replace(/\/$/, '') ?? null;
    this.uploadTtlSeconds =
      Number(config.get<string>('MEDIA_UPLOAD_URL_TTL_SECONDS')) || DEFAULT_UPLOAD_TTL_SECONDS;

    // Media-specific credentials when given, otherwise the shared AWS pair. A
    // separate IAM user is worth having: this one needs four actions on one
    // bucket and nothing else.
    const accessKeyId =
      config.get<string>('MEDIA_ACCESS_KEY_ID') || config.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey =
      config.get<string>('MEDIA_SECRET_ACCESS_KEY') || config.get<string>('AWS_SECRET_ACCESS_KEY');

    this.client = new S3Client({
      region: this.region,
      // Left undefined on purpose when no keys are set, so the SDK falls back to
      // the instance role. That is how this should run on real infrastructure.
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
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
      { expiresIn: this.uploadTtlSeconds },
    );

    return {
      uploadUrl,
      uploadHeaders: { 'Content-Type': mimeType },
      expiresAt: new Date(Date.now() + this.uploadTtlSeconds * 1000),
    };
  }

  publicUrl(storageKey: string): string {
    return this.cdnUrl
      ? `${this.cdnUrl}/${storageKey}`
      : `https://${this.bucket}.s3.${this.region}.amazonaws.com/${storageKey}`;
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
