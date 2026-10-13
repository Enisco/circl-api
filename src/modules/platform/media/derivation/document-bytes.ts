/**
 * Reading and sanitising the three file types a supporting document may be (§2.9).
 *
 * Pure functions over buffers, with no image library, which is deliberate twice over. There is no
 * `sharp` in this project and adding one to strip a metadata block would be a native dependency
 * and a re-encode — and a re-encode of somebody's qualification certificate loses detail for no
 * reason. Everything here works on the *container*: JPEG and PNG both carry metadata in
 * self-describing segments that can be dropped without touching a pixel.
 *
 * Tested exhaustively, because every function is a parser reading attacker-supplied bytes. A
 * parser that walks off the end of a buffer on a malformed file is a crash in a write path.
 */

export type DocumentMimeType =
  | 'application/pdf'
  | 'image/png'
  | 'image/jpeg'
  | 'image/heic'
  | 'image/heif';

export const DOCUMENT_MIME_TYPES: DocumentMimeType[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  // What an iPhone produces by default (v2 §2.4). Accepted here and nowhere else: a member
  // photographing a certificate with the camera they own should not be turned away for it.
  'image/heic',
  'image/heif',
];

/** Enough for every signature below, and the range the content check reads. */
export const SNIFF_BYTES = 16;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1');

/**
 * What the bytes actually are, or null if they are none of the three.
 *
 * The declared MIME type is a claim the uploader makes; this is the only thing that knows. A PDF
 * renamed `.png` and declared `image/png` would otherwise be stored, served back to a reviewer
 * with `Content-Type: image/png`, and whatever the browser decided to do with it would be the
 * platform's problem.
 */
export const sniffDocument = (head: Buffer): DocumentMimeType | null => {
  if (head.length >= PDF_SIGNATURE.length && head.subarray(0, 5).equals(PDF_SIGNATURE)) {
    return 'application/pdf';
  }

  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';

  // SOI plus the first marker byte. Every JPEG starts FF D8 FF, whatever follows.
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }

  if (isHeifBrand(head)) return 'image/heic';

  return null;
};

/**
 * An ISO base media file whose brand is one of the HEIF family.
 *
 * `ftyp` sits at offset 4 with the brand at 8, and the brands an iPhone writes are `heic`, `heix`
 * and `mif1`; `msf1` and `hevc` appear on sequences. Matched on the family rather than the exact
 * brand, because which one a device writes is a detail of its encoder and all of them are the same
 * container to everything downstream.
 */
const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'];

const isHeifBrand = (head: Buffer): boolean =>
  head.length >= 12 &&
  head.toString('ascii', 4, 8) === 'ftyp' &&
  HEIF_BRANDS.includes(head.toString('ascii', 8, 12));

/**
 * Whether the bytes match what was declared.
 *
 * `image/heic` and `image/heif` are one answer: the container is identical and which of the two
 * names a phone puts on it is not something the file itself records. Refusing a member because
 * their camera chose the other registered name for the same bytes would be a refusal about
 * nothing.
 */
export const matchesDeclaredType = (head: Buffer, declared: string): boolean => {
  const actual = sniffDocument(head);

  if (actual === null) return false;
  if (actual === 'image/heic') return declared === 'image/heic' || declared === 'image/heif';

  return actual === declared;
};

/**
 * Removes every metadata segment from a JPEG, leaving the image data untouched.
 *
 * `APP1` is where EXIF lives, and EXIF is where a phone writes the GPS coordinates of wherever the
 * photo was taken — which, for a photo of a certificate, is usually somebody's home. `APP13` holds
 * IPTC, `APP2` an ICC profile, and `COM` a free-text comment. All of them go: a scan of a
 * qualification needs none of it, and the one thing worse than not having metadata is holding
 * somebody's home address without meaning to.
 *
 * Walks the marker chain rather than searching for bytes. Entropy-coded scan data can contain any
 * byte sequence, so a search would eventually find a fake marker inside an image and corrupt it.
 * Returns the input unchanged if anything about the structure is unexpected — a file this cannot
 * parse confidently is one to leave alone rather than truncate.
 */
export const stripJpegMetadata = (input: Buffer): Buffer => {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return input;

  const keep: Buffer[] = [input.subarray(0, 2)];
  let offset = 2;

  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) return input;

    let marker = input[offset + 1];

    // Fill bytes: a run of FFs before the marker is legal padding.
    while (marker === 0xff && offset + 2 < input.length) {
      offset += 1;
      marker = input[offset + 1];
    }

    // Start of scan: everything from here to the end is image data and markers stop having
    // lengths. Nothing after this point is metadata, so it is copied wholesale.
    if (marker === 0xda) {
      keep.push(input.subarray(offset));

      return Buffer.concat(keep);
    }

    // Standalone markers, no length field.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      keep.push(input.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }

    const length = input.readUInt16BE(offset + 2);

    // A segment length includes its own two bytes, so anything under two is malformed.
    if (length < 2 || offset + 2 + length > input.length) return input;

    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;

    if (!isMetadata) keep.push(input.subarray(offset, offset + 2 + length));

    offset += 2 + length;
  }

  // Ran out of bytes without reaching a scan: not a file to rewrite.
  return input;
};

/** PNG chunks that carry metadata rather than image data. */
const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

/**
 * The same for PNG, which is a plain chunk list and so easier to be sure about.
 *
 * `eXIf` is the EXIF block. The three text chunks are where editors leave author names and
 * software versions, and `tIME` is a modification timestamp. Dropping a chunk is just not copying
 * it; no CRC needs recomputing, because each chunk carries its own.
 */
export const stripPngMetadata = (input: Buffer): Buffer => {
  if (input.length < 8 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) return input;

  const keep: Buffer[] = [input.subarray(0, 8)];
  let offset = 8;

  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.subarray(offset + 4, offset + 8).toString('latin1');
    const end = offset + 12 + length;

    // A length that runs past the buffer is a malformed or truncated file.
    if (end > input.length) return input;

    if (!PNG_METADATA_CHUNKS.has(type)) keep.push(input.subarray(offset, end));

    offset = end;

    if (type === 'IEND') return Buffer.concat(keep);
  }

  return input;
};

/** Dispatches on what the bytes are, not on what was declared. */
export const stripImageMetadata = (input: Buffer): Buffer => {
  switch (sniffDocument(input)) {
    case 'image/jpeg':
      return stripJpegMetadata(input);
    case 'image/png':
      return stripPngMetadata(input);
    case 'image/heic':
    case 'image/heif':
      return stripHeifExif(input);
    default:
      return input;
  }
};

/**
 * How many pages a PDF has, or null when it cannot be read with confidence.
 *
 * Read off the page tree's `/Count`, which is the only authoritative place. Counting `/Type /Page`
 * occurrences — the obvious shortcut — over-counts on a PDF with incremental updates and
 * under-counts on one with object streams, and a page count that is quietly wrong is worse than a
 * blank: a reviewer who sees "1 page" does not look for the second.
 *
 * So: find the `/Pages` object, take the largest `/Count` among them (the root of the tree has the
 * total), and give up rather than guess. Null is a perfectly good answer — the spec says "when
 * known".
 */
export const pdfPageCount = (input: Buffer): number | null => {
  const text = input.toString('latin1');
  let best: number | null = null;

  // `/Type /Pages` with optional whitespace, then the `/Count` that belongs to that object. The
  // two can appear in either order inside the dictionary, so each candidate object is scanned
  // from its start to the next `endobj`.
  const pagesPattern = /\/Type\s*\/Pages\b/g;
  let match: RegExpExecArray | null;

  while ((match = pagesPattern.exec(text)) !== null) {
    // Back to the start of the enclosing object, forward to its end: the window the `/Count`
    // belonging to this node must sit in.
    const objectStart = text.lastIndexOf('obj', match.index);
    const objectEnd = text.indexOf('endobj', match.index);
    const window = text.slice(
      objectStart === -1 ? match.index : objectStart,
      objectEnd === -1 ? Math.min(text.length, match.index + 4096) : objectEnd,
    );
    const count = /\/Count\s+(\d+)/.exec(window);

    if (!count) continue;

    const value = Number(count[1]);

    // A page tree's root holds the total, and children hold their own subtotals, so the largest is
    // the answer. Zero and absurd values are treated as unreadable rather than reported.
    if (Number.isInteger(value) && value > 0 && value < 100_000) {
      best = best === null ? value : Math.max(best, value);
    }
  }

  return best;
};

/**
 * Blanks the EXIF payload inside a HEIF container, in place.
 *
 * The reason is the same one the JPEG strip exists for and it matters more here: HEIC is the
 * iPhone's default, and a photograph of a certificate taken at home carries the GPS coordinates of
 * that home. Accepting the format without this would have added the leak the rest of this file
 * exists to prevent, into the one place a stranger reads: a reviewer's document viewer.
 *
 * **Overwritten rather than removed**, which is the whole trick. HEIF is a box tree where item
 * payloads are addressed by absolute offset from `iloc`; deleting bytes would move every later
 * payload and break the picture. Zeroing the EXIF extent leaves every offset and the file length
 * exactly as they were, and an empty EXIF block is auxiliary data that every renderer skips.
 *
 * Returns a **copy** when something was blanked and the input untouched when there was nothing to
 * blank, which is the contract `stripAndStore` reads to decide whether to write the object back.
 */
export const stripHeifExif = (input: Buffer): Buffer => {
  const meta = findBox(input, 'meta', 0, input.length);

  if (!meta) return input;

  // `meta` is a FullBox: four bytes of version and flags before its children.
  const iinf = findBox(input, 'iinf', meta.payload + 4, meta.end);
  const iloc = findBox(input, 'iloc', meta.payload + 4, meta.end);

  if (!iinf || !iloc) return input;

  const exifItems = exifItemIds(input, iinf);

  if (!exifItems.length) return input;

  const extents = exifExtents(input, iloc, exifItems);

  if (!extents.length) return input;

  const output = Buffer.from(input);
  let blanked = 0;

  for (const extent of extents) {
    if (extent.offset < 0 || extent.offset + extent.length > output.length) continue;

    output.fill(0, extent.offset, extent.offset + extent.length);
    blanked += extent.length;
  }

  return blanked ? output : input;
};

/** One box, found among siblings. Bounded on every read: these are attacker-supplied bytes. */
const findBox = (
  buffer: Buffer,
  type: string,
  from: number,
  until: number,
): { payload: number; end: number } | null => {
  let cursor = from;

  while (cursor + 8 <= until) {
    const size = buffer.readUInt32BE(cursor);
    const name = buffer.toString('ascii', cursor + 4, cursor + 8);
    // `0` means "to the end of the file"; `1` means a 64-bit size follows the name.
    const span =
      size === 0 ? until - cursor : size === 1 ? Number(buffer.readBigUInt64BE(cursor + 8)) : size;

    if (span < 8 || cursor + span > until) return null;
    if (name === type) return { payload: cursor + (size === 1 ? 16 : 8), end: cursor + span };

    cursor += span;
  }

  return null;
};

/** The item ids whose type is `Exif`, read from `iinf`'s `infe` entries. */
const exifItemIds = (buffer: Buffer, iinf: { payload: number; end: number }): number[] => {
  const version = buffer[iinf.payload];
  // FullBox header, then a 16- or 32-bit entry count depending on the version.
  let cursor = iinf.payload + 4;

  if (cursor + 2 > iinf.end) return [];

  const count = version === 0 ? buffer.readUInt16BE(cursor) : buffer.readUInt32BE(cursor);

  cursor += version === 0 ? 2 : 4;

  const ids: number[] = [];

  for (let index = 0; index < count && cursor + 8 <= iinf.end; index += 1) {
    const size = buffer.readUInt32BE(cursor);

    if (size < 8 || cursor + size > iinf.end) break;

    const name = buffer.toString('ascii', cursor + 4, cursor + 8);

    if (name === 'infe') {
      const entryVersion = buffer[cursor + 8];
      // infe v2 holds a 16-bit id then a 16-bit protection index then the type; v3 a 32-bit id.
      const idAt = cursor + 12;
      const id = entryVersion >= 3 ? buffer.readUInt32BE(idAt) : buffer.readUInt16BE(idAt);
      const typeAt = idAt + (entryVersion >= 3 ? 4 : 2) + 2;

      if (typeAt + 4 <= iinf.end && buffer.toString('ascii', typeAt, typeAt + 4) === 'Exif') {
        ids.push(id);
      }
    }

    cursor += size;
  }

  return ids;
};

/** Where those items' bytes actually live, from `iloc`. */
const exifExtents = (
  buffer: Buffer,
  iloc: { payload: number; end: number },
  wanted: number[],
): Array<{ offset: number; length: number }> => {
  const version = buffer[iloc.payload];
  let cursor = iloc.payload + 4;

  if (cursor + 2 > iloc.end) return [];

  const sizes = buffer[cursor];
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 0x0f;
  const baseSize = buffer[cursor + 1] >> 4;
  const indexSize = version >= 1 ? buffer[cursor + 1] & 0x0f : 0;

  cursor += 2;

  const count = version < 2 ? buffer.readUInt16BE(cursor) : buffer.readUInt32BE(cursor);

  cursor += version < 2 ? 2 : 4;

  const read = (at: number, bytes: number): number => {
    if (bytes === 0) return 0;
    if (at + bytes > iloc.end) return -1;
    if (bytes === 4) return buffer.readUInt32BE(at);
    if (bytes === 8) return Number(buffer.readBigUInt64BE(at));

    return -1;
  };

  const extents: Array<{ offset: number; length: number }> = [];

  for (let index = 0; index < count && cursor < iloc.end; index += 1) {
    const idSize = version < 2 ? 2 : 4;
    const id = version < 2 ? buffer.readUInt16BE(cursor) : buffer.readUInt32BE(cursor);

    cursor += idSize;

    if (version >= 1) cursor += 2; // construction method
    cursor += 2; // data reference index

    const base = read(cursor, baseSize);

    cursor += baseSize;

    if (cursor + 2 > iloc.end) break;

    const extentCount = buffer.readUInt16BE(cursor);

    cursor += 2;

    for (let extent = 0; extent < extentCount; extent += 1) {
      cursor += indexSize;

      const offset = read(cursor, offsetSize);

      cursor += offsetSize;

      const length = read(cursor, lengthSize);

      cursor += lengthSize;

      if (wanted.includes(id) && base >= 0 && offset >= 0 && length > 0) {
        extents.push({ offset: base + offset, length });
      }
    }
  }

  return extents;
};
