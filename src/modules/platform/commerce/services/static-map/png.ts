import { deflateSync, inflateSync } from 'zlib';

/** An 8-bit RGB raster. Alpha is composited away on decode, because a map tile has nothing behind it. */
export interface Raster {
  width: number;
  height: number;
  /** `width * height * 3` bytes, row-major. */
  data: Buffer;
}

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/** Channels per pixel for each PNG colour type. Palette is one index byte. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Enough of a PNG decoder for map tiles: 8-bit, non-interlaced, any colour type. Written rather
 * than pulled in because the only thing that needs it is stitching four tiles together, and a
 * native image dependency is a build problem on every platform this runs on.
 */
export const decodePng = (buffer: Buffer): Raster => {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG');

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];

      if (body[12] !== 0) throw new Error('Interlaced PNGs are not supported');
    } else if (type === 'PLTE') {
      palette = Buffer.from(body);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(body);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }

    offset += 12 + length;
  }

  if (bitDepth !== 8) throw new Error(`Unsupported bit depth ${bitDepth}`);

  const channels = CHANNELS[colorType];

  if (!channels) throw new Error(`Unsupported colour type ${colorType}`);

  const raw = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels);
  const out = Buffer.alloc(width * height * 3);

  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 3;

    if (colorType === 3) {
      if (!palette) throw new Error('Indexed PNG with no palette');

      const entry = raw[source] * 3;
      // A fully transparent palette entry becomes white rather than black, so a tile's rounded
      // corners do not render as ink.
      const alpha = transparency?.[raw[source]] ?? 255;

      out[target] = alpha === 0 ? 255 : palette[entry];
      out[target + 1] = alpha === 0 ? 255 : palette[entry + 1];
      out[target + 2] = alpha === 0 ? 255 : palette[entry + 2];
      continue;
    }

    if (colorType === 0 || colorType === 4) {
      out[target] = raw[source];
      out[target + 1] = raw[source];
      out[target + 2] = raw[source];
      continue;
    }

    out[target] = raw[source];
    out[target + 1] = raw[source + 1];
    out[target + 2] = raw[source + 2];
  }

  return { width, height, data: out };
};

/** Reverses the five per-scanline filters PNG allows (RFC 2083 §6). */
const unfilter = (inflated: Buffer, width: number, height: number, channels: number): Buffer => {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  for (let row = 0; row < height; row += 1) {
    const filter = inflated[row * (stride + 1)];
    const source = row * (stride + 1) + 1;
    const target = row * stride;

    for (let index = 0; index < stride; index += 1) {
      const raw = inflated[source + index];
      const left = index >= channels ? out[target + index - channels] : 0;
      const up = row > 0 ? out[target - stride + index] : 0;
      const upLeft = row > 0 && index >= channels ? out[target - stride + index - channels] : 0;

      let value: number;

      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4:
          value = raw + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`Unknown PNG filter ${filter}`);
      }

      out[target + index] = value & 0xff;
    }
  }

  return out;
};

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);

  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Encodes an 8-bit RGB raster. Every scanline uses filter 0: the deflate does the work. */
export const encodePng = (raster: Raster): Buffer => {
  const stride = raster.width * 3;
  const withFilters = Buffer.alloc((stride + 1) * raster.height);

  for (let row = 0; row < raster.height; row += 1) {
    withFilters[row * (stride + 1)] = 0;
    raster.data.copy(withFilters, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);

  ihdr.writeUInt32BE(raster.width, 0);
  ihdr.writeUInt32BE(raster.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(withFilters, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const chunk = (type: string, body: Buffer): Buffer => {
  const out = Buffer.alloc(body.length + 12);

  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);

  return out;
};

const CRC_TABLE = (() => {
  const table = new Int32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value;
  }

  return table;
})();

const crc32 = (buffer: Buffer): number => {
  let crc = -1;

  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);

  return (crc ^ -1) >>> 0;
};
