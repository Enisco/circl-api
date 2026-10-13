import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Media,
  MediaPurpose,
  MediaScanStatus,
  MediaStatus,
  MediaType,
  Prisma,
} from '@prisma/client';
import { ApiErrorCode, ApiException } from '@/common';
import { PrismaService } from '@/infrastructure';
import {
  DOCUMENT_MIME_TYPES,
  DocumentMimeType,
  SNIFF_BYTES,
  matchesDeclaredType,
  pdfPageCount,
  stripImageMetadata,
} from '../../media/derivation/document-bytes';
import { StorageProvider } from '../../media/storage';

type Tx = Prisma.TransactionClient;

/**
 * The supporting documents a gated profession has to show (§2.9).
 *
 * A member who wants to offer immigration advice, or mind children, or do somebody's tax, uploads
 * one to five documents showing they are qualified, and a reviewer reads them. That replaced the
 * earlier idea of checking regulators' registers by hand: the documents are the evidence.
 *
 * These are the most sensitive files on the platform — qualification certificates, registration
 * letters, insurance schedules, often with a home address on them — so the handling is deliberately
 * stricter than for a photo in a feed:
 *
 * - **The bytes decide the type**, not the upload's declared MIME. A PDF renamed `.png` would
 *   otherwise be served back to a reviewer as an image.
 * - **Image metadata is stripped** before the file is stored for good. A phone writes GPS
 *   coordinates into a photo's EXIF, and for a photo of a certificate those coordinates are
 *   usually somebody's home.
 * - **Attached to exactly one listing, by the member who uploaded it.** Nothing else can claim one.
 * - **Superseded rather than deleted** on resubmission, so an appeal can be about the evidence that
 *   was actually looked at, and purged ninety days after the decision it informed.
 */

/** The owner key these hang off, so `releaseOwner` can take them all down together. */
export const LISTING_DOCUMENT_OWNER = 'LISTING_DOCUMENT';

/** §2.9: one is not evidence of much, and six is somebody uploading their whole filing cabinet. */
export const MIN_DOCUMENTS = 1;
export const MAX_DOCUMENTS = 5;

/** How long a superseded document is kept after the decision it was submitted for. */
export const DOCUMENT_RETENTION_DAYS = 90;

export interface ListingDocumentView {
  id: string;
  fileName: string;
  mimeType: DocumentMimeType;
  sizeBytes: number;
  pageCount: number | null;
  uploadedAt: string;
}

@Injectable()
export class ListingDocumentService {
  private readonly logger = new Logger(ListingDocumentService.name);

  /** Whether a scanner is deployed and its verdict enforced. See `scanPending`. */
  private readonly scanRequired: boolean;

  constructor(
    private readonly database: PrismaService,
    private readonly storage: StorageProvider,
    config: ConfigService,
  ) {
    this.scanRequired = config.get<string>('MEDIA_SCAN_REQUIRED') === 'true';
  }

  // ─── Validation, before anything is written ────────────────────────────────

  /**
   * Checks the count against what the profession needs, before any file is touched.
   *
   * Separate from `claim` and run first, because §5.9's rule applies here too: a submission
   * refused half way through would leave some documents attached to a listing that was never
   * created. `documentIds` is `undefined` when the client sent nothing and `[]` when it sent an
   * empty list, and the two mean the same thing here — neither is one to five.
   */
  assertCount(options: {
    documentIds: string[] | undefined;
    needsApproval: boolean;
    field?: string;
  }): string[] {
    const field = options.field ?? 'documentIds';
    const ids = [...new Set(options.documentIds ?? [])];

    if (!options.needsApproval) {
      /**
       * Not attached, and **no longer refused** (v2 §7).
       *
       * It used to be a 400: accepting files the platform has no reason to hold, and then holding
       * them, is how a data-minimisation promise quietly stops being true — and that reasoning
       * still stands, which is why nothing here attaches them. What changed is who the refusal
       * hit. A listing is no longer gated by anything (the gate moved to the service, against a
       * category verification), so *every* build that collects a certificate at registration —
       * which is every build shipped before v2 — would have had its registration refused outright.
       *
       * So the files are left where they are: unattached, and swept as orphans within the day.
       * The member's listing is created, and the documents they meant to send go to
       * `POST professionals/me/verifications`, which is where a licence belongs now.
       */
      if (ids.length) {
        this.logger.log(
          `Ignoring ${ids.length} document(s) on an ungated listing write: the gate is the category verification now.`,
        );
      }

      return [];
    }

    if (ids.length < MIN_DOCUMENTS) {
      throw ApiException.badRequest(
        ApiErrorCode.DOCUMENTS_REQUIRED,
        'This profession needs approval, so it needs documents showing you are qualified.',
        {
          details: [
            { field, message: `Attach between ${MIN_DOCUMENTS} and ${MAX_DOCUMENTS} documents.` },
          ],
        },
      );
    }

    if (ids.length > MAX_DOCUMENTS) {
      throw ApiException.badRequest(
        ApiErrorCode.TOO_MANY_DOCUMENTS,
        `Attach up to ${MAX_DOCUMENTS} documents.`,
        { details: [{ field, message: `At most ${MAX_DOCUMENTS}.` }] },
      );
    }

    return ids;
  }

  /**
   * Loads the rows, checks each one is usable, and sanitises the bytes.
   *
   * Everything that can refuse happens here, before the caller's transaction opens. The byte work
   * — a ranged read to check the type, then a rewrite to strip metadata — is network I/O against
   * storage, and holding a database transaction open across it would mean a listing write waiting
   * on S3.
   *
   * Returns the rows in the order the member sent them, which is the order a reviewer sees.
   */
  async prepare(options: {
    documentIds: string[];
    uploaderId: string;
    /** The listing being resubmitted, so its own current documents are re-usable. */
    listingId?: string;
    field?: string;
  }): Promise<Media[]> {
    const field = options.field ?? 'documentIds';

    if (!options.documentIds.length) return [];

    const rows = await this.database.media.findMany({
      where: { id: { in: options.documentIds }, uploadedById: options.uploaderId },
    });
    const byId = new Map(rows.map(row => [row.id, row]));
    const missing = options.documentIds.filter(id => !byId.has(id));

    if (missing.length) {
      // Not found, or somebody else's. One answer for both: which of the two it was is not
      // something the caller is entitled to learn.
      throw this.unusable(field, 'One of those documents could not be found.');
    }

    const prepared: Media[] = [];

    for (const id of options.documentIds) {
      const row = byId.get(id)!;

      if (row.purpose !== MediaPurpose.VERIFICATION) {
        throw this.unusable(field, 'That file was not uploaded as a supporting document.');
      }

      if (!DOCUMENT_MIME_TYPES.includes(row.mimeType as DocumentMimeType)) {
        throw this.unusable(field, 'Documents must be a PDF, a PNG or a JPEG.');
      }

      // Already in use. A document belongs to one listing; re-using one across two would mean
      // deleting it from under the other on the next resubmission.
      if (row.ownerId && row.ownerId !== options.listingId) {
        throw this.unusable(field, 'That document is already attached to something else.');
      }

      // A superseded document is not re-usable even on its own listing: it was kept for the record
      // of a decision, and attaching it again would make the record ambiguous.
      if (row.supersededAt) {
        throw this.unusable(field, 'That document was replaced. Please upload it again.');
      }

      // Refused regardless of `MEDIA_SCAN_REQUIRED`. That flag exists because nothing writes
      // `CLEAN`, so requiring it would make every upload unattachable — but *refusing* something
      // already known to be infected needs nothing to write `CLEAN` first.
      if (row.scanStatus === MediaScanStatus.INFECTED) {
        throw this.unusable(field, 'That file could not be accepted.');
      }

      prepared.push(await this.sanitise(row, field));
    }

    return prepared;
  }

  /**
   * The content check and the metadata strip, per file.
   *
   * The check is the important half. The upload declared a type, the presigned URL was signed
   * against it, and S3 enforces it on the PUT — but all of that is about the `Content-Type`
   * *header*, which the uploader also controls. Nothing had looked at the bytes.
   */
  private async sanitise(row: Media, field: string): Promise<Media> {
    const head = await this.storage.read(row.storageKey, { start: 0, end: SNIFF_BYTES - 1 });

    if (!head) {
      // The bytes are not there. Usually a member who reserved a URL and never finished the PUT.
      throw this.unusable(field, 'That upload did not finish. Please try again.');
    }

    if (!matchesDeclaredType(head, row.mimeType)) {
      // Treated exactly like an infected file: the object goes, and the row is marked so nothing
      // can attach it later or try again.
      await this.reject(row, 'content type did not match the declared type');

      throw this.unusable(field, 'That file is not the type it claims to be.');
    }

    // Images get rewritten, PDFs get read. Both are bounded by the 10MB upload limit, so reading
    // the whole object is a known cost rather than an open-ended one.
    if (row.type === MediaType.IMAGE) return this.stripAndStore(row);

    if (row.mimeType === 'application/pdf') return this.countPages(row);

    return row;
  }

  /** Rewrites the stored object without its metadata segments. */
  private async stripAndStore(row: Media): Promise<Media> {
    try {
      const bytes = await this.storage.read(row.storageKey);

      if (!bytes) return row;

      const stripped = stripImageMetadata(bytes);

      // Only write when something actually came off. A no-op PUT costs a round trip and a new
      // object version for nothing.
      if (stripped.length === bytes.length) return row;

      await this.storage.put(row.storageKey, stripped, row.mimeType);

      return this.database.media.update({
        where: { id: row.id },
        data: { byteSize: stripped.length },
      });
    } catch (error) {
      // A document that could not be stripped is still a document a reviewer needs. Logged loudly
      // rather than refused: the alternative is a member unable to submit because a metadata
      // rewrite failed, and the file is private either way.
      this.logger.error(`Could not strip metadata from ${row.id}: ${(error as Error).message}`);

      return row;
    }
  }

  /** Reads the page count off the PDF's page tree, or leaves it null. */
  private async countPages(row: Media): Promise<Media> {
    try {
      const bytes = await this.storage.read(row.storageKey);
      const pages = bytes ? pdfPageCount(bytes) : null;

      if (pages === null) return row;

      return this.database.media.update({ where: { id: row.id }, data: { pageCount: pages } });
    } catch (error) {
      this.logger.warn(`Could not read the page count of ${row.id}: ${(error as Error).message}`);

      return row;
    }
  }

  /** Deletes the object and marks the row, so nothing can attach it afterwards. */
  private async reject(row: Media, why: string): Promise<void> {
    this.logger.warn(`Rejecting document ${row.id}: ${why}`);

    await this.storage.delete(row.storageKey).catch(() => undefined);
    await this.database.media.update({
      where: { id: row.id },
      data: { scanStatus: MediaScanStatus.INFECTED, scannedAt: new Date() },
    });
  }

  private unusable(field: string, message: string): ApiException {
    return ApiException.unprocessable(ApiErrorCode.DOCUMENT_NOT_USABLE, message, {
      details: [{ field, message }],
    });
  }

  // ─── Writing ──────────────────────────────────────────────────────────────

  /**
   * Makes `documents` the listing's current submission.
   *
   * Anything attached that is not in the new set is **superseded, not deleted**: it was the
   * evidence behind a decision somebody took, and an appeal about that decision is an appeal about
   * those files. `retention.purge-documents` deletes them ninety days later.
   */
  async setCurrent(tx: Tx, listingId: string, documents: Media[]): Promise<void> {
    const keeping = new Set(documents.map(row => row.id));
    const attached = await tx.media.findMany({
      where: { ownerType: LISTING_DOCUMENT_OWNER, ownerId: listingId, supersededAt: null },
      select: { id: true },
    });
    const dropped = attached.filter(row => !keeping.has(row.id)).map(row => row.id);

    if (dropped.length) {
      await tx.media.updateMany({
        where: { id: { in: dropped } },
        data: { supersededAt: new Date() },
      });
    }

    for (const [index, row] of documents.entries()) {
      await tx.media.update({
        where: { id: row.id },
        data: {
          ownerType: LISTING_DOCUMENT_OWNER,
          ownerId: listingId,
          position: index,
          status: MediaStatus.ATTACHED,
          attachedAt: row.attachedAt ?? new Date(),
          supersededAt: null,
          expiresAt: null,
        },
      });
    }
  }

  /**
   * Supersedes every current document, for a listing that no longer needs any.
   *
   * A member who swaps a gated profession for an ordinary one is no longer being asked to prove
   * anything, so the platform stops holding their certificates — after the retention window, so a
   * decision taken while they were gated can still be appealed.
   */
  async supersedeAll(tx: Tx, listingId: string): Promise<number> {
    const result = await tx.media.updateMany({
      where: { ownerType: LISTING_DOCUMENT_OWNER, ownerId: listingId, supersededAt: null },
      data: { supersededAt: new Date() },
    });

    return result.count;
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  /** The current submission's documents, oldest first, for one listing. */
  async current(listingId: string): Promise<Media[]> {
    return this.database.media.findMany({
      where: { ownerType: LISTING_DOCUMENT_OWNER, ownerId: listingId, supersededAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** How many each of these listings is showing, for a list page. */
  async countsFor(listingIds: string[]): Promise<Map<string, number>> {
    if (!listingIds.length) return new Map();

    const grouped = await this.database.media.groupBy({
      by: ['ownerId'],
      _count: { id: true },
      where: {
        ownerType: LISTING_DOCUMENT_OWNER,
        ownerId: { in: listingIds },
        supersededAt: null,
      },
    });

    return new Map(grouped.map(row => [row.ownerId as string, row._count.id]));
  }

  /**
   * One document's bytes, for a reviewer.
   *
   * No presigned URL and no redirect, by design. A presigned URL is a bearer token for a
   * qualification certificate that works for anybody who gets hold of it, outlives the session it
   * was minted in, and lands in browser history and any proxy on the way. Streaming through the
   * API keeps the file behind the staff guard stack for every byte of it.
   */
  async read(
    ownerId: string,
    documentId: string,
    /**
     * Whose submission this is. Defaults to a listing's, and v2's category verifications pass
     * their own — the rules below are identical and the owner type is the only difference, so one
     * reader serves both rather than two that drift on the scan check.
     */
    ownerType: string = LISTING_DOCUMENT_OWNER,
  ): Promise<{ bytes: Buffer; mimeType: DocumentMimeType; fileName: string }> {
    const row = await this.database.media.findUnique({ where: { id: documentId } });

    // Not part of *this* submission. A superseded document is a 404 here too: the reviewer is
    // looking at a submission, and a file that is no longer in it is not part of what they are
    // deciding.
    if (!row || row.ownerType !== ownerType || row.ownerId !== ownerId || row.supersededAt) {
      throw ApiException.notFound('That document is not part of this submission.');
    }

    if (row.scanStatus === MediaScanStatus.INFECTED) {
      throw ApiException.gone(
        ApiErrorCode.DOCUMENT_REMOVED,
        'That document was removed because it could not be accepted.',
      );
    }

    if (row.scanStatus === MediaScanStatus.PENDING && this.scanPending()) {
      throw ApiException.conflict(
        ApiErrorCode.DOCUMENT_SCANNING,
        'That document is still being checked. Try again in a moment.',
      );
    }

    const bytes = await this.storage.read(row.storageKey);

    if (!bytes) {
      throw ApiException.gone(ApiErrorCode.DOCUMENT_REMOVED, 'That document is no longer stored.');
    }

    return {
      bytes,
      mimeType: row.mimeType as DocumentMimeType,
      fileName: this.displayName(row),
    };
  }

  /**
   * Whether a scan is genuinely still running.
   *
   * `scanStatus` is `PENDING` for **every** upload on this deployment, because no scanner exists to
   * move it — which is the whole reason `MEDIA_SCAN_REQUIRED` cannot be enabled (see
   * `config.validation.ts`). So a flat `PENDING` check would make every document a 409 and no
   * reviewer could ever open one: the same failure as switching that flag on.
   *
   * The flag is therefore what decides. Off means no scanner, so `PENDING` carries no information
   * and a document opens. On means a scanner is wired up and its verdict is enforced, so `PENDING`
   * means the scan is still running and `409 DOCUMENT_SCANNING` is the right answer. The contract
   * is intact and starts applying the moment there is something behind it.
   *
   * A time-based grace window was the first attempt and was worse: it blocked the first two
   * minutes, which is exactly when a reviewer working a fresh queue would look, and allowed
   * everything afterwards — the opposite of what a scan gate is for.
   */
  private scanPending(): boolean {
    return this.scanRequired;
  }

  /** The name to show, falling back to something readable rather than a uuid. */
  displayName(row: Media): string {
    if (row.fileName?.trim()) return row.fileName.trim();

    const extension = row.storageKey.slice(row.storageKey.lastIndexOf('.'));

    return `document-${row.id.slice(0, 8)}${extension.length <= 5 ? extension : ''}`;
  }

  toView(row: Media): ListingDocumentView {
    return {
      id: row.id,
      fileName: this.displayName(row),
      mimeType: row.mimeType as DocumentMimeType,
      sizeBytes: row.byteSize,
      pageCount: row.pageCount,
      uploadedAt: row.createdAt.toISOString(),
    };
  }

  /** The member's own shape (§1.6): no page count, no timestamps they have no use for. */
  toMemberView(
    row: Media,
  ): Pick<ListingDocumentView, 'id' | 'fileName' | 'mimeType' | 'sizeBytes'> {
    return {
      id: row.id,
      fileName: this.displayName(row),
      mimeType: row.mimeType as DocumentMimeType,
      sizeBytes: row.byteSize,
    };
  }
}
