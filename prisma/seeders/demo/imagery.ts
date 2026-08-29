import { deflateSync } from 'zlib';
import { createHash } from 'crypto';

/** Generated placeholder imagery (B.2.2). */

const crc32Table = (() => {
  const table = new Int32Array(256);

  for (let n = 0; n < 256; n++) {
    let c = n;

    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

    table[n] = c;
  }

  return table;
})();

const crc32 = (buffer: Buffer): number => {
  let c = -1;

  for (const byte of buffer) c = crc32Table[(c ^ byte) & 0xff] ^ (c >>> 8);

  return (c ^ -1) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);

  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);

  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
};

/** A minimal PNG encoder: signature, IHDR, one deflated IDAT, IEND. */
const encodePng = (width: number, height: number, rgb: Buffer): Buffer => {
  const header = Buffer.alloc(13);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Each scanline is prefixed with its filter byte, which is 0 (none) throughout.
  const raw = Buffer.alloc(height * (1 + width * 3));

  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    rgb.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

type Rgb = [number, number, number];

/** A muted, readable palette. Deliberately not a rainbow: these sit behind text. */
const PALETTE: Rgb[] = [
  [0x2f, 0x4f, 0x6f],
  [0x5b, 0x4b, 0x8a],
  [0x1f, 0x6f, 0x5f],
  [0x8a, 0x4f, 0x3f],
  [0x4a, 0x5f, 0x2f],
  [0x6f, 0x3f, 0x5f],
  [0x2f, 0x5f, 0x8a],
  [0x7a, 0x5f, 0x2f],
];

const bytesOf = (seed: string): Buffer => createHash('sha256').update(seed).digest();

/** A symmetric block avatar, in the manner of a GitHub identicon. */
export const avatarPng = (seed: string, size = 240): Buffer => {
  const bytes = bytesOf(seed);
  const fill = PALETTE[bytes[0] % PALETTE.length];
  const background: Rgb = [0xf2, 0xf0, 0xec];

  const cells = 5;
  const cell = Math.floor(size / cells);
  const rgb = Buffer.alloc(size * size * 3);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const column = Math.min(Math.floor(x / cell), cells - 1);
      const row = Math.min(Math.floor(y / cell), cells - 1);
      // Mirror columns 3 and 4 onto 1 and 0.
      const mirrored = column < 3 ? column : cells - 1 - column;
      const on = bytes[1 + row * 3 + mirrored] % 2 === 0;
      const [r, g, b] = on ? fill : background;
      const at = (y * size + x) * 3;

      rgb[at] = r;
      rgb[at + 1] = g;
      rgb[at + 2] = b;
    }
  }

  return encodePng(size, size, rgb);
};

/** A soft two-tone gradient, for store logos, covers and item photos. */
export const bannerPng = (seed: string, width = 960, height = 540): Buffer => {
  const bytes = bytesOf(seed);
  const from = PALETTE[bytes[0] % PALETTE.length];
  const to = PALETTE[(bytes[1] + 3) % PALETTE.length];
  const rgb = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Diagonal, so neither a logo square nor a wide cover reads as flat.
      const t = (x / width + y / height) / 2;
      const at = (y * width + x) * 3;

      for (let c = 0; c < 3; c++) {
        rgb[at + c] = Math.round(from[c] * (1 - t) + to[c] * t);
      }
    }
  }

  return encodePng(width, height, rgb);
};
