export interface PresignedUpload {
  /** Where the client PUTs the bytes (spec 0.11.1, step 2). */
  uploadUrl: string;
  /** Headers the client must send with that PUT, if the driver needs any. */
  uploadHeaders?: Record<string, string>;
  expiresAt: Date;
}

/** Media storage, behind one interface so the driver is an environment decision. */
export abstract class StorageProvider {
  abstract readonly name: string;

  abstract presignUpload(
    storageKey: string,
    mimeType: string,
    byteSize: number,
  ): Promise<PresignedUpload>;

  /** A ready-to-use https URL for reading one object (0.11.3). */
  abstract readUrl(storageKey: string): string;

  /** Writes an object directly, bypassing the presigned flow. */
  abstract put(storageKey: string, body: Buffer, mimeType: string): Promise<void>;

  abstract delete(storageKey: string): Promise<void>;

  /** Whether the bytes have actually landed, checked before a resource claims them. */
  abstract exists(storageKey: string): Promise<boolean>;

  /** Object size and content type, read after upload by the derived-field job. */
  abstract head(storageKey: string): Promise<{ byteSize: number; mimeType: string } | null>;
}

/** The window a read URL is valid for (0.11.3). */
export const READ_URL_TTL_SECONDS = 48 * 60 * 60;

/** UTC midnight, so a read URL is stable all day and the client's cache key holds. */
export const signingAnchor = (at: Date = new Date()): Date => {
  const anchored = new Date(at);

  anchored.setUTCHours(0, 0, 0, 0);

  return anchored;
};
