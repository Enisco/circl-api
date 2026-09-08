import { imageDimensions } from '../image-dimensions';

/** A real PNG header: signature, then an IHDR chunk carrying the size. */
const png = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(24);

  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);

  return buffer;
};

/** SOI, an APP1 block standing in for EXIF, then a Start Of Frame. */
const jpeg = (width: number, height: number, exifBytes = 0): Buffer => {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  if (exifBytes) {
    const app1 = Buffer.alloc(4 + exifBytes);

    app1.writeUInt16BE(0xffe1, 0);
    app1.writeUInt16BE(exifBytes + 2, 2);
    parts.push(app1);
  }

  const sof = Buffer.alloc(11);

  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);

  return Buffer.concat(parts);
};

const webpLossy = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(30);

  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8 ', 12, 'ascii');
  buffer.writeUInt16LE(width, 26);
  buffer.writeUInt16LE(height, 28);

  return buffer;
};

const heic = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(64);

  buffer.write('ftyp', 4, 'ascii');
  buffer.write('ispe', 32, 'ascii');
  buffer.writeUInt32BE(width, 40);
  buffer.writeUInt32BE(height, 44);

  return buffer;
};

describe('imageDimensions', () => {
  it('reads a PNG from its IHDR', () => {
    expect(imageDimensions('image/png', png(1290, 2796))).toEqual({ width: 1290, height: 2796 });
  });

  it('reads a JPEG from its Start Of Frame', () => {
    expect(imageDimensions('image/jpeg', jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
  });

  it('walks past a large EXIF block to find the frame', () => {
    // The case that breaks a naive reader: a phone photo's EXIF is kilobytes long, and the size
    // it is looking for sits behind all of it.
    expect(imageDimensions('image/jpeg', jpeg(4032, 3024, 8000))).toEqual({
      width: 4032,
      height: 3024,
    });
  });

  it('reads a lossy WebP', () => {
    expect(imageDimensions('image/webp', webpLossy(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it('reads a HEIC, which is what an iPhone uploads by default', () => {
    expect(imageDimensions('image/heic', heic(4032, 3024))).toEqual({ width: 4032, height: 3024 });
  });

  it('falls back to trying every parser when the declared type is wrong', () => {
    // The mime type is the client's word for it, and a client that mislabels a PNG as a JPEG
    // should still get a laid-out image rather than a jumping one.
    expect(imageDimensions('image/jpeg', png(120, 240))).toEqual({ width: 120, height: 240 });
  });

  it('returns null rather than a guess for something unreadable', () => {
    expect(imageDimensions('image/png', Buffer.alloc(24))).toBeNull();
    expect(imageDimensions('image/png', Buffer.from('not an image at all'))).toBeNull();
    expect(imageDimensions('image/png', Buffer.alloc(0))).toBeNull();
  });

  it('rejects an implausible size instead of laying out sixty thousand pixels', () => {
    expect(imageDimensions('image/png', png(0, 100))).toBeNull();
    expect(imageDimensions('image/png', png(70_000, 70_000))).toBeNull();
  });
});
