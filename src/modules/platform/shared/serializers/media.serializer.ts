import { Media, MediaType } from '@prisma/client';

/**
 * A media object on a resource (spec 0.11).
 *
 * `width` and `height` let the client reserve the right space before the image
 * loads, which is the difference between a feed that settles and one that jumps.
 */
export interface MediaView {
  id: string;
  type: MediaType;
  url: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  blurHash: string | null;
  durationMs?: number;
  waveform?: number[];
  byteSize?: number;
}

export const toMediaView = (media: Media): MediaView => {
  const view: MediaView = {
    id: media.id,
    type: media.type,
    url: media.url,
    thumbnailUrl: media.thumbnailUrl,
    width: media.width,
    height: media.height,
    blurHash: media.blurHash,
  };

  // Audio carries what only the recording device knows (5.5). Sent only for the
  // kind that has it, rather than as nulls on every image in a feed.
  if (media.type === MediaType.AUDIO) {
    view.durationMs = media.durationMs ?? 0;
    view.waveform = Array.isArray(media.waveform) ? (media.waveform as number[]) : [];
    view.byteSize = media.byteSize;
  }

  return view;
};

export const toMediaViews = (media: Media[] | undefined): MediaView[] =>
  (media ?? []).sort((a, b) => a.position - b.position).map(toMediaView);
