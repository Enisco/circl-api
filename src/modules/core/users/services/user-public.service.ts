import { Injectable } from '@nestjs/common';
import { TaxonomyKind, ThreadKind, TrustCheckStatus } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';
import {
  authorSelect,
  MediaService,
  TaxonomyService,
  toAuthorView,
  toTermView,
} from '@/modules/platform';
import { ConversationFactoryService } from '@/modules/platform/messaging/services/conversation-factory.service';

/** A member's public community profile (0.16.3). */
@Injectable()
export class UserPublicService {
  constructor(
    private readonly database: PrismaService,
    private readonly media: MediaService,
    private readonly taxonomy: TaxonomyService,
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
    const countryLabels = await this.taxonomy.labels(TaxonomyKind.COUNTRY_OF_ORIGIN);

    return {
      data: {
        user: toAuthorView(user, { sign: this.media.sign }),
        username: user.username,
        bio: user.profile?.bio ?? null,
        canHelpWith: splitHelpWith(user.profile?.canHelpWith),
        countryOfOrigin: toTermView(user.profile?.countryOfOrigin, countryLabels),
        // The same numbers as GET /reviews/{userId} (2.5.1), summarised.
        rating: {
          average: user.reputationSummary?.average ?? 0,
          count: user.reputationSummary?.countedTotal ?? 0,
        },
        // Swaps the sticky bar between "Message" and "Request to chat".
        isOpenToMessages: user.profile?.openInbox ?? true,
        memberSince: user.createdAt.toISOString(),
        viewer: {
          isOwner,
          // Non-null when a thread already exists, so Message reopens it rather than starting a second one (5.0).
          conversationId: isOwner ? null : await this.existingThread(viewerId, subjectId),
        },
      },
    };
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
