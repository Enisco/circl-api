/**
 * Width, height and duration out of an MP4 or QuickTime file, without decoding a frame.
 *
 * Both are ISO base media files: a tree of boxes, each `[4-byte length][4-byte type][payload]`.
 * Everything needed is in the `moov` box, which is metadata only — `mvhd` carries the duration and
 * a timescale, `tkhd` carries each track's dimensions.
 *
 * The awkward part is that `moov` may sit at the front of the file or at the very end. A recorder
 * cannot know the final duration until it stops, so a phone typically writes the media data first
 * and the header last. A reader that only looks at the head finds nothing on exactly the files
 * members upload, which is why the caller is told which end to fetch next rather than given up on.
 */
export interface VideoMetadata {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

interface Box {
  type: string;
  start: number;
  end: number;
  payload: number;
}

/** The boxes directly inside `[start, end)`, ignoring anything truncated. */
const boxesIn = (buffer: Buffer, start: number, end: number): Box[] => {
  const boxes: Box[] = [];
  let offset = start;

  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    let payload = offset + 8;

    // 1 means the real size is a 64-bit value after the type; 0 means "to the end of the file".
    if (size === 1) {
      if (offset + 16 > end) break;

      // Only the low 32 bits are read: a box over 4GB is not a thing this code will meet, and
      // reading the high word would need a BigInt for no gain.
      size = buffer.readUInt32BE(offset + 12);
      payload = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < 8) break;

    const boxEnd = Math.min(offset + size, end);

    boxes.push({ type: buffer.toString('ascii', offset + 4, offset + 8), start: offset, end: boxEnd, payload });
    offset += size;
  }

  return boxes;
};

const findBox = (buffer: Buffer, start: number, end: number, type: string): Box | null =>
  boxesIn(buffer, start, end).find(box => box.type === type) ?? null;

/** `mvhd`: the movie header, which is where the only reliable duration lives. */
const durationFrom = (buffer: Buffer, moov: Box): number | null => {
  const mvhd = findBox(buffer, moov.payload, moov.end, 'mvhd');

  if (!mvhd) return null;

  const version = buffer[mvhd.payload];
  // Version 1 widened the timestamps to 64 bits, which moves everything after them.
  const base = mvhd.payload + 4;

  try {
    if (version === 1) {
      if (mvhd.payload + 36 > buffer.length) return null;

      const timescale = buffer.readUInt32BE(base + 16);
      const duration = Number(buffer.readBigUInt64BE(base + 20));

      return timescale > 0 ? Math.round((duration / timescale) * 1000) : null;
    }

    if (mvhd.payload + 24 > buffer.length) return null;

    const timescale = buffer.readUInt32BE(base + 8);
    const duration = buffer.readUInt32BE(base + 12);

    return timescale > 0 ? Math.round((duration / timescale) * 1000) : null;
  } catch {
    return null;
  }
};

/**
 * `tkhd`: per track. The dimensions are 16.16 fixed point at the end of the box, and are zero on a
 * sound track, so the video track is the one with a non-zero size rather than the first one.
 */
const dimensionsFrom = (buffer: Buffer, moov: Box): { width: number; height: number } | null => {
  for (const trak of boxesIn(buffer, moov.payload, moov.end).filter(box => box.type === 'trak')) {
    const tkhd = findBox(buffer, trak.payload, trak.end, 'tkhd');

    if (!tkhd) continue;

    const version = buffer[tkhd.payload];
    const end = version === 1 ? tkhd.payload + 96 : tkhd.payload + 84;

    if (end > buffer.length || end > tkhd.end) continue;

    const width = buffer.readUInt32BE(end - 8) / 65536;
    const height = buffer.readUInt32BE(end - 4) / 65536;

    if (width > 0 && height > 0) {
      return { width: Math.round(width), height: Math.round(height) };
    }
  }

  return null;
};

/**
 * Reads what it can from the bytes given. Returns `needsTail` when the file's boxes were walked to
 * the end without finding `moov`, which means it is at the other end of the object and the caller
 * should fetch the tail and try again.
 */
export const videoMetadata = (
  buffer: Buffer,
): { metadata: VideoMetadata; needsTail: boolean } => {
  const empty: VideoMetadata = { width: null, height: null, durationMs: null };
  const top = boxesIn(buffer, 0, buffer.length);
  const moov = top.find(box => box.type === 'moov');

  if (!moov) {
    // `ftyp` at the front and no `moov` in what we have: it is a real file, header at the far end.
    const looksLikeVideo = top.some(box => box.type === 'ftyp' || box.type === 'mdat');

    return { metadata: empty, needsTail: looksLikeVideo };
  }

  const size = dimensionsFrom(buffer, moov);

  return {
    metadata: {
      width: size?.width ?? null,
      height: size?.height ?? null,
      durationMs: durationFrom(buffer, moov),
    },
    // A `moov` that runs past what was fetched was only partly read.
    needsTail: moov.end > buffer.length && !size,
  };
};

/** The same walk over a tail fetch, where box offsets are relative to the slice, not the file. */
export const videoMetadataFromTail = (buffer: Buffer): VideoMetadata => {
  // A tail slice usually starts mid-box, so the first plausible `moov` is found by scanning for
  // the type marker and stepping back to its length field.
  for (let offset = 0; offset + 8 <= buffer.length; offset += 1) {
    if (buffer.toString('ascii', offset + 4, offset + 8) !== 'moov') continue;

    const { metadata } = videoMetadata(buffer.subarray(offset));

    if (metadata.width || metadata.durationMs) return metadata;
  }

  return { width: null, height: null, durationMs: null };
};
