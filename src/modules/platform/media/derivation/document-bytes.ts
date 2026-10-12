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

export type DocumentMimeType = 'application/pdf' | 'image/png' | 'image/jpeg';

export const DOCUMENT_MIME_TYPES: DocumentMimeType[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
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

  return null;
};

/** Whether the bytes match what was declared. Both have to be one of the three. */
export const matchesDeclaredType = (head: Buffer, declared: string): boolean => {
  const actual = sniffDocument(head);

  return actual !== null && actual === declared;
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
