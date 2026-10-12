import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  videoMetadata,
  videoMetadataFromTail,
} from '../../../src/modules/platform/media/derivation/video-metadata';

/**
 * Real photographs and real clips for the demo, from Flutter's public asset repository.
 *
 * The generated PNGs this replaces were coloured noise, which is the wrong thing to review a
 * photo-led design against: Connect draws a profile full-bleed and a shop draws a grid of covers,
 * and neither tells you anything when every tile is a gradient.
 *
 * The repository holds 359 images, but only these are photographs — the rest are UI screenshots
 * and animation-curve diagrams, which in a photo grid would look worse than noise. Six is enough
 * for variety across a gallery without any profile repeating itself.
 */
const BASE = 'https://flutter.github.io/assets-for-api-docs';

export const ASSET_PHOTOS = [
  // Two portrait, two landscape, two square: the ratios matter more than the subjects, because
  // the payload carries width and height and a card that gets them wrong jumps as it decodes.
  'assets/widgets/flamingos.jpg',
  'assets/widgets/owl-3.jpg',
  'assets/widgets/puffin.jpg',
  'assets/widgets/falcon.jpg',
  'assets/widgets/owl.jpg',
  'assets/widgets/owl-2.jpg',
] as const;

/** Real footage, so a seeded clip has a readable header and a duration nobody had to invent. */
export const ASSET_VIDEOS = ['assets/videos/bee.mp4', 'assets/videos/butterfly.mp4'] as const;

/** Stable per label, so a profile's gallery looks the same on every seed run. */
export const photoFor = (label: string): string => {
  const hash = createHash('sha256').update(label).digest();

  return ASSET_PHOTOS[hash[0] % ASSET_PHOTOS.length];
};

export const videoFor = (label: string): string => {
  const hash = createHash('sha256').update(label).digest();

  return ASSET_VIDEOS[hash[1] % ASSET_VIDEOS.length];
};

/**
 * Cached on disk between runs. The seed runs on every boot, and re-downloading two megabytes of
 * video each time is a slow start for bytes that never change.
 */
const CACHE = join(tmpdir(), 'circl-seed-assets');

const cachePathFor = (path: string): string =>
  join(
    CACHE,
    createHash('sha256').update(path).digest('hex').slice(0, 16) + '-' + path.split('/').pop(),
  );

/**
 * The bytes, or null when they cannot be had. Null is not a failure: the seed must not need the
 * internet to run, so a caller falls back to a generated image and the demo still comes up.
 */
export const fetchAsset = async (path: string): Promise<Buffer | null> => {
  const cached = cachePathFor(path);

  if (existsSync(cached)) {
    try {
      return readFileSync(cached);
    } catch {
      // Fall through and fetch it again.
    }
  }

  // One line, because a two-megabyte clip on a slow link takes a couple of minutes and a seeder
  // that simply stops for that long looks hung rather than busy. Cached afterwards, so it is a
  // one-off per machine.
  if (path.endsWith('.mp4')) {
    console.log(`  … fetching ${path} (first run only, then cached)`);
  }

  try {
    const response = await fetch(`${BASE}/${path}`, {
      // A photograph is tens of kilobytes and a clip is two megabytes, which does not arrive in
      // thirty seconds from everywhere — and a timeout here silently swaps a real video for a
      // generated image, which is the one substitution worth waiting to avoid.
      signal: AbortSignal.timeout(path.endsWith('.mp4') ? 180_000 : 30_000),
    });

    if (!response.ok) return null;

    const bytes = Buffer.from(await response.arrayBuffer());

    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cached, bytes);

    return bytes;
  } catch {
    return null;
  }
};

export interface AssetSize {
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/**
 * Read out of the file rather than declared beside it. A seeded row that claims a size the bytes
 * do not have is a demo that lies about the one field a full-bleed card cannot do without.
 */
export const sizeOf = (bytes: Buffer, mimeType: string): AssetSize => {
  if (mimeType === 'video/mp4') {
    const parsed = videoMetadata(bytes);
    const metadata = parsed.needsTail ? videoMetadataFromTail(bytes) : parsed.metadata;

    return {
      width: metadata.width,
      height: metadata.height,
      durationMs: metadata.durationMs,
    };
  }

  if (bytes.length > 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      durationMs: null,
    };
  }

  // JPEG: walk the segments to the start-of-frame, which is the only place the size is written.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let index = 2;

    while (index < bytes.length - 9) {
      if (bytes[index] !== 0xff) {
        index += 1;
        continue;
      }

      const marker = bytes[index + 1];

      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: bytes.readUInt16BE(index + 5),
          width: bytes.readUInt16BE(index + 7),
          durationMs: null,
        };
      }

      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        index += 2;
        continue;
      }

      index += 2 + bytes.readUInt16BE(index + 2);
    }
  }

  return { width: null, height: null, durationMs: null };
};

export const mimeFor = (path: string): string =>
  path.endsWith('.mp4') ? 'video/mp4' : path.endsWith('.png') ? 'image/png' : 'image/jpeg';
