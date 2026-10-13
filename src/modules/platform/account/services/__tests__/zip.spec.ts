import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inflateRawSync } from 'zlib';
import { crc32, jsonEntry, zip } from '../zip';

/**
 * The archive a data export is delivered as (§13.7, B16).
 *
 * Tested two ways on purpose. The first set reads the container's own bytes, because a ZIP with a
 * field written at the wrong offset is still a Buffer and still uploads cleanly — the failure
 * arrives days later, as a member who cannot open the file we told them was their data. The last
 * test hands the bytes to the system `unzip`, which is the only check that actually answers the
 * question the member asks.
 */
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

describe('data export archive', () => {
  const entries = [
    jsonEntry('profile.json', { firstName: 'Ada', city: 'Manchester' }),
    jsonEntry('media/manifest.json', { count: 0, files: [] }),
    { name: 'README.txt', body: Buffer.from('Your Circl data\n', 'utf8') },
  ];

  it('starts with a local file header and ends with the central directory', () => {
    const archive = zip(entries);

    expect(archive.readUInt32LE(0)).toBe(LOCAL);
    expect(archive.readUInt32LE(archive.length - 22)).toBe(END);
  });

  it('records every entry once in the central directory', () => {
    const archive = zip(entries);
    const end = archive.length - 22;

    expect(archive.readUInt16LE(end + 8)).toBe(entries.length);
    expect(archive.readUInt16LE(end + 10)).toBe(entries.length);

    // And the directory really is where the end record says it is.
    const directoryAt = archive.readUInt32LE(end + 16);

    expect(archive.readUInt32LE(directoryAt)).toBe(CENTRAL);
  });

  it('round-trips each file through the deflate stream it declares', () => {
    const archive = zip([entries[0]]);
    const nameLength = archive.readUInt16LE(26);
    const compressedLength = archive.readUInt32LE(18);
    const body = archive.subarray(30 + nameLength, 30 + nameLength + compressedLength);

    expect(archive.readUInt16LE(8)).toBe(8); // deflate
    expect(inflateRawSync(body).toString('utf8')).toBe(entries[0].body.toString('utf8'));
  });

  it('writes the uncompressed size and checksum of the original, not of the compressed bytes', () => {
    const archive = zip([entries[0]]);

    expect(archive.readUInt32LE(22)).toBe(entries[0].body.length);
    expect(archive.readUInt32LE(14)).toBe(crc32(entries[0].body));
  });

  it('marks names as UTF-8, so a name with an accent in it survives', () => {
    const archive = zip([{ name: 'perfil-ñ.json', body: Buffer.from('{}') }]);
    const nameLength = archive.readUInt16LE(26);

    expect(archive.readUInt16LE(6) & 0x0800).toBe(0x0800);
    expect(archive.subarray(30, 30 + nameLength).toString('utf8')).toBe('perfil-ñ.json');
  });

  it('points each directory entry at the right local header', () => {
    const archive = zip(entries);
    const end = archive.length - 22;
    let at = archive.readUInt32LE(end + 16);

    for (const entry of entries) {
      expect(archive.readUInt32LE(at)).toBe(CENTRAL);

      const offset = archive.readUInt32LE(at + 42);
      const nameLength = archive.readUInt16LE(at + 28);

      // The local header this entry claims is a local header, and it is this entry's.
      expect(archive.readUInt32LE(offset)).toBe(LOCAL);
      expect(archive.subarray(offset + 30, offset + 30 + entry.name.length).toString()).toBe(
        entry.name,
      );

      at += 46 + nameLength;
    }
  });

  it('is empty-safe: an archive of nothing is still a valid archive', () => {
    const archive = zip([]);

    expect(archive.length).toBe(22);
    expect(archive.readUInt32LE(0)).toBe(END);
    expect(archive.readUInt16LE(8)).toBe(0);
  });

  it('pretty-prints the JSON, because somebody is going to open it in a text editor', () => {
    expect(jsonEntry('a.json', { a: 1 }).body.toString('utf8')).toBe('{\n  "a": 1\n}\n');
  });

  /**
   * The test that matters: a real unzip reads it.
   *
   * Every assertion above could pass on an archive no tool accepts — they check the bytes this
   * code wrote against the offsets this code chose. `unzip -t` checks them against the format.
   */
  it('is readable by unzip, with every file intact', () => {
    const archive = zip(entries);
    const directory = mkdtempSync(join(tmpdir(), 'circl-export-'));
    const file = join(directory, 'export.zip');

    writeFileSync(file, archive);

    const tested = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });

    expect(tested).toContain('No errors detected');

    const listed = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' });

    expect(listed.trim().split('\n').sort()).toEqual([
      'README.txt',
      'media/manifest.json',
      'profile.json',
    ]);

    const extracted = execFileSync('unzip', ['-p', file, 'profile.json'], { encoding: 'utf8' });

    expect(JSON.parse(extracted)).toEqual({ firstName: 'Ada', city: 'Manchester' });
  });
});
