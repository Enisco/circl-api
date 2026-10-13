import { deflateRawSync } from 'zlib';

/**
 * A ZIP writer, in sixty lines, because the alternative was a dependency.
 *
 * §13.7 asks for the data export to be one ZIP of named JSON documents. Node has `zlib` and no zip
 * container, so the choice was a third-party archiver or the container format — and the container
 * is a handful of fixed-width headers around already-compressed bytes. A dependency that exists to
 * write eight small files into one archive is a dependency to keep patched forever.
 *
 * Deliberately a Buffer in and a Buffer out, not a stream. The export is JSON and a media
 * manifest — kilobytes, not the member's photos — so the whole archive fits in memory many times
 * over, and a streaming writer would be the complicated version of this for no benefit. If the
 * export ever carries the original files themselves, this is the piece that has to change.
 */
export interface ZipEntry {
  /** The path inside the archive. Forward slashes, no leading slash. */
  name: string;
  body: Buffer;
}

/** The CRC-32 of each entry, which is the one part of a ZIP that is not a header. */
const TABLE = (() => {
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

export const crc32 = (buffer: Buffer): number => {
  let crc = -1;

  for (const byte of buffer) crc = (crc >>> 8) ^ TABLE[(crc ^ byte) & 0xff];

  return (crc ^ -1) >>> 0;
};

/**
 * DOS date and time, which is what a ZIP records.
 *
 * Two-second resolution and a 1980 epoch. Not a limitation worth working around — the archive
 * carries its own `readyAt` in `profile.json`, and this is only what a file browser shows.
 */
const dosStamp = (at: Date): { time: number; date: number } => ({
  time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
  date:
    ((Math.max(at.getFullYear(), 1980) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
});

/** Builds the archive. Entries are stored deflated, in the order given. */
export const zip = (entries: ZipEntry[], at = new Date()): Buffer => {
  const stamp = dosStamp(at);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.body);
    const checksum = crc32(entry.body);

    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    // Bit 11: the name is UTF-8. Without it a non-ASCII name is read in the archive's code page,
    // which for anything a member typed is a different filename than the one written.
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field

    locals.push(local, name, compressed);

    const directory = Buffer.alloc(46);

    directory.writeUInt32LE(0x02014b50, 0); // central directory header
    directory.writeUInt16LE(20, 4); // version made by
    directory.writeUInt16LE(20, 6); // version needed
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(stamp.time, 12);
    directory.writeUInt16LE(stamp.date, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(entry.body.length, 24);
    directory.writeUInt16LE(name.length, 28);
    // Where this entry's local header is. Everything between — the extra, comment, disk and
    // attribute fields at 30 to 42 — stays zero, which `Buffer.alloc` already made it.
    directory.writeUInt32LE(offset, 42);

    central.push(directory, name);

    offset += local.length + name.length + compressed.length;
  }

  const body = Buffer.concat(locals);
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);

  return Buffer.concat([body, directory, end]);
};

/** One JSON document, pretty-printed, because a member is going to open it in a text editor. */
export const jsonEntry = (name: string, value: unknown): ZipEntry => ({
  name,
  body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
});
