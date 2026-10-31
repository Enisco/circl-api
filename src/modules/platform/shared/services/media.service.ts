import { Injectable } from '@nestjs/common';
import {
  Media,
  MediaPurpose,
  MediaRole,
  MediaScanStatus,
  MediaStatus,
  MediaType,
  Prisma,
  ReportTargetType,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/infrastructure';
import { MediaDerivationService } from '../../media/derivation/media-derivation.service';
import { ApiErrorCode, ApiException } from '@/common';
import { StorageProvider } from '../../media/storage/storage.interface';
import { UrlSigner } from '../serializers/media.serializer';

/**
 * The video a **shop or a professional** attaches, which is a stricter rule than a Connect post's
 * (v2 §9.2).
 *
 * `maxVideoBytes` is published in `limits` as fifty megabytes, and a served limit the server does
 * not hold is worse than no limit at all: the form refuses at fifty and the API quietly takes
 * ninety, so the two disagree about what the product's rule is. The number is theirs — "somebody
 * will upload a four-minute 4K clip from a phone, and the shopper on 3G is who pays for it" — and
 * fifty megabytes is also what makes sixty seconds enforceable in practice, since a minute of
 * phone video is tens of megabytes and four minutes of 4K is hundreds.
 *
 * Connect keeps the looser cap it shipped with: a story is watched once by people who chose to
 * open it, not loaded into a product grid.
 */
export const MAX_SELLING_VIDEO_BYTES = 50 * 1024 * 1024;

/** The purposes that cap at {@link MAX_SELLING_VIDEO_BYTES}: a product page and a service page. */
const SELLING_PURPOSES: MediaPurpose[] = [MediaPurpose.COMMERCE, MediaPurpose.PROFESSIONAL];

/** Sixty seconds, as published. Checked where the duration is known — see `validate`. */
export const MAX_SELLING_VIDEO_MS = 60_000;

/**
 * One entry of a media set, as a client may send it (v2 §9.1).
 *
 * `key` is a fresh upload. `id` is a file **already attached to this record**, which is what makes
 * the array the whole set rather than a list of additions: without it a member who has three
 * photographs and adds a fourth can only name the one they just picked, and the server has to read
 * that either as "these four" or as "this one, and lose the three" — the second of which is what it
 * used to do.
 */
export interface MediaSetEntry {
  key?: string;
  id?: string;
  role?: MediaRole;
  posterKey?: string;
}

/**
 * One entry of a flat `photoKeys`-style list, which carries no role and no poster.
 *
 * A uuid is the id of a file already here and anything else is a storage key: the two cannot be
 * confused, since a storage key is a path (`circl/commerce/…/…jpg`). This is what the app believed
 * `photoKeys` already did, and now it does.
 */
export const mediaSetEntry = (value: string): MediaSetEntry =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? { id: value }
    : { key: value };

/** A resolved set: the rows in render order, their roles, and the posters arriving with them. */
export interface ResolvedMediaSet {
  files: Media[];
  roles: Map<string, MediaRole>;
  posters: Map<string, Media>;
}

export interface MediaRules {
  maxImages: number;
  allowVideo: boolean;
  allowAudio: boolean;
  /**
   * How many videos, where more than one is allowed. Defaults to one, which is what every caller
   * before Professionals v2 wanted.
   */
  maxVideos?: number;
  /**
   * Whether photos and video may be attached together.
   *
   * Off by default, because 0.11's post rule is one or the other — a feed card renders a gallery
   * or a player, not both. A service's page and a product's page are built to show both (v2 §5,
   * §9), so they say so rather than inheriting a rule written for a different screen.
   */
  allowMixed?: boolean;
  /**
   * A ceiling on **everything together**, where the published limit is a total.
   *
   * `maxImages` and `maxVideos` are independent caps, so a rule of "ten images, three videos" is
   * thirteen files — and §3.5 publishes `maxServiceMedia: 10` as images and videos *together*. A
   * served limit the server does not actually hold is worse than no limit: the form enforces ten
   * and the API quietly takes thirteen, so the two disagree about what the product's rule is.
   */
  maxTotal?: number;
  /**
   * How long a video may be, where the duration is **already known**.
   *
   * Read off the row rather than measured here: the derivation reads an object's header after it is
   * attached (0.11.4), so a clip uploaded moments ago has `durationMs: null` and nothing to check
   * against. That is why the byte ceiling is the enforcing rule and this is the second net — it
   * catches a file uploaded earlier, measured by the sweep, and attached now. Published as
   * `maxVideoSeconds`, and the form is expected to refuse before any of this.
   */
  maxDurationMs?: number;
  /**
   * The code a limit refusal carries, where the caller's contract names one.
   *
   * The platform has sent `MEDIA_LIMIT_EXCEEDED` since 0.11 and the community and Connect clients
   * branch on it, so it stays the default. Professionals v2 asked for `MEDIA_LIMIT_REACHED` on the
   * two surfaces it introduced (§8) — "we branch on these" — and a code the client switches on
   * that the server never sends is a generic error message on a screen that could have said
   * "that is one video too many".
   */
  limitCode?: ApiErrorCode;
}

/** The default post rules from 0.11: 5 images or 1 video, never both. */
export const POST_MEDIA_RULES: MediaRules = { maxImages: 5, allowVideo: true, allowAudio: false };

/**
 * A service's page, which shows the work and the people who had it done (v2 §5, §3.5).
 *
 * Ten files, of which at most three may be video, and photos and video together — because the
 * page is built to show "there are four photographs and a client talking about it", which is a
 * different promise from either on its own.
 */
export const SERVICE_MEDIA_RULES: MediaRules = {
  maxImages: 10,
  allowVideo: true,
  allowAudio: false,
  maxVideos: 3,
  allowMixed: true,
  // Ten **together**, which is the number served as `maxServiceMedia`.
  maxTotal: 10,
  maxDurationMs: MAX_SELLING_VIDEO_MS,
  limitCode: ApiErrorCode.MEDIA_LIMIT_REACHED,
};

/**
 * A product's page: the existing photo limit, plus the three videos v2 §9 asks for.
 *
 * Five images, deliberately unchanged. §9 asks for video and says to leave `photos` as it is, and
 * the new `mediaKeys` shape is a different spelling of the same allowance rather than a quiet
 * doubling of it — a seller who could post five photographs yesterday can post five today, and
 * three videos besides.
 */
export const ITEM_MEDIA_RULES: MediaRules = {
  maxImages: 5,
  allowVideo: true,
  allowAudio: false,
  maxVideos: 3,
  allowMixed: true,
  maxDurationMs: MAX_SELLING_VIDEO_MS,
  limitCode: ApiErrorCode.MEDIA_LIMIT_REACHED,
};

/** One still image. Avatars, store logos, group photos (0.16.2, 4.1.2, 1.7.3). */
export const SINGLE_IMAGE_RULES: MediaRules = {
  maxImages: 1,
  allowVideo: false,
  allowAudio: false,
};

/** `Media.ownerType` for an avatar, so replacing one releases the last. */
export const AVATAR_MEDIA_OWNER = 'USER_AVATAR';

export const IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  // The same container under its other registered name, which some Android cameras send. A member
  // whose phone labels the file `image/heif` is holding the same bytes as one whose phone says
  // `image/heic`, and refusing one of them is refusing a camera rather than a format.
  'image/heif',
];
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
export const AUDIO_TYPES = ['audio/m4a', 'audio/mp4', 'audio/aac', 'audio/x-m4a'];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Claims uploaded media for a resource. */
@Injectable()
export class MediaService {
  /** Whether an attach waits for the S3 event handler to mark a key clean (0.11.4). */
  private readonly scanRequired: boolean;

  constructor(
    private readonly database: PrismaService,
    private readonly storage: StorageProvider,
    private readonly derivation: MediaDerivationService,
    config: ConfigService,
  ) {
    this.scanRequired = config.get<string>('MEDIA_SCAN_REQUIRED') === 'true';
  }

  /** Signs a stored key into a URL for a response (0.11.3). */
  readonly sign: UrlSigner = (storageKey: string) => this.storage.readUrl(storageKey);

  static typeFor(mimeType: string): MediaType | null {
    if (IMAGE_TYPES.includes(mimeType)) return MediaType.IMAGE;
    if (VIDEO_TYPES.includes(mimeType)) return MediaType.VIDEO;
    if (AUDIO_TYPES.includes(mimeType)) return MediaType.AUDIO;

    return null;
  }

  /**
   * The ceiling for one file, by type and — for video — by what it is being uploaded *for*.
   *
   * `purpose` is optional so the dozen callers that only know the type keep working; the upload
   * endpoint, which is the one place a byte size is declared before anything is stored, passes it.
   */
  static maxBytesFor(type: MediaType, purpose?: MediaPurpose): number {
    switch (type) {
      case MediaType.VIDEO:
        return purpose && SELLING_PURPOSES.includes(purpose)
          ? MAX_SELLING_VIDEO_BYTES
          : MAX_VIDEO_BYTES;
      case MediaType.AUDIO:
        return MAX_AUDIO_BYTES;
      default:
        return MAX_IMAGE_BYTES;
    }
  }

  /**
   * Validates a set of media ids against the rules and returns them in the order the client sent,
   * which is the order they render in.
   *
   * `alongside` is media that is **already attached** to the record these keys are joining, and it
   * is counted against the limits without being revalidated. Without it a professional adding a
   * fourth photograph to a service that has three is checked as though they were attaching one
   * file, and the tenth could be the fifteenth.
   */
  async validate(
    mediaKeys: string[] | undefined,
    ownerId: string,
    rules: MediaRules = POST_MEDIA_RULES,
    field = 'mediaKeys',
    alongside: Media[] = [],
  ): Promise<Media[]> {
    if (!mediaKeys?.length) return [];

    // The same key twice would be one row for two slots, and the length check below would then
    // report it as *missing* — "Not found:" with nothing after it, which is the least useful
    // refusal this method can produce. Named for what it is instead.
    if (new Set(mediaKeys).size !== mediaKeys.length) {
      const repeated = [
        ...new Set(mediaKeys.filter((key, index) => mediaKeys.indexOf(key) !== index)),
      ];

      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'The same file is in this set twice.',
        {
          details: [{ field, message: `Sent more than once: ${repeated.slice(0, 5).join(', ')}` }],
          data: { repeated },
        },
      );
    }

    // Keyed by storageKey, because the client now sends keys rather than ids (0.11.2).
    const rows = await this.database.media.findMany({
      where: { storageKey: { in: mediaKeys }, uploadedById: ownerId },
    });

    if (rows.length !== mediaKeys.length) {
      // Named, not counted. "One or more could not be found" over a list of six sends the client
      // back to guess-and-retry, which is exactly how the app spent two sessions on this field.
      const found = new Set(rows.map(row => row.storageKey));
      const missing = mediaKeys.filter(key => !found.has(key));

      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_NOT_FOUND,
        'One or more of the attached files could not be found. Please re-upload them.',
        {
          details: [{ field, message: `Not found: ${missing.slice(0, 5).join(', ')}` }],
          data: { missing },
        },
      );
    }

    const alreadyUsed = rows.find(row => row.ownerId !== null);

    if (alreadyUsed) {
      // Uploads start when a photo is picked rather than on submit, so a member can attach a key, abandon the composer, and reach the same key again later.
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_ALREADY_ATTACHED,
        'One of these files is already attached to another post.',
        { details: [{ field, message: 'This file is already attached to another post.' }] },
      );
    }

    // A key that has not finished scanning is not attachable (0.11.4).
    if (this.scanRequired) {
      const unscanned = rows.filter(row => row.scanStatus !== MediaScanStatus.CLEAN);

      if (unscanned.length) {
        const infected = unscanned.find(row => row.scanStatus === MediaScanStatus.INFECTED);

        if (infected) {
          throw ApiException.unprocessable(
            ApiErrorCode.MEDIA_TYPE_NOT_ALLOWED,
            'That file could not be accepted.',
            { details: [{ field, message: 'This file could not be accepted.' }] },
          );
        }

        throw ApiException.unprocessable(
          ApiErrorCode.MEDIA_NOT_READY,
          'Your upload is still being processed. Try again in a moment.',
          { details: [{ field, message: 'Still processing.' }] },
        );
      }
    }

    // The whole set as it will stand once this write lands: what is already here, plus what is
    // arriving. `rows` alone counts an edit as though the record were empty.
    const whole = [...alongside, ...rows];
    const images = whole.filter(row => row.type === MediaType.IMAGE);
    const videos = whole.filter(row => row.type === MediaType.VIDEO);
    const audio = whole.filter(row => row.type === MediaType.AUDIO);

    // Images and video together is not allowed, unless the caller's own rules say otherwise.
    if (!rules.allowMixed && images.length && videos.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_MIXED_TYPES,
        'Attach photos or a video, not both.',
        { details: [{ field, message: 'Attach photos or a video, not both.' }] },
      );
    }

    if (images.length > rules.maxImages) {
      throw ApiException.unprocessable(
        rules.limitCode ?? ApiErrorCode.MEDIA_LIMIT_EXCEEDED,
        `You can attach up to ${rules.maxImages} photos.`,
        { details: [{ field, message: `You can attach up to ${rules.maxImages} photos.` }] },
      );
    }

    const maxVideos = rules.allowVideo ? (rules.maxVideos ?? 1) : 0;

    if (videos.length > maxVideos) {
      const limit =
        maxVideos === 0
          ? 'Video is not supported here.'
          : `You can attach ${maxVideos === 1 ? 'one video' : `up to ${maxVideos} videos`}.`;

      throw ApiException.unprocessable(
        rules.limitCode ?? ApiErrorCode.MEDIA_LIMIT_EXCEEDED,
        limit,
        {
          details: [{ field, message: limit }],
        },
      );
    }

    /**
     * A clip the sweep has already measured and found too long.
     *
     * `durationMs === null` is "not measured yet" and is left alone rather than refused: refusing
     * it would refuse every video in the seconds between upload and derivation, which is every
     * video a member attaches straight after choosing it.
     */
    if (rules.maxDurationMs !== undefined) {
      const tooLong = videos.find(
        row => row.durationMs !== null && row.durationMs > rules.maxDurationMs!,
      );

      if (tooLong) {
        const seconds = Math.round(rules.maxDurationMs / 1000);
        const message = `A video can be up to ${seconds} seconds.`;

        throw ApiException.unprocessable(
          rules.limitCode ?? ApiErrorCode.MEDIA_LIMIT_EXCEEDED,
          message,
          {
            details: [{ field, message }],
            data: { maxDurationMs: rules.maxDurationMs, durationMs: tooLong.durationMs },
          },
        );
      }
    }

    if (rules.maxTotal !== undefined && whole.length > rules.maxTotal) {
      const message = `You can attach up to ${rules.maxTotal} photos and videos in total.`;

      throw ApiException.unprocessable(
        rules.limitCode ?? ApiErrorCode.MEDIA_LIMIT_EXCEEDED,
        message,
        {
          details: [{ field, message }],
        },
      );
    }

    if (audio.length > (rules.allowAudio ? 1 : 0)) {
      throw ApiException.unprocessable(
        ApiErrorCode.MEDIA_LIMIT_EXCEEDED,
        rules.allowAudio ? 'You can attach one voice note.' : 'Audio is not supported here.',
        { details: [{ field, message: 'You can attach one voice note.' }] },
      );
    }

    const order = new Map(mediaKeys.map((key, index) => [key, index]));

    return rows.sort((a, b) => (order.get(a.storageKey) ?? 0) - (order.get(b.storageKey) ?? 0));
  }

  /**
   * A whole media set, from the two kinds of entry a client can send: `{key}` for a file it has
   * just uploaded and `{id}` for one this record already holds.
   *
   * The ids are looked up **against this record only**. A member cannot name somebody else's photo,
   * or one of their own attached to a different service, and have it move: an id that is not on
   * this record is as unfound as an id that never existed.
   *
   * On a create there is nothing to reference yet, so an id there is a client bug and is refused
   * by name rather than treated as a missing file.
   */
  async resolveSet(
    entries: MediaSetEntry[],
    uploaderId: string,
    owner: { type: string; id: string | null },
    rules: MediaRules = POST_MEDIA_RULES,
    field = 'mediaKeys',
  ): Promise<ResolvedMediaSet> {
    if (!entries.length) return { files: [], roles: new Map(), posters: new Map() };

    const blank = entries.findIndex(entry => !entry.id && !entry.key);

    if (blank !== -1) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Each attachment needs either a key, for a new upload, or an id, for one already here.',
        { details: [{ field: `${field}[${blank}]`, message: 'Send key or id.' }] },
      );
    }

    const ids = entries.filter(entry => entry.id).map(entry => entry.id!);

    if (new Set(ids).size !== ids.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'The same file is in this set twice.',
        { details: [{ field, message: 'Each file may appear once.' }] },
      );
    }

    let kept: Media[] = [];

    if (ids.length) {
      if (!owner.id) {
        throw ApiException.unprocessable(
          ApiErrorCode.MEDIA_NOT_FOUND,
          'An id names a file this record already has, and this record is being created. Send the upload keys.',
          { details: [{ field, message: 'Use key on a create.' }], data: { ids } },
        );
      }

      // visibility: media attached to the record the caller has already been allowed to edit.
      kept = await this.database.media.findMany({
        where: { id: { in: ids }, ownerType: owner.type, ownerId: owner.id },
      });

      if (kept.length !== ids.length) {
        const found = new Set(kept.map(row => row.id));
        const missing = ids.filter(id => !found.has(id));

        throw ApiException.unprocessable(
          ApiErrorCode.MEDIA_NOT_FOUND,
          'One or more of the attached files could not be found. Please re-upload them.',
          {
            details: [{ field, message: `Not on this record: ${missing.slice(0, 5).join(', ')}` }],
            data: { missing },
          },
        );
      }
    }

    const keys = entries.filter(entry => !entry.id && entry.key).map(entry => entry.key!);
    const fresh = keys.length ? await this.validate(keys, uploaderId, rules, field, kept) : [];
    const byId = new Map(kept.map(row => [row.id, row]));
    const byKey = new Map(fresh.map(row => [row.storageKey, row]));

    const files = entries.map(entry => (entry.id ? byId.get(entry.id)! : byKey.get(entry.key!)!));
    const roles = new Map(
      files.map((file, index) => [
        file.storageKey,
        // A kept file with no role sent keeps the role it has. Defaulting it to SHOWCASE would
        // quietly demote somebody's advert every time they reordered their photographs.
        entries[index].role ?? (entries[index].id ? file.role : null) ?? MediaRole.SHOWCASE,
      ]),
    );

    return {
      files,
      roles,
      // Keyed by storage key rather than by what the client sent, so a poster can be sent for a
      // video that is already here as well as for one arriving with it.
      posters: await this.posters(
        entries.map((entry, index) => ({
          key: files[index].storageKey,
          posterKey: entry.posterKey,
        })),
        files,
        uploaderId,
        field,
      ),
    };
  }

  /**
   * Makes `files` the whole set attached to this record: what is in it stays or arrives, what is
   * not is deleted.
   *
   * The pair this replaces — release everything, then attach what the client sent — destroyed the
   * rows on every write, which is why a file already here could not be referenced on the next one.
   */
  async syncOwner(
    tx: Prisma.TransactionClient,
    ownerType: string,
    ownerId: string,
    files: Media[],
    roles?: Map<string, MediaRole>,
  ): Promise<void> {
    await this.releaseOwner(
      tx,
      ownerType,
      ownerId,
      files.map(file => file.id),
    );
    await this.attach(tx, files, ownerType, ownerId, roles);
  }

  /**
   * The same for the poster frames, which hang under their own owner type.
   *
   * A poster is kept when the video it is a frame of is kept and no new frame came with it. The
   * release-everything version dropped the poster of a video that stayed, leaving the grey box the
   * poster exists to prevent.
   */
  async syncPosters(
    tx: Prisma.TransactionClient,
    posterOwnerType: string,
    ownerId: string,
    posters: Map<string, Media>,
    files: Media[],
  ): Promise<void> {
    const replaced = new Set(posters.keys());
    const keepKeys = new Set(
      files
        .filter(file => file.thumbnailKey && !replaced.has(file.storageKey))
        .map(file => file.thumbnailKey!),
    );

    const existing = await tx.media.findMany({
      where: { ownerType: posterOwnerType, ownerId },
      select: { id: true, storageKey: true },
    });

    await this.releaseOwner(
      tx,
      posterOwnerType,
      ownerId,
      existing.filter(row => keepKeys.has(row.storageKey)).map(row => row.id),
    );
    await this.attachPosters(tx, posters, posterOwnerType, ownerId, files);
  }

  /** Stamps the owner so the orphan sweeper leaves these alone. */
  async attach(
    tx: Prisma.TransactionClient,
    media: Media[],
    ownerType: string,
    ownerId: string,
    /**
     * What each file is *of*, by storage key (v2 §9.1). Only the owners that ask for a role send
     * it: an avatar has none, and a message attachment is whatever was sent.
     */
    roles?: Map<string, MediaRole>,
  ): Promise<void> {
    if (!media.length) return;

    await Promise.all(
      media.map((item, index) =>
        tx.media.update({
          where: { id: item.id },
          data: {
            ownerType,
            ownerId,
            position: index,
            status: MediaStatus.ATTACHED,
            attachedAt: new Date(),
            expiresAt: null,
            ...(roles ? { role: roles.get(item.storageKey) ?? MediaRole.SHOWCASE } : {}),
          },
        }),
      ),
    );

    // The earliest the bytes are known to be in storage (0.11.4). Fire-and-forget, since a photo
    // must not fail to send over this, and the hourly sweep catches what it misses.
    this.derivation.schedule(media.filter(item => item.derivedAt === null).map(item => item.id));
  }

  /** Everything attached to one resource, in render order. */
  async forOwner(ownerType: string, ownerId: string): Promise<Media[]> {
    return this.database.media.findMany({
      where: { ownerType, ownerId },
      orderBy: { position: 'asc' },
    });
  }

  /** Media for a page of resources, grouped by owner id, in one query. */
  async forOwners(ownerType: string, ownerIds: string[]): Promise<Map<string, Media[]>> {
    const grouped = new Map<string, Media[]>();

    if (!ownerIds.length) return grouped;

    const rows = await this.database.media.findMany({
      where: { ownerType, ownerId: { in: ownerIds } },
      orderBy: { position: 'asc' },
    });

    for (const row of rows) {
      const key = row.ownerId!;

      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }

    return grouped;
  }

  /**
   * The still frame a video is rendered with, kept with the video it belongs to (v2 §9.2).
   *
   * > `thumbnailUrl` is required on a video. A video tile with no poster frame is a grey box.
   *
   * **Nothing here derives a frame from a video** — the platform decodes no video anywhere, which
   * is why Connect has taken a `posterKey` from the client since it shipped (3.2.1). This is the
   * same bargain for a product and a service page: the client sends the frame it is already
   * showing in its own picker, and the server files it against the video so `thumbnailUrl` falls
   * out of the serialiser every other image uses.
   *
   * The poster is attached under its **own owner type** so it is never rendered as a gallery item,
   * and so it is released with the set it belongs to rather than lingering as an orphan.
   */
  async attachPosters(
    tx: Prisma.TransactionClient,
    posters: Map<string, Media>,
    posterOwnerType: string,
    ownerId: string,
    /**
     * The attached files, so the **response** carries the thumbnail too.
     *
     * Passed in and updated in place because a caller that serialises the array it already holds —
     * a product's create does, to avoid a second read — would otherwise answer with
     * `thumbnailUrl: null` while the row in the database has one. The grey box the poster exists
     * to prevent, on the one screen that renders immediately after the write.
     */
    files?: Media[],
  ): Promise<void> {
    if (!posters.size) return;

    await this.attach(tx, [...posters.values()], posterOwnerType, ownerId);

    for (const [videoKey, poster] of posters) {
      await tx.media.updateMany({
        where: { storageKey: videoKey },
        data: { thumbnailKey: poster.storageKey },
      });

      const file = files?.find(row => row.storageKey === videoKey);

      if (file) file.thumbnailKey = poster.storageKey;
    }
  }

  /**
   * Validates the poster frames in a set of media keys, against the videos they claim to be of.
   *
   * A poster on an image is refused rather than ignored: it means the client has paired the two
   * up wrongly, and silently dropping it would show a grey tile and no reason for it.
   */
  async posters(
    keys: Array<{ key: string; posterKey?: string }>,
    files: Media[],
    uploaderId: string,
    field: string,
  ): Promise<Map<string, Media>> {
    const posters = new Map<string, Media>();
    const byKey = new Map(files.map(file => [file.storageKey, file]));

    for (const entry of keys) {
      if (!entry.posterKey) continue;

      const video = byKey.get(entry.key);

      if (!video || video.type !== MediaType.VIDEO) {
        throw ApiException.unprocessable(
          ApiErrorCode.VALIDATION_FAILED,
          'A poster frame belongs to a video.',
          {
            details: [{ field, message: `${entry.key} is not a video, so it takes no poster.` }],
          },
        );
      }

      const [poster] = await this.validate(
        [entry.posterKey],
        uploaderId,
        SINGLE_IMAGE_RULES,
        field,
      );

      posters.set(entry.key, poster);
    }

    return posters;
  }

  /**
   * Detaches and removes media when its owning resource is hard-deleted, or when an edit leaves it
   * out of the set.
   *
   * `exceptIds` is what the edit kept: those rows stay where they are, so a photograph that was
   * here before the edit and is still in the set afterwards is the same row, with the same id, and
   * the client can name it again next time.
   */
  async releaseOwner(
    tx: Prisma.TransactionClient,
    ownerType: string,
    ownerId: string,
    exceptIds: string[] = [],
  ) {
    const where: Prisma.MediaWhereInput = {
      ownerType,
      ownerId,
      ...(exceptIds.length ? { id: { notIn: exceptIds } } : {}),
    };
    const going = await tx.media.findMany({ where, select: { id: true } });

    if (!going.length) return;

    await tx.media.deleteMany({ where: { id: { in: going.map(row => row.id) } } });

    // An image scanned in its own right (§6.1 — today an avatar) keeps its verdict in
    // `content_safety`, which is polymorphic and so has no foreign key to cascade through.
    // Leaving the verdict behind would leave a scan of nothing, which the rescan sweep then
    // re-queues and the worker can never finish.
    await tx.contentSafety.deleteMany({
      where: { targetType: ReportTargetType.MEDIA, targetId: { in: going.map(row => row.id) } },
    });
  }
}
