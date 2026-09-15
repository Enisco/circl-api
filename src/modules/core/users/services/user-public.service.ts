import { Injectable } from '@nestjs/common';
import { ThreadKind, TrustCheckStatus } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import {
  authorSelect,
  BlockingService,
  connectVisibility,
  MediaService,
  TaxonomyService,
  toAuthorView,
  toCountryView,
} from '@/modules/platform/shared';
import { ConversationFactoryService } from '@/modules/platform/messaging/services/conversation-factory.service';

/** A member's public community profile (0.16.3). */
@Injectable()
export class UserPublicService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly taxonomy: TaxonomyService,
    private readonly blocking: BlockingService,
  ) {}

  /** Resolves the `me` alias to the caller. */
  static subjectId(id: string, viewerId: string): string {
    return id === 'me' ? viewerId : id;
  }

  async profile(id: string, viewerId: string) {
    const subjectId = UserPublicService.subjectId(id, viewerId);

    const user = await this.database.user.findUnique({
      where: { id: subjectId },
      select: {
        ...authorSelect,
        createdAt: true,
        isAnonymised: true,
        profile: {
          select: {
            bio: true,
            canHelpWith: true,
            countryOfOrigin: true,
            openInbox: true,
            city: { select: { id: true, name: true, region: true } },
          },
        },
        reputationSummary: { select: { average: true, countedTotal: true } },
        trustChecks: {
          where: { status: TrustCheckStatus.VERIFIED },
          select: { check: true },
        },
      },
    });

    if (!user) throw ApiException.notFound('That member could not be found.');

    // A deleted member's profile route returns 410 rather than 404: the account existed, and "gone" is the honest answer (0.15.3).
    if (user.isAnonymised) {
      throw ApiException.gone(
        ApiErrorCode.ACCOUNT_ALREADY_DELETED,
        'That account has been deleted.',
      );
    }

    const isOwner = subjectId === viewerId;

    return {
      data: {
        user: toAuthorView(user, { sign: this.media.sign }),
        username: user.username,
        bio: user.profile?.bio ?? null,
        canHelpWith: splitHelpWith(user.profile?.canHelpWith),
        countryOfOrigin: toCountryView(user.profile?.countryOfOrigin),
        // The same numbers as GET /reviews/{userId} (2.5.1), summarised.
        rating: {
          average: user.reputationSummary?.average ?? 0,
          count: user.reputationSummary?.countedTotal ?? 0,
        },
        // Swaps the sticky bar between "Message" and "Request to chat".
        isOpenToMessages: user.profile?.openInbox ?? true,
        memberSince: user.createdAt.toISOString(),
        // The member's other corners, so a row of links opens theirs rather than the reader's.
        alsoOn: await this.alsoOn(subjectId, viewerId, isOwner),
        viewer: {
          isOwner,
          // Non-null when a thread already exists, so Message reopens it rather than starting a second one (5.0).
          conversationId: isOwner ? null : await this.existingThread(viewerId, subjectId),
        },
      },
    };
  }

  /**
   * Which other sections this member is in, as ids rather than flags: a boolean says there is
   * something there and leaves the client unable to open it, so the card either hides — and the
   * boolean bought nothing — or goes nowhere.
   *
   * A key is absent when they are not in that section, and absent when the viewer should not be
   * told. Connect is the second case: a member can leave discovery while keeping a profile, so this
   * asks discovery's own question rather than a second one that could drift from it.
   */
  private async alsoOn(
    subjectId: string,
    viewerId: string,
    isOwner: boolean,
  ): Promise<{
    professional?: { id: string; title: string };
    store?: { id: string; name: string };
    connect?: { id: string; type: string };
  }> {
    const [listing, store, connect] = await Promise.all([
      this.database.professionalListing.findFirst({
        where: { userId: subjectId, deletedAt: null, verificationStatus: { not: 'DRAFT' } },
        select: { id: true, professionTitle: true },
      }),
      this.database.store.findFirst({
        where: { ownerId: subjectId, deletedAt: null },
        select: { id: true, name: true },
      }),
      this.database.connectProfile.findUnique({
        where: { userId: subjectId },
        select: { id: true, typeCode: true, isVisible: true, deletedAt: true },
      }),
    ]);

    // Their own profile is theirs to see whether or not they are in discovery: that is ownership,
    // not visibility.
    //
    // The two questions the rule needs about the viewer are asked only when there is something to
    // ask them about. Most members are not on Connect, and this screen is opened from every author
    // link in the feed, so the common case should not pay for a gate with nothing behind it.
    const showConnect = isOwner
      ? connect !== null && connect.deletedAt === null
      : connect !== null &&
        connect.deletedAt === null &&
        (await this.canSeeConnect(viewerId, subjectId, connect));

    return {
      // Both public by their nature and already reachable by search, so no rule beyond existing.
      ...(listing ? { professional: { id: listing.id, title: listing.professionTitle } } : {}),
      ...(store ? { store: { id: store.id, name: store.name } } : {}),
      ...(showConnect && connect ? { connect: { id: connect.id, type: connect.typeCode } } : {}),
    };
  }

  /** Discovery's own question, asked only once the subject turns out to have a profile. */
  private async canSeeConnect(
    viewerId: string,
    subjectId: string,
    target: { isVisible: boolean; deletedAt: Date | null },
  ): Promise<boolean> {
    const [viewerConnect, isBlockedEitherWay] = await Promise.all([
      this.database.connectProfile.findUnique({
        where: { userId: viewerId },
        select: { deletedAt: true },
      }),
      this.blocking.isBlockedEitherWay(viewerId, subjectId),
    ]);

    return (
      connectVisibility({
        viewerHasProfile: viewerConnect !== null && viewerConnect.deletedAt === null,
        target,
        isBlockedEitherWay,
      }) === 'VISIBLE'
    );
  }

  private async existingThread(viewerId: string, subjectId: string): Promise<string | null> {
    const conversation = await this.database.conversation.findFirst({
      where: {
        kind: ThreadKind.DIRECT,
        participantKey: ConversationFactoryService.participantKey([viewerId, subjectId]),
        contextType: null,
      },
      select: { id: true },
    });

    return conversation?.id ?? null;
  }
}

/** `canHelpWith` is stored as free text (0.16.2) and rendered as chips (0.16.3). */
const splitHelpWith = (value: string | null | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
