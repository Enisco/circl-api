import { videoMetadata, videoMetadataFromTail } from '../video-metadata';

const box = (type: string, payload: Buffer): Buffer => {
  const header = Buffer.alloc(8);

  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'ascii');

  return Buffer.concat([header, payload]);
};

/** `mvhd` version 0: the duration and the timescale that turns it into seconds. */
const mvhd = (timescale: number, duration: number): Buffer => {
  const payload = Buffer.alloc(100);

  payload.writeUInt8(0, 0);
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);

  return box('mvhd', payload);
};

/**
 * `tkhd` version 0: 84 bytes of payload — 4 of version and flags, 20 of times and ids, 8 reserved,
 * 8 of layer, group and volume, 36 of transform matrix — then the dimensions as 16.16 fixed point.
 */
const tkhd = (width: number, height: number): Buffer => {
  const payload = Buffer.alloc(84);

  payload.writeUInt8(0, 0);
  payload.writeUInt32BE(width * 65536, payload.length - 8);
  payload.writeUInt32BE(height * 65536, payload.length - 4);

  return box('tkhd', payload);
};

const soundTrack = () => box('trak', tkhd(0, 0));
const videoTrack = (width: number, height: number) => box('trak', tkhd(width, height));

const moov = (parts: Buffer[]) => box('moov', Buffer.concat(parts));
const ftyp = () => box('ftyp', Buffer.from('isomiso2avc1mp41', 'ascii'));
const mdat = (bytes: number) => box('mdat', Buffer.alloc(bytes));

describe('videoMetadata', () => {
  it('reads size and duration when the header is at the front', () => {
    const file = Buffer.concat([
      ftyp(),
      moov([mvhd(600, 9_000), videoTrack(1920, 1080)]),
      mdat(64),
    ]);
    const { metadata, needsTail } = videoMetadata(file);

    expect(metadata).toEqual({ width: 1920, height: 1080, durationMs: 15_000 });
    expect(needsTail).toBe(false);
  });

  it('skips the sound track, whose dimensions are zero', () => {
    const file = Buffer.concat([
      ftyp(),
      moov([mvhd(1_000, 5_000), soundTrack(), videoTrack(1280, 720)]),
    ]);

    expect(videoMetadata(file).metadata).toMatchObject({ width: 1280, height: 720 });
  });

  it('asks for the tail when the header is at the end, which is what a phone writes', () => {
    // A recorder cannot know the duration until it stops, so it writes the media first and the
    // header last. A reader that only looks at the front finds nothing on exactly these files.
    const head = Buffer.concat([ftyp(), mdat(4_096)]);
    const { metadata, needsTail } = videoMetadata(head);

    expect(needsTail).toBe(true);
    expect(metadata).toEqual({ width: null, height: null, durationMs: null });
  });

  it('and then reads it out of a tail slice that starts mid-box', () => {
    const tail = Buffer.concat([
      Buffer.alloc(37, 0x11),
      moov([mvhd(30_000, 90_000), videoTrack(3840, 2160)]),
    ]);

    expect(videoMetadataFromTail(tail)).toEqual({ width: 3840, height: 2160, durationMs: 3_000 });
  });

  it('handles a 64-bit box length without misreading the payload', () => {
    const inner = Buffer.concat([mvhd(600, 1_200), videoTrack(640, 480)]);
    const large = Buffer.alloc(16);

    large.writeUInt32BE(1, 0);
    large.write('moov', 4, 'ascii');
    large.writeUInt32BE(inner.length + 16, 12);

    const file = Buffer.concat([ftyp(), large, inner]);

    expect(videoMetadata(file).metadata).toMatchObject({ width: 640, height: 480 });
  });

  it('gives up quietly on something that is not a video at all', () => {
    const { metadata, needsTail } = videoMetadata(Buffer.from('nothing to see here'));

    expect(metadata).toEqual({ width: null, height: null, durationMs: null });
    expect(needsTail).toBe(false);
  });

  it('does not divide by a zero timescale', () => {
    const file = Buffer.concat([ftyp(), moov([mvhd(0, 9_000), videoTrack(320, 240)])]);

    expect(videoMetadata(file).metadata.durationMs).toBeNull();
  });
});
