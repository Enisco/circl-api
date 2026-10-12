import { deflateSync } from 'zlib';
import {
  matchesDeclaredType,
  pdfPageCount,
  sniffDocument,
  stripImageMetadata,
  stripJpegMetadata,
  stripPngMetadata,
} from '../document-bytes';

/**
 * Parsers reading attacker-supplied bytes, so the malformed cases matter as much as the good ones:
 * every one of these runs inside a write path, and a parser that walks off the end of a buffer on a
 * truncated upload is a 500 on somebody submitting their qualification.
 */

// ─── builders ────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const chunk = (type: string, data: Buffer): Buffer => {
  const header = Buffer.alloc(8);

  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'latin1');

  // A real CRC is unnecessary: nothing here verifies one, and dropping a chunk never invalidates
  // another's. Zeroes keep the fixtures readable.
  return Buffer.concat([header, data, Buffer.alloc(4)]);
};

const png = (extra: Buffer[] = []): Buffer =>
  Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', Buffer.alloc(13)),
    ...extra,
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);

const segment = (marker: number, body: Buffer): Buffer => {
  const header = Buffer.alloc(4);

  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(body.length + 2, 2);

  return Buffer.concat([header, body]);
};

const jpeg = (extra: Buffer[] = []): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...extra,
    segment(0xc0, Buffer.alloc(15)), // SOF0, image data proper
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]), // SOS
    Buffer.from([0x12, 0x34, 0xff, 0xd9]), // scan bytes, then EOI
  ]);

/** The APP1 block a phone writes, with something that reads like a GPS tag in it. */
const exif = () =>
  segment(
    0xe1,
    Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('GPSLatitude 51.5074 N')]),
  );

// ─── sniffing ────────────────────────────────────────────────────────────────

describe('sniffDocument', () => {
  it('recognises the three types', () => {
    expect(sniffDocument(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffDocument(png())).toBe('image/png');
    expect(sniffDocument(jpeg())).toBe('image/jpeg');
  });

  it('is null for anything else', () => {
    expect(sniffDocument(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffDocument(Buffer.from('<!doctype html>'))).toBeNull();
    expect(sniffDocument(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull(); // a zip
  });

  it('does not read past the end of a short buffer', () => {
    expect(sniffDocument(Buffer.alloc(0))).toBeNull();
    expect(sniffDocument(Buffer.from([0xff]))).toBeNull();
    expect(sniffDocument(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffDocument(Buffer.from('%PD'))).toBeNull();
  });

  it('refuses a file whose bytes disagree with what was declared', () => {
    // The case this exists for: a PDF declared as an image would be stored and then handed to a
    // reviewer with `Content-Type: image/png`, and whatever the browser did with it next would be
    // the platform's problem.
    expect(matchesDeclaredType(Buffer.from('%PDF-1.4'), 'image/png')).toBe(false);
    expect(matchesDeclaredType(png(), 'image/png')).toBe(true);
    expect(matchesDeclaredType(Buffer.from('MZ\x90\x00'), 'application/pdf')).toBe(false);
  });
});

// ─── JPEG ────────────────────────────────────────────────────────────────────

describe('stripJpegMetadata', () => {
  it('removes the EXIF block, GPS and all', () => {
    const withExif = jpeg([exif()]);

    expect(withExif.includes('GPSLatitude')).toBe(true);

    const stripped = stripJpegMetadata(withExif);

    expect(stripped.includes('GPSLatitude')).toBe(false);
    expect(stripped.length).toBeLessThan(withExif.length);
  });

  it('removes every APPn and the comment segment', () => {
    const noisy = jpeg([
      segment(0xe0, Buffer.from('JFIF\0')),
      exif(),
      segment(0xe2, Buffer.from('ICC_PROFILE here')),
      segment(0xed, Buffer.from('Photoshop IPTC')),
      segment(0xfe, Buffer.from('a comment nobody asked for')),
    ]);
    const stripped = stripJpegMetadata(noisy);

    expect(stripped.includes('ICC_PROFILE')).toBe(false);
    expect(stripped.includes('Photoshop')).toBe(false);
    expect(stripped.includes('a comment nobody asked for')).toBe(false);
  });

  it('keeps the image itself: the frame header, the scan and the end marker', () => {
    const stripped = stripJpegMetadata(jpeg([exif()]));

    // SOF0 survives...
    expect(stripped.includes(Buffer.from([0xff, 0xc0]))).toBe(true);
    // ...as does the scan and its data, byte for byte.
    expect(stripped.includes(Buffer.from([0xff, 0xda]))).toBe(true);
    expect(stripped.subarray(-4).equals(Buffer.from([0x12, 0x34, 0xff, 0xd9]))).toBe(true);
  });

  it('does not corrupt scan data that happens to contain marker-like bytes', () => {
    // Entropy-coded data can hold any byte sequence. A stripper that searched for `FF E1` instead
    // of walking the chain would cut a hole in the middle of the image.
    const scan = Buffer.from([0xff, 0x00, 0xff, 0xe1, 0x00, 0x10, 0xaa, 0xbb, 0xff, 0xd9]);
    const file = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      exif(),
      Buffer.from([0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]),
      scan,
    ]);
    const stripped = stripJpegMetadata(file);

    expect(stripped.includes(scan)).toBe(true);
  });

  it('leaves anything it cannot parse confidently exactly as it was', () => {
    // Truncating a file somebody needs reviewed is worse than keeping its metadata.
    const truncated = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe1, 0x40, 0x00]),
    ]);

    expect(stripJpegMetadata(truncated).equals(truncated)).toBe(true);

    const notJpeg = Buffer.from('just some text, honestly');

    expect(stripJpegMetadata(notJpeg).equals(notJpeg)).toBe(true);
    expect(stripJpegMetadata(Buffer.alloc(0)).length).toBe(0);
  });

  it('tolerates fill bytes before a marker', () => {
    const padded = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xff, 0xff, 0xe1, 0x00, 0x08, 1, 2, 3, 4, 5, 6]),
      Buffer.from([0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]),
      Buffer.from([0xaa, 0xff, 0xd9]),
    ]);

    expect(stripJpegMetadata(padded).length).toBeLessThanOrEqual(padded.length);
  });
});

// ─── PNG ─────────────────────────────────────────────────────────────────────

describe('stripPngMetadata', () => {
  it('removes eXIf and the text chunks', () => {
    const noisy = png([
      chunk('eXIf', Buffer.from('GPS 51.5074')),
      chunk('tEXt', Buffer.from('Author\0Somebody')),
      chunk('iTXt', Buffer.from('Comment\0\0\0\0scanned at home')),
      chunk('tIME', Buffer.alloc(7)),
    ]);

    expect(noisy.includes('GPS 51.5074')).toBe(true);

    const stripped = stripPngMetadata(noisy);

    expect(stripped.includes('GPS 51.5074')).toBe(false);
    expect(stripped.includes('Somebody')).toBe(false);
    expect(stripped.includes('scanned at home')).toBe(false);
  });

  it('keeps the header, the image data and IEND', () => {
    const stripped = stripPngMetadata(png([chunk('eXIf', Buffer.from('x'))]));

    expect(stripped.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(stripped.includes('IHDR')).toBe(true);
    expect(stripped.includes('IDAT')).toBe(true);
    expect(stripped.subarray(-8).includes('IEND')).toBe(true);
  });

  it('leaves a malformed or truncated file alone', () => {
    const lying = Buffer.concat([PNG_SIGNATURE, chunk('IHDR', Buffer.alloc(13))]);
    const truncated = lying.subarray(0, lying.length - 6);

    expect(stripPngMetadata(truncated).equals(truncated)).toBe(true);

    // A chunk whose declared length runs past the end of the buffer.
    const overlong = Buffer.concat([
      PNG_SIGNATURE,
      Buffer.from([0xff, 0xff, 0xff, 0x00]),
      Buffer.from('eXIf'),
    ]);

    expect(stripPngMetadata(overlong).equals(overlong)).toBe(true);
    expect(stripPngMetadata(Buffer.from('not a png')).toString()).toBe('not a png');
  });
});

describe('stripImageMetadata', () => {
  it('dispatches on the bytes, not on anything it was told', () => {
    expect(stripImageMetadata(jpeg([exif()])).includes('GPSLatitude')).toBe(false);
    expect(stripImageMetadata(png([chunk('eXIf', Buffer.from('GPS'))])).includes('GPS')).toBe(
      false,
    );
    // A PDF is left exactly as it is: there is nothing here that understands its structure.
    const pdf = Buffer.from('%PDF-1.7\n/Type /Pages /Count 2\nendobj');

    expect(stripImageMetadata(pdf).equals(pdf)).toBe(true);
  });
});

// ─── PDF page count ──────────────────────────────────────────────────────────

describe('pdfPageCount', () => {
  it('reads the page tree root', () => {
    const pdf = Buffer.from(
      '%PDF-1.7\n3 0 obj\n<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>\nendobj\n',
    );

    expect(pdfPageCount(pdf)).toBe(2);
  });

  it('takes the total from the root rather than a subtree', () => {
    const pdf = Buffer.from(
      '%PDF-1.7\n' +
        '2 0 obj\n<< /Type /Pages /Count 9 /Kids [3 0 R] >>\nendobj\n' +
        '3 0 obj\n<< /Type /Pages /Count 4 /Parent 2 0 R >>\nendobj\n',
    );

    // A reviewer who sees "4 pages" on a nine-page document does not look for the other five.
    expect(pdfPageCount(pdf)).toBe(9);
  });

  it('reads the two keys in either order', () => {
    expect(pdfPageCount(Buffer.from('1 0 obj\n<< /Count 3 /Type /Pages >>\nendobj'))).toBe(3);
  });

  it('is null rather than wrong when it cannot tell', () => {
    // No page tree at all.
    expect(pdfPageCount(Buffer.from('%PDF-1.7\nnothing useful here\n'))).toBeNull();
    // A `/Count` that belongs to something else entirely.
    expect(pdfPageCount(Buffer.from('1 0 obj\n<< /Type /Font /Count 7 >>\nendobj'))).toBeNull();
    // Nonsense values.
    expect(pdfPageCount(Buffer.from('<< /Type /Pages /Count 0 >>'))).toBeNull();
    expect(pdfPageCount(Buffer.from('<< /Type /Pages /Count 999999999 >>'))).toBeNull();
    expect(pdfPageCount(Buffer.alloc(0))).toBeNull();
  });

  it('does not throw on binary rubbish', () => {
    expect(() => pdfPageCount(Buffer.alloc(4096, 0xff))).not.toThrow();
  });
});
