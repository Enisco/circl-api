import { Injectable } from '@nestjs/common';
import { ConnectPostKind, MediaType, Prisma, TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import {
  AuthorView,
  BlockingService,
  MediaService,
  TaxonomyService,
  authorSelect,
  toAuthorView,
} from '../../shared';
import { MediaDerivationService } from '../../media/derivation/media-derivation.service';
import {
  CreateConnectPostDto,
  CreateConnectStoryDto,
  ReorderPostsDto,
  UpdateConnectPostDto,
  UpsertPromptsDto,
} from '../dtos/connect.dto';

/** A post's items, and a story's one item, are `Media` rows owned by the row that groups them. */
export const CONNECT_POST_OWNER = 'CONNECT_POST';
export const CONNECT_STORY_OWNER = 'CONNECT_STORY';
/** The frame a video shows before it plays. Attached so the orphan sweep leaves it alone. */
export const CONNECT_POSTER_OWNER = 'CONNECT_POSTER';

/** The three caps, said on the screen rather than discovered in a refusal (3.2.2). */
export const MAX_POSTS = 9;
export const MAX_PHOTOS_PER_POST = 5;
export const MAX_LIVE_STORIES = 10;

/** Sixty seconds, enforced here because the gallery picker cannot promise a length (3.2.2). */
export const MAX_VIDEO_MS = 60_000;

/** A day, stamped by the server: the viewer counts down against it (3.4.1). */
const STORY_TTL_MS = 24 * 60 * 60 * 1000;

export interface ConnectMediaItemView {
  id: string;
  kind: 'PHOTO' | 'VIDEO';
  url: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  position: number;
}

export interface ConnectPostView {
  id: string;
  caption: string | null;
  postedAt: string;
  position: number;
  items: ConnectMediaItemView[];
}

export interface ConnectPromptView {
  code: string;
  question: string;
  answer: string;
}

export interface ConnectStoryItemView extends Omit<ConnectMediaItemView, 'position'> {
  postedAt: string;
  expiresAt: string;
  seen: boolean;
}

export interface ConnectStoryRowView {
  profileId: string;
  user: AuthorView;
  hasUnseen: boolean;
  items: ConnectStoryItemView[];
}

@Injectable()
export class ConnectMediaService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly blocking: BlockingService,
    private readonly derivation: MediaDerivationService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  // ─── 3.2 Posts ─────────────────────────────────────────────────────────────

  /**
   * One call is one post, in the order the keys are given: the grouping is the call, not the
   * upload. Appended at the end, because a gallery is a history and the newest thing is not
   * automatically the thing somebody wants shown first.
   */
  async createPost(profileId: string, userId: string, dto: CreateConnectPostDto) {
    const keys = dto.keys;

    const [posts, items] = await Promise.all([
      this.database.connectPost.count({ where: { profileId, deletedAt: null } }),
      // Looser here than the five-photo rule on purpose: `assertShape` is the authority, so a
      // sixth photo answers `409 CONNECT_POST_LIMIT` with the limit in `data` rather than a
      // generic "too many images". One rule, one place, one refusal worth showing a member.
      this.media.validate(keys, userId, {
        maxImages: 10,
        allowVideo: true,
        allowAudio: false,
      }, 'keys'),
    ]);

    if (posts >= MAX_POSTS) {
      throw ApiException.conflict(
        ApiErrorCode.CONNECT_POST_LIMIT,
        `A profile holds up to ${MAX_POSTS} posts. Remove one to add another.`,
        { data: { limit: MAX_POSTS, posts } },
      );
    }

    if (items.length !== keys.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'One of those uploads could not be used.',
        { details: [{ field: 'keys', message: 'Not all of these are yours and ready.' }] },
      );
    }

    const poster = await this.assertShape(dto, items, userId);

    const post = await this.database.$transaction(async tx => {
      const created = await tx.connectPost.create({
        data: {
          profileId,
          kind: dto.kind,
          caption: dto.caption?.trim() || null,
          // Appended. Renumbered from zero only by the reorder, which owns the whole list.
          position: posts,
        },
      });

      await this.media.attach(tx, items, CONNECT_POST_OWNER, created.id);

      if (poster) {
        await this.media.attach(tx, [poster], CONNECT_POSTER_OWNER, created.id);

        // The poster becomes the video's own thumbnail, so `thumbnailUrl` falls out of the same
        // serialiser every other image uses rather than being a second field to remember.
        await tx.media.update({
          where: { id: items[0].id },
          data: { thumbnailKey: poster.storageKey },
        });
      }

      return created;
    });

    // Awaited rather than scheduled. Everywhere else in the app a missing width is a frame that
    // sizes itself a moment later; here discovery renders these full-bleed, so without the ratio
    // every card jumps as the image decodes — and a post is created once, so this is the one
    // moment it is worth waiting for.
    await this.derivation.deriveMany(items.map(item => item.id));

    return this.postView(post.id);
  }

  /**
   * A post is one thing or the other, never a mix, and a video has to arrive with the frame it
   * shows before it plays. Both are enforced here rather than left to the client: the client picks
   * one or the other before it opens a picker, so this is a backstop, not the rule's only home.
   */
  private async assertShape(
    dto: CreateConnectPostDto,
    items: Array<{ id: string; type: MediaType; durationMs: number | null; storageKey: string }>,
    userId: string,
  ) {
    const videos = items.filter(item => item.type === MediaType.VIDEO);

    if (dto.kind === ConnectPostKind.PHOTO) {
      if (videos.length) {
        throw ApiException.unprocessable(
          ApiErrorCode.CONNECT_POST_LIMIT,
          'A post is photos or a video, never both.',
          { details: [{ field: 'keys', message: 'This post was declared as photos.' }] },
        );
      }

      if (items.length > MAX_PHOTOS_PER_POST) {
        throw ApiException.conflict(
          ApiErrorCode.CONNECT_POST_LIMIT,
          `A post holds up to ${MAX_PHOTOS_PER_POST} photos.`,
          { data: { limit: MAX_PHOTOS_PER_POST } },
        );
      }

      return null;
    }

    if (items.length !== 1 || videos.length !== 1) {
      throw ApiException.unprocessable(
        ApiErrorCode.CONNECT_POST_LIMIT,
        'A video post is exactly one video.',
        { details: [{ field: 'keys', message: 'Send one video key.' }] },
      );
    }

    // The missing field first, before reading bytes out of storage to check a length: refusing a
    // request for something it did not send should not cost a round trip to S3.
    if (!dto.posterKey) {
      throw ApiException.unprocessable(
        ApiErrorCode.CONNECT_POSTER_REQUIRED,
        'A video needs a still frame to show before it plays.',
        {
          details: [
            {
              field: 'posterKey',
              message: 'Upload one frame of the clip and send its key here.',
            },
          ],
        },
      );
    }

    await this.assertDuration(items[0]);

    const [poster] = await this.media.validate(
      [dto.posterKey],
      userId,
      { maxImages: 1, allowVideo: false, allowAudio: false },
      'posterKey',
    );

    if (!poster) {
      throw ApiException.unprocessable(
        ApiErrorCode.CONNECT_POSTER_REQUIRED,
        'That poster could not be used.',
        { details: [{ field: 'posterKey', message: 'Not an image of yours that is ready.' }] },
      );
    }

    return poster;
  }

  /**
   * The cap is the server's, as it has to be: clips are chosen from a gallery rather than
   * recorded in the app, and the picker will not reliably trim what it hands back. A byte limit
   * does not do it either — a short clip at high bitrate passes and a long one at low bitrate
   * does not.
   *
   * The duration is read out of the file's own header. Derivation normally runs just after the
   * upload; this waits for it rather than trusting whatever has landed, because a post made two
   * seconds after the PUT would otherwise skip the check entirely.
   */
  private async assertDuration(item: { id: string; durationMs: number | null }) {
    let durationMs = item.durationMs;

    if (durationMs === null) {
      await this.derivation.deriveMany([item.id]);

      const fresh = await this.database.media.findUnique({
        where: { id: item.id },
        select: { durationMs: true },
      });

      durationMs = fresh?.durationMs ?? null;
    }

    if (durationMs === null) {
      throw ApiException.unprocessable(
        ApiErrorCode.CONNECT_VIDEO_TOO_LONG,
        'We could not read how long that clip is, so we cannot accept it.',
        { details: [{ field: 'keys', message: 'Try a different clip.' }] },
      );
    }

    if (durationMs > MAX_VIDEO_MS) {
      throw ApiException.unprocessable(
        ApiErrorCode.CONNECT_VIDEO_TOO_LONG,
        `A clip can be up to ${MAX_VIDEO_MS / 1000} seconds.`,
        { data: { limitMs: MAX_VIDEO_MS, durationMs } },
      );
    }
  }

  async updatePost(profileId: string, postId: string, dto: UpdateConnectPostDto) {
    await this.requirePost(profileId, postId);

    await this.database.connectPost.update({
      where: { id: postId },
      data: { caption: dto.caption?.trim() || null },
    });

    return this.postView(postId);
  }

  async removePost(profileId: string, postId: string): Promise<void> {
    await this.requirePost(profileId, postId);

    const items = await this.database.media.findMany({
      where: { ownerType: CONNECT_POST_OWNER, ownerId: postId },
      select: { id: true },
    });

    await this.database.$transaction(async tx => {
      await tx.connectPost.update({ where: { id: postId }, data: { deletedAt: new Date() } });
      await this.media.releaseOwner(tx, CONNECT_POST_OWNER, postId);
      await this.media.releaseOwner(tx, CONNECT_POSTER_OWNER, postId);
      await this.detachQuotes(
        tx,
        items.map(item => item.id),
      );
    });
  }

  /** One photo out of a post. Taking the last one takes the post: an empty post is not a post. */
  async removePostItem(profileId: string, postId: string, mediaId: string) {
    await this.requirePost(profileId, postId);

    const items = await this.database.media.findMany({
      where: { ownerType: CONNECT_POST_OWNER, ownerId: postId },
      select: { id: true },
    });

    if (!items.some(item => item.id === mediaId)) {
      throw ApiException.notFound('That photo is not in this post.');
    }

    if (items.length === 1) {
      await this.removePost(profileId, postId);

      return null;
    }

    await this.database.$transaction(async tx => {
      await tx.media.delete({ where: { id: mediaId } });
      await this.detachQuotes(tx, [mediaId]);
    });

    return this.postView(postId);
  }

  /**
   * The whole list in the new order, rejected unless the ids are exactly this profile's set — so a
   * client holding a stale gallery cannot drop a post by omitting it.
   */
  async reorderPosts(profileId: string, dto: ReorderPostsDto) {
    const posts = await this.database.connectPost.findMany({
      where: { profileId, deletedAt: null },
      select: { id: true },
    });

    const mine = new Set(posts.map(post => post.id));
    const sent = new Set(dto.ids);

    if (sent.size !== dto.ids.length || mine.size !== sent.size || dto.ids.some(id => !mine.has(id))) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Send every one of your posts, once each, in the order you want them.',
        { details: [{ field: 'ids', message: `Expected ${mine.size} ids, all your own.` }] },
      );
    }

    await this.database.$transaction(
      dto.ids.map((id, position) =>
        this.database.connectPost.update({ where: { id }, data: { position } }),
      ),
    );

    // Renumbered from zero and sent back: a stale position is how a gallery draws the wrong face
    // first, and the client renders this response rather than re-fetching the profile.
    return this.postsFor([profileId]).then(map => map.get(profileId) ?? []);
  }

  /** Posts for a set of profiles, in one pass, for the profile payload and the discovery grid. */
  async postsFor(profileIds: string[]): Promise<Map<string, ConnectPostView[]>> {
    if (!profileIds.length) return new Map();

    const posts = await this.database.connectPost.findMany({
      where: { profileId: { in: profileIds }, deletedAt: null },
      orderBy: [{ position: 'asc' }, { postedAt: 'asc' }],
    });

    if (!posts.length) return new Map();

    const items = await this.database.media.findMany({
      where: { ownerType: CONNECT_POST_OWNER, ownerId: { in: posts.map(post => post.id) } },
      orderBy: { position: 'asc' },
    });

    const byPost = new Map<string, typeof items>();

    for (const item of items) {
      const list = byPost.get(item.ownerId!) ?? [];

      list.push(item);
      byPost.set(item.ownerId!, list);
    }

    const views = new Map<string, ConnectPostView[]>();

    for (const post of posts) {
      const own = byPost.get(post.id) ?? [];

      // A post with no items is not sent: the grid cannot draw one, and an empty tile reads as a
      // loading failure rather than as nothing.
      if (!own.length) continue;

      const list = views.get(post.profileId) ?? [];

      list.push({
        id: post.id,
        caption: post.caption,
        postedAt: post.postedAt.toISOString(),
        position: post.position,
        items: own.map((item, index) => this.itemView(item, index)),
      });
      views.set(post.profileId, list);
    }

    return views;
  }

  private itemView(
    item: {
      id: string;
      type: MediaType;
      storageKey: string;
      thumbnailKey: string | null;
      width: number | null;
      height: number | null;
      durationMs: number | null;
    },
    position: number,
  ): ConnectMediaItemView {
    return {
      id: item.id,
      kind: item.type === MediaType.VIDEO ? 'VIDEO' : 'PHOTO',
      url: this.media.sign(item.storageKey),
      // Null for a photo until something derives one; always set for a video, because the poster
      // the owner sent is stored as its thumbnail.
      thumbnailUrl: item.thumbnailKey ? this.media.sign(item.thumbnailKey) : null,
      width: item.width,
      height: item.height,
      durationMs: item.type === MediaType.VIDEO ? item.durationMs : null,
      position,
    };
  }

  private async postView(postId: string): Promise<ConnectPostView> {
    const post = await this.database.connectPost.findUniqueOrThrow({
      where: { id: postId },
      select: { profileId: true },
    });
    const posts = await this.postsFor([post.profileId]);
    const view = (posts.get(post.profileId) ?? []).find(row => row.id === postId);

    if (!view) throw ApiException.notFound('That post could not be found.');

    return view;
  }

  private async requirePost(profileId: string, postId: string) {
    const post = await this.database.connectPost.findUnique({ where: { id: postId } });

    if (!post || post.profileId !== profileId || post.deletedAt) {
      throw ApiException.notFound('That post could not be found.');
    }

    return post;
  }

  // ─── 3.3 Prompts ───────────────────────────────────────────────────────────

  /** The questions, served so they can be reworded without a release. */
  async prompts(): Promise<Array<{ code: string; question: string }>> {
    const terms = await this.taxonomy.list(TaxonomyKind.CONNECT_PROMPT, true);

    return terms.map(term => ({ code: term.code, question: term.label }));
  }

  /**
   * The whole set, replaced rather than patched, which is what keeps the order the owner chose.
   * The question is not stored: it is resolved at write time only to refuse an unknown code, and
   * served from the taxonomy on read so a rewording reaches every profile at once.
   */
  async setPrompts(profileId: string, dto: UpsertPromptsDto) {
    const answers = dto.prompts ?? [];

    await this.taxonomy.assertAllValid(
      TaxonomyKind.CONNECT_PROMPT,
      answers.map(answer => answer.code),
      'prompts',
    );

    const codes = new Set(answers.map(answer => answer.code));

    if (codes.size !== answers.length) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'Answer each question once.',
        { details: [{ field: 'prompts', message: 'The same question appears twice.' }] },
      );
    }

    const before = await this.database.connectPromptAnswer.findMany({
      where: { profileId },
      select: { code: true },
    });
    const dropped = before
      .map(row => row.code)
      .filter(code => !codes.has(code));

    await this.database.$transaction(async tx => {
      await tx.connectPromptAnswer.deleteMany({ where: { profileId } });

      // An answer somebody took down stops being quoted, for the same reason a photo does.
      await this.detachQuotes(tx, dropped);

      if (!answers.length) return;

      await tx.connectPromptAnswer.createMany({
        data: answers.map((answer, position) => ({
          profileId,
          code: answer.code,
          answer: answer.answer.trim(),
          position,
        })),
      });
    });

    return (await this.promptsFor([profileId])).get(profileId) ?? [];
  }

  /**
   * The question travels with the answer. Resolving it from the code at render time means a
   * reworded question silently changes what somebody said, so it is joined here instead.
   */
  async promptsFor(profileIds: string[]): Promise<Map<string, ConnectPromptView[]>> {
    if (!profileIds.length) return new Map();

    const [rows, labels] = await Promise.all([
      this.database.connectPromptAnswer.findMany({
        where: { profileId: { in: profileIds } },
        orderBy: { position: 'asc' },
      }),
      this.taxonomy.labels(TaxonomyKind.CONNECT_PROMPT),
    ]);

    const views = new Map<string, ConnectPromptView[]>();

    for (const row of rows) {
      const question = labels.get(row.code);

      // A code the taxonomy no longer carries has no question to show, and an answer with no
      // question is a sentence with no beginning.
      if (!question) continue;

      const list = views.get(row.profileId) ?? [];

      list.push({ code: row.code, question, answer: row.answer });
      views.set(row.profileId, list);
    }

    return views;
  }

  // ─── 3.4 Stories ───────────────────────────────────────────────────────────

  /**
   * Everybody this caller may see who has a live story, plus the caller's own row — one row per
   * person, including them, because the rail draws a "Your story" tile first and two rows for one
   * member would draw that member twice.
   *
   * Who appears follows discovery exactly: same visibility, same reciprocity gate, same blocks. A
   * story must never reach somebody who could not see the profile.
   */
  async stories(viewerId: string): Promise<ConnectStoryRowView[]> {
    const own = await this.database.connectProfile.findFirst({
      where: { userId: viewerId, deletedAt: null },
      select: { id: true },
    });

    // The reciprocity gate: no profile of your own, nothing to see.
    if (!own) return [];

    const blockedIds = await this.blocking.blockedUserIds(viewerId);
    const now = new Date();

    const stories = await this.database.connectStory.findMany({
      where: {
        deletedAt: null,
        expiresAt: { gt: now },
        profile: {
          deletedAt: null,
          // The caller's own row is the one exception to "visible only": a member who has hidden
          // their profile still has their own story to look at.
          OR: [{ id: own.id }, { isVisible: true }],
          user: blockedIds.length ? { id: { notIn: blockedIds } } : undefined,
        },
      },
      orderBy: { postedAt: 'desc' },
      include: {
        profile: { select: { id: true, user: { select: authorSelect } } },
        seenBy: { where: { userId: viewerId }, select: { userId: true } },
      },
    });

    const items = stories.length
      ? await this.database.media.findMany({
          where: {
            ownerType: CONNECT_STORY_OWNER,
            ownerId: { in: stories.map(story => story.id) },
          },
        })
      : [];

    const mediaByStory = new Map(items.map(item => [item.ownerId!, item] as const));
    const rows = new Map<string, ConnectStoryRowView>();

    for (const story of stories) {
      const media = mediaByStory.get(story.id);

      // Expired items are simply absent, and so is a story whose bytes went away.
      if (!media) continue;

      const row =
        rows.get(story.profileId) ??
        ({
          profileId: story.profileId,
          user: toAuthorView(story.profile.user, { sign: this.media.sign }),
          hasUnseen: false,
          items: [],
        } satisfies ConnectStoryRowView);

      const seen = story.seenBy.length > 0;
      const { position: _position, ...item } = this.itemView(media, 0);

      row.items.push({
        ...item,
        // The story's id, not the media's: it is what `seen` and `DELETE` address, so handing
        // back the media id would give the client an id none of its own endpoints accept.
        id: story.id,
        postedAt: story.postedAt.toISOString(),
        expiresAt: story.expiresAt.toISOString(),
        seen,
      });

      // Ignored on the caller's own row, which the client draws as "Your story" regardless.
      if (!seen && story.profileId !== own.id) row.hasUnseen = true;

      rows.set(story.profileId, row);
    }

    // Within a row, oldest first: a tap-through reads forwards.
    for (const row of rows.values()) {
      row.items.sort((a, b) => a.postedAt.localeCompare(b.postedAt));
    }

    // Unseen first, then newest, which is the order the ring reads in.
    return [...rows.values()].sort((a, b) => {
      if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;

      return (b.items.at(-1)?.postedAt ?? '').localeCompare(a.items.at(-1)?.postedAt ?? '');
    });
  }

  /** Expiry is stamped here. The client never sends it, and never decides it. */
  async createStory(profileId: string, userId: string, dto: CreateConnectStoryDto) {
    const [live, items] = await Promise.all([
      this.database.connectStory.count({
        where: { profileId, deletedAt: null, expiresAt: { gt: new Date() } },
      }),
      this.media.validate([dto.key], userId, {
        maxImages: 1,
        allowVideo: true,
        allowAudio: false,
      }, 'key'),
    ]);

    if (live >= MAX_LIVE_STORIES) {
      throw ApiException.conflict(
        ApiErrorCode.CONNECT_STORY_LIMIT,
        `You can have ${MAX_LIVE_STORIES} stories up at once.`,
        { data: { limit: MAX_LIVE_STORIES, live } },
      );
    }

    const [media] = items;

    if (!media) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'That upload could not be used.',
        { details: [{ field: 'key', message: 'Not an upload of yours that is ready.' }] },
      );
    }

    if (media.type === MediaType.VIDEO) {
      await this.assertDuration(media);

      if (dto.posterKey) {
        const [poster] = await this.media.validate(
          [dto.posterKey],
          userId,
          { maxImages: 1, allowVideo: false, allowAudio: false },
          'posterKey',
        );

        if (poster) {
          await this.database.media.update({
            where: { id: media.id },
            data: { thumbnailKey: poster.storageKey },
          });
        }
      }
    }

    const now = new Date();
    const story = await this.database.$transaction(async tx => {
      const created = await tx.connectStory.create({
        data: {
          profileId,
          userId,
          postedAt: now,
          expiresAt: new Date(now.getTime() + STORY_TTL_MS),
        },
      });

      await this.media.attach(tx, [media], CONNECT_STORY_OWNER, created.id);

      return created;
    });

    await this.derivation.deriveMany([media.id]);

    const fresh = await this.database.media.findUniqueOrThrow({ where: { id: media.id } });
    const { position: _position, ...item } = this.itemView(fresh, 0);

    return {
      ...item,
      // Addressed by the story, as in the list: `seen` and `DELETE` take this id.
      id: story.id,
      postedAt: story.postedAt.toISOString(),
      expiresAt: story.expiresAt.toISOString(),
      seen: false,
    } satisfies ConnectStoryItemView;
  }

  /** Idempotent, one call per item as it is viewed. */
  async markStorySeen(viewerId: string, storyId: string) {
    const story = await this.database.connectStory.findFirst({
      where: { id: storyId, deletedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });

    if (!story) throw ApiException.notFound('That story is no longer there.');

    await this.database.connectStorySeen.upsert({
      where: { storyId_userId: { storyId, userId: viewerId } },
      update: {},
      create: { storyId, userId: viewerId },
    });

    return { id: storyId, seen: true };
  }

  /** The owner taking one down early. It vanishes from every other reader's next load. */
  async removeStory(profileId: string, storyId: string): Promise<void> {
    const story = await this.database.connectStory.findUnique({ where: { id: storyId } });

    if (!story || story.deletedAt) throw ApiException.notFound('That story could not be found.');

    if (story.profileId !== profileId) {
      throw ApiException.forbidden(ApiErrorCode.FORBIDDEN, 'That story is not yours to remove.');
    }

    await this.database.$transaction(async tx => {
      await tx.connectStory.update({ where: { id: storyId }, data: { deletedAt: new Date() } });
      await this.media.releaseOwner(tx, CONNECT_STORY_OWNER, storyId);
    });
  }

  /** Which of these profiles has a live story, for the ring on a discovery card. */
  async hasStoryFor(profileIds: string[]): Promise<Set<string>> {
    if (!profileIds.length) return new Set();

    const rows = await this.database.connectStory.groupBy({
      by: ['profileId'],
      where: {
        profileId: { in: profileIds },
        deletedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    return new Set(rows.map(row => row.profileId));
  }

  /**
   * The same thing as `aboutView`, but with the object key rather than a signed URL — for a
   * conversation snapshot, which outlives any signature.
   */
  async aboutSnapshot(
    profileId: string,
    kind: 'MEDIA' | 'PROMPT',
    id: string,
  ): Promise<{
    kind: 'MEDIA' | 'PROMPT';
    id: string;
    thumbnailKey?: string | null;
    question?: string;
    answer?: string;
  } | null> {
    if (kind === 'PROMPT') {
      const prompts = (await this.promptsFor([profileId])).get(profileId) ?? [];
      const prompt = prompts.find(row => row.code === id);

      return prompt ? { kind, id, question: prompt.question, answer: prompt.answer } : null;
    }

    const media = await this.ownedMedia(profileId, id);

    // The full image where nothing has derived a smaller one: a quote with no picture is the
    // thing `about` exists to prevent.
    return media ? { kind, id, thumbnailKey: media.thumbnailKey ?? media.storageKey } : null;
  }

  /** What `about` points at, for a request row and a thread's context (3.5). */
  async aboutView(
    profileId: string,
    kind: 'MEDIA' | 'PROMPT',
    id: string,
  ): Promise<Record<string, unknown> | null> {
    if (kind === 'PROMPT') {
      const prompts = (await this.promptsFor([profileId])).get(profileId) ?? [];
      const prompt = prompts.find(row => row.code === id);

      return prompt
        ? { kind, id, question: prompt.question, answer: prompt.answer }
        : null;
    }

    const media = await this.ownedMedia(profileId, id);

    if (!media) return null;

    return {
      kind,
      id,
      // The derived thumbnail where one exists — a video's poster always does — and the full
      // image where it does not, because nothing here resizes a photo yet. A tray row with no
      // picture of what prompted it is "somebody wants to connect", which is the thing `about`
      // exists to stop it being, so this never comes back null.
      thumbnailUrl: this.media.sign(media.thumbnailKey ?? media.storageKey),
      url: this.media.sign(media.storageKey),
    };
  }

  /**
   * A removed item stops being quoted. A conversation that started about one photo has that photo
   * in its snapshot, so without this a member could take a picture down and still find it beside
   * every thread it started — the opposite of what removing it means (3.9).
   *
   * One statement rather than a read-time check: the alternative is a query per inbox row to ask
   * whether a photo still exists.
   */
  private async detachQuotes(
    tx: Prisma.TransactionClient,
    aboutIds: string[],
  ): Promise<void> {
    if (!aboutIds.length) return;

    await tx.$executeRaw`
      UPDATE "conversations"
      SET "context_snapshot" = "context_snapshot" - 'about'
      WHERE "context_snapshot" -> 'about' ->> 'id' = ANY(${aboutIds}::text[])`;
  }

  /** The item has to belong to that profile, or `about` is a way to quote somebody else's photo. */
  async ownedMedia(profileId: string, mediaId: string) {
    const posts = await this.database.connectPost.findMany({
      where: { profileId, deletedAt: null },
      select: { id: true },
    });

    if (!posts.length) return null;

    return this.database.media.findFirst({
      where: {
        id: mediaId,
        ownerType: CONNECT_POST_OWNER,
        ownerId: { in: posts.map(post => post.id) },
      },
    });
  }

  /** Whether that profile answers that prompt, for the same reason. */
  async ownsPrompt(profileId: string, code: string): Promise<boolean> {
    const row = await this.database.connectPromptAnswer.findUnique({
      where: { profileId_code: { profileId, code } },
      select: { code: true },
    });

    return row !== null;
  }
}
