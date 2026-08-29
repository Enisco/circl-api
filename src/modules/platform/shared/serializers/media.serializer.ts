import { Media, MediaType } from '@prisma/client';

/** A media object on a resource (spec 0.11.3). */
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

/** Signs a stored key into a URL. */
export type UrlSigner = (storageKey: string) => string;

export const toMediaView = (media: Media, sign: UrlSigner): MediaView => {
  const view: MediaView = {
    id: media.id,
    type: media.type,
    url: sign(media.storageKey),
    // Derived by the S3 event handler (0.11.4), so it is null until that runs.
    thumbnailUrl: media.thumbnailKey ? sign(media.thumbnailKey) : null,
    width: media.width,
    height: media.height,
    blurHash: media.blurHash,
  };

  // Audio carries what only the recording device knows (5.5).
  if (media.type === MediaType.AUDIO) {
    view.durationMs = media.durationMs ?? 0;
    view.waveform = Array.isArray(media.waveform) ? (media.waveform as number[]) : [];
    view.byteSize = media.byteSize;
  }

  return view;
};

export const toMediaViews = (media: Media[] | undefined, sign: UrlSigner): MediaView[] =>
  (media ?? []).sort((a, b) => a.position - b.position).map(item => toMediaView(item, sign));
