import { ReportTargetType } from '@prisma/client';

/**
 * Where each scannable kind lives, and what of it is scanned (§6.1).
 *
 * One table for two jobs: mirroring `visibility_state` onto the content row, and reading the text
 * back when the classifier runs in a worker a second later.
 *
 * The worker re-reads rather than being handed the text in its job, which is deliberate. A job
 * payload lives in Redis until the job is cleaned up, and a failed job is kept on purpose — so
 * passing the content along would leave members' words sitting in a queue, with a different
 * retention and a different blast radius from the table they were written to. Re-reading costs one
 * primary-key lookup.
 */
export interface ContentSource {
  table: string;
  /** The scanned fields, named as a reviewer should see them. */
  toFields: (row: Record<string, unknown>) => Record<string, string | null>;
  /**
   * The visibility column, where it is not the usual one.
   *
   * `UserProfile` is the exception §4.5 makes: the written part of a profile is held with
   * `bio_visibility_state`, because holding the row would hide the member rather than the
   * paragraph.
   */
  column?: string;
  /**
   * The `media.owner_type` values under which this target's images are attached (§6.1 scans
   * images, and the classifier takes them alongside the text).
   *
   * The owner id is the target's own id, which is how `MediaService.attach` stamps them. Several
   * values where a target has more than one slot: a shop's logo and cover are two owner types on
   * the same row, as are a listing's photo and its cover.
   */
  mediaOwners?: string[];
  /** A target that *is* an image, whose key is on the row itself rather than in `media`. */
  ownKey?: string;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A guide's steps are stored as a JSON block list; each one is scanned as its own field. */
const guideFields = (row: Record<string, unknown>): Record<string, string | null> => {
  const blocks = Array.isArray(row.blocks) ? row.blocks : [];

  return {
    title: text(row.title),
    intro: text(row.intro),
    ...Object.fromEntries(
      blocks.map((block, index) => [
        `step ${index + 1}`,
        text((block as { text?: unknown })?.text),
      ]),
    ),
  };
};

/** The reply a review's subject is allowed to leave, which is published copy like the review. */
const reviewReply = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;

  const comment = (value as { comment?: unknown }).comment;

  return typeof comment === 'string' ? comment : null;
};

export const CONTENT_SOURCE: Partial<Record<ReportTargetType, ContentSource>> = {
  [ReportTargetType.REQUEST]: {
    mediaOwners: ['COMMUNITY_REQUEST'],
    table: 'community_requests',
    toFields: row => ({ title: text(row.title), description: text(row.description) }),
  },
  [ReportTargetType.RESPONSE]: {
    table: 'request_responses',
    toFields: row => ({ content: text(row.content) }),
  },
  [ReportTargetType.OFFER]: {
    mediaOwners: ['COMMUNITY_OFFER'],
    table: 'community_offers',
    toFields: row => ({ title: text(row.title), description: text(row.description) }),
  },
  [ReportTargetType.UPDATE]: {
    mediaOwners: ['COMMUNITY_UPDATE'],
    table: 'community_updates',
    toFields: row => ({ content: text(row.content) }),
  },
  [ReportTargetType.UPDATE_REPLY]: {
    table: 'update_replies',
    toFields: row => ({ content: text(row.content) }),
  },
  [ReportTargetType.GUIDE]: {
    table: 'guides',
    mediaOwners: ['GUIDE'],
    toFields: guideFields,
  },
  [ReportTargetType.GROUP]: {
    mediaOwners: ['GROUP_AVATAR'],
    table: 'groups',
    toFields: row => ({
      name: text(row.name),
      description: text(row.description),
      ...Object.fromEntries(
        (Array.isArray(row.rules) ? row.rules : []).map((rule, index) => [
          `rule ${index + 1}`,
          text(rule),
        ]),
      ),
    }),
  },
  [ReportTargetType.GROUP_POST]: {
    mediaOwners: ['GROUP_POST'],
    table: 'group_posts',
    toFields: row => ({ content: text(row.content) }),
  },
  [ReportTargetType.GROUP_POST_REPLY]: {
    table: 'group_post_replies',
    toFields: row => ({ content: text(row.content) }),
  },
  [ReportTargetType.CONNECT_PROFILE]: {
    // No images of its own: a Connect profile's photos *are* its posts, each of which is scanned
    // as its own target. (`CONNECT_POSTER` looks like it belongs here and does not -- it is a
    // video's poster frame, attached to the post.)
    table: 'connect_profiles',
    toFields: row => ({ lookingFor: text(row.looking_for) }),
  },
  [ReportTargetType.CONNECT_POST]: {
    // The photos, plus the poster frame of a video — which is the only frame of it the classifier
    // can look at, since it fetches still images.
    mediaOwners: ['CONNECT_POST', 'CONNECT_POSTER'],
    table: 'connect_posts',
    toFields: row => ({ caption: text(row.caption) }),
  },
  [ReportTargetType.CONNECT_STORY]: {
    mediaOwners: ['CONNECT_STORY'],
    table: 'connect_stories',
    toFields: row => ({ caption: text(row.caption) }),
  },
  [ReportTargetType.PROFESSIONAL_LISTING]: {
    mediaOwners: ['LISTING_PHOTO', 'LISTING_COVER'],
    table: 'professional_listings',
    toFields: row => ({
      professionTitle: text(row.profession_title),
      about: text(row.about),
    }),
  },
  [ReportTargetType.PROFESSIONAL_SERVICE]: {
    table: 'professional_services',
    toFields: row => ({ name: text(row.name), description: text(row.description) }),
  },
  [ReportTargetType.REVIEW]: {
    table: 'reviews',
    toFields: row => ({ comment: text(row.comment), reply: reviewReply(row.reply) }),
  },
  [ReportTargetType.USER_PROFILE]: {
    table: 'user_profile',
    column: 'bio_visibility_state',
    toFields: row => ({
      headline: text(row.headline),
      bio: text(row.bio),
      canHelpWith: text(row.can_help_with),
    }),
  },
  [ReportTargetType.STORE]: {
    mediaOwners: ['STORE_LOGO', 'STORE_COVER'],
    table: 'stores',
    toFields: row => ({ name: text(row.name), description: text(row.description) }),
  },
  [ReportTargetType.STORE_ITEM]: {
    mediaOwners: ['STORE_ITEM'],
    table: 'store_items',
    toFields: row => ({
      name: text(row.name),
      description: text(row.description),
      options: text(row.options),
    }),
  },
  /**
   * An image with no content of its own to belong to: an avatar (§6.1). Every other photo belongs
   * to a post and is scanned as part of it, so this entry exists only for the ones that do not.
   */
  [ReportTargetType.MEDIA]: {
    table: 'media',
    column: 'moderation_state',
    ownKey: 'storage_key',
    // No text. The verdict comes entirely from the classifier, so an avatar scan concludes
    // nothing at all while the classifier is off: there is nothing a lexicon can read in a JPEG.
    toFields: () => ({}),
  },
};

/**
 * The targets the worker can re-read, which is the only set worth re-queueing (§6.7).
 *
 * Derived from the map rather than listed, so a new scannable kind joins both halves at once. It
 * matters because of what is **not** in the map: a private message is scanned in OBSERVE mode
 * (§6.8) and has no row the worker could re-read, so `finalise` can only record it degraded — and
 * the rescan sweep would then pick the same rows up on every pass, for ever.
 */
export const SCANNABLE_TARGETS = Object.keys(CONTENT_SOURCE) as ReportTargetType[];
