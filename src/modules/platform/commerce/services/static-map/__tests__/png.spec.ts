import { deflateSync } from 'zlib';
import { decodePng, encodePng } from '../png';
import { project, TILE_SIZE } from '../tiles';

/** Builds a PNG by hand so the decoder is tested against bytes it did not produce. */
const buildPng = (
  width: number,
  height: number,
  colorType: number,
  raw: Buffer,
  extra: Array<[string, Buffer]> = [],
): Buffer => {
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(body.length + 12);

    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);

    let crc = -1;

    for (const byte of out.subarray(4, 8 + body.length)) {
      crc ^= byte;

      for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }

    out.writeUInt32BE((crc ^ -1) >>> 0, 8 + body.length);

    return out;
  };

  const ihdr = Buffer.alloc(13);

  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;

  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    ...extra.map(([type, body]) => chunk(type, body)),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/** Prefixes each scanline with its filter byte. */
const scanlines = (rows: number[][], filter = 0): Buffer =>
  Buffer.concat(rows.map(row => Buffer.concat([Buffer.from([filter]), Buffer.from(row)])));

describe('static map PNG codec', () => {
  it('round-trips an RGB raster', () => {
    const data = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
    const decoded = decodePng(encodePng({ width: 2, height: 2, data }));

    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect([...decoded.data]).toEqual([...data]);
  });

  it('decodes the indexed tiles OpenStreetMap actually serves', () => {
    // Colour type 3: one palette index per pixel.
    const palette = Buffer.from([10, 20, 30, 40, 50, 60]);
    const png = buildPng(2, 1, 3, scanlines([[0, 1]]), [['PLTE', palette]]);

    expect([...decodePng(png).data]).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('treats a fully transparent palette entry as white, not as ink', () => {
    const palette = Buffer.from([0, 0, 0, 40, 50, 60]);
    const png = buildPng(2, 1, 3, scanlines([[0, 1]]), [
      ['PLTE', palette],
      // Entry 0 is fully transparent.
      ['tRNS', Buffer.from([0])],
    ]);

    expect([...decodePng(png).data]).toEqual([255, 255, 255, 40, 50, 60]);
  });

  it('reverses the Sub filter', () => {
    // Filter 1 stores each byte as a delta from the pixel to its left.
    const png = buildPng(3, 1, 2, scanlines([[10, 10, 10, 5, 5, 5, 5, 5, 5]], 1));

    expect([...decodePng(png).data]).toEqual([10, 10, 10, 15, 15, 15, 20, 20, 20]);
  });

  it('reverses the Up filter', () => {
    const png = Buffer.concat([
      buildPng(1, 2, 2, Buffer.concat([
        Buffer.concat([Buffer.from([0]), Buffer.from([9, 9, 9])]),
        Buffer.concat([Buffer.from([2]), Buffer.from([1, 1, 1])]),
      ])),
    ]);

    expect([...decodePng(png).data]).toEqual([9, 9, 9, 10, 10, 10]);
  });

  it('expands greyscale to three channels', () => {
    const png = buildPng(2, 1, 0, scanlines([[7, 200]]));

    expect([...decodePng(png).data]).toEqual([7, 7, 7, 200, 200, 200]);
  });

  it('drops the alpha channel rather than compositing it onto black', () => {
    const png = buildPng(1, 1, 6, scanlines([[12, 34, 56, 0]]));

    expect([...decodePng(png).data]).toEqual([12, 34, 56]);
  });

  it('refuses an interlaced PNG rather than decoding it as noise', () => {
    const png = buildPng(1, 1, 2, scanlines([[1, 2, 3]]));

    // Byte 12 of IHDR's body is the interlace flag.
    png[8 + 8 + 12] = 1;

    expect(() => decodePng(png)).toThrow(/nterlaced/);
  });
});

describe('slippy map projection', () => {
  it('puts the prime meridian at the equator in the middle of the world', () => {
    const { x, y } = project(0, 0, 0);

    expect(x).toBeCloseTo(TILE_SIZE / 2, 6);
    expect(y).toBeCloseTo(TILE_SIZE / 2, 6);
  });

  it('agrees with the reference slippy formula for a known point', () => {
    // Peckham at zoom 15. Checked against the OSM wiki's own lat/lon-to-tile formula, which uses
    // asinh(tan(lat)) where this file uses the log form of the same identity.
    const { x, y } = project(51.4739, -0.0686, 15);

    expect(Math.floor(x / TILE_SIZE)).toBe(16377);
    expect(Math.floor(y / TILE_SIZE)).toBe(10901);
  });

  it('matches asinh(tan(lat)) across a spread of latitudes', () => {
    for (const latitude of [-60, -33.9, 0, 51.5, 55.95, 71]) {
      const zoom = 12;
      const { y } = project(latitude, 0, zoom);
      const reference =
        ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) * TILE_SIZE * 2 ** zoom;

      expect(y).toBeCloseTo(reference, 6);
    }
  });
});
