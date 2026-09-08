/**
 * Width and height out of an image's header, without decoding it.
 *
 * Every format the API accepts announces its size in the first few bytes, long before any pixel
 * data. Reading it costs a ranged GET of the head of the object rather than the whole file, which
 * matters when the file is a photo from a modern phone.
 *
 * Deliberately header-only: this file never decodes an image and has no dependencies. A thumbnail
 * or a blur hash needs real pixels and belongs to whatever decoder is chosen for that job.
 */
export interface Dimensions {
  width: number;
  height: number;
}

/** PNG: fixed layout, IHDR is always the first chunk (RFC 2083). */
const png = (buffer: Buffer): Dimensions | null => {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;

  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

/**
 * JPEG: a chain of markers. The size lives in a Start Of Frame, of which there are several kinds
 * (baseline, progressive, and the arithmetic-coded variants), so the scan matches the family
 * rather than one marker. DHT, DAC and RST markers are skipped explicitly because they are not
 * frames and would otherwise be misread as one.
 */
const jpeg = (buffer: Buffer): Dimensions | null => {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;

  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];

    // Standalone markers carry no length: padding, restart intervals, start of image.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = buffer.readUInt16BE(offset + 2);
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isFrame) {
      // SOF payload: precision, then height, then width.
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }

    if (length < 2) return null;

    offset += 2 + length;
  }

  return null;
};

/** WebP: a RIFF container with three possible codecs, each announcing its size differently. */
const webp = (buffer: Buffer): Dimensions | null => {
  if (buffer.length < 30) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const codec = buffer.toString('ascii', 12, 16);

  // Lossy: a VP8 keyframe header, 14 bytes in, 14 bits per axis.
  if (codec === 'VP8 ') {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }

  // Lossless: 14 bits per axis, packed across four bytes, and stored one less than the real size.
  if (codec === 'VP8L') {
    const bits = buffer.readUInt32LE(21);

    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }

  // Extended: 24 bits per axis, also stored one less.
  if (codec === 'VP8X') {
    const width = buffer.readUIntLE(24, 3) + 1;
    const height = buffer.readUIntLE(27, 3) + 1;

    return { width, height };
  }

  return null;
};

/**
 * HEIC: ISO base media format, the same box tree as MP4. The size is in an `ispe` box, which sits
 * several levels down inside `meta`. Rather than walking the tree, this scans for the box type,
 * which is safe because `ispe` appears only in that one place and carries its size immediately.
 *
 * It matters because it is what an iPhone produces by default.
 */
const heic = (buffer: Buffer): Dimensions | null => {
  if (buffer.length < 12 || buffer.toString('ascii', 4, 8) !== 'ftyp') return null;

  const marker = buffer.indexOf('ispe', 0, 'ascii');

  if (marker < 0 || marker + 16 > buffer.length) return null;

  // ispe: 4 bytes of version and flags, then width and height.
  return { width: buffer.readUInt32BE(marker + 8), height: buffer.readUInt32BE(marker + 12) };
};

const PARSERS: Record<string, (buffer: Buffer) => Dimensions | null> = {
  'image/png': png,
  'image/jpeg': jpeg,
  'image/webp': webp,
  'image/heic': heic,
};

/** Sane bounds, so a misparse becomes "unknown" rather than a layout of 65535 pixels. */
const plausible = (size: Dimensions | null): Dimensions | null =>
  size && size.width > 0 && size.height > 0 && size.width <= 60_000 && size.height <= 60_000
    ? size
    : null;

export const imageDimensions = (mimeType: string, buffer: Buffer): Dimensions | null => {
  const declared = PARSERS[mimeType];
  const first = declared ? plausible(declared(buffer)) : null;

  if (first) return first;

  // The declared type is only the client's word for it, and clients mislabel constantly — a HEIC
  // sent as `image/jpeg` is routine. Every parser reads a handful of bytes and rejects anything
  // that is not its own format, so trying the rest costs nothing and saves a jumping layout.
  for (const [type, candidate] of Object.entries(PARSERS)) {
    if (type === mimeType) continue;

    const size = plausible(candidate(buffer));

    if (size) return size;
  }

  return null;
};
