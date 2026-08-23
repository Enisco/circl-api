export interface PresignedUpload {
  /** Where the client PUTs the bytes (spec 0.11, step 2). */
  uploadUrl: string;
  /** Headers the client must send with that PUT, if the driver needs any. */
  uploadHeaders?: Record<string, string>;
  expiresAt: Date;
}

/**
 * Media storage, behind one interface so the driver is an environment decision.
 *
 * The spec's contract is two steps: reserve a URL, then PUT the bytes. Both
 * drivers satisfy it identically from the client's point of view, which is what
 * lets the app be built and tested before a bucket exists.
 */
export abstract class StorageProvider {
  abstract readonly name: string;

  abstract presignUpload(
    storageKey: string,
    mimeType: string,
    byteSize: number,
  ): Promise<PresignedUpload>;

  /** The URL the media is served from once uploaded. */
  abstract publicUrl(storageKey: string): string;

  abstract delete(storageKey: string): Promise<void>;

  /** Whether the bytes have actually landed, checked before a resource claims them. */
  abstract exists(storageKey: string): Promise<boolean>;
}
