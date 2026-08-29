import { Injectable, Logger } from '@nestjs/common';
import { JobStage, JobState, Prisma, SystemMessageType, UserAccountStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { CacheService, PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, Util } from '@/common';
import { EventBusService, UserLoginOtpEvent } from '@/modules/infrastructure/events';
import { ConversationFactoryService } from '../../messaging/services/conversation-factory.service';

const CODE_TTL_SECONDS = 600;
const RATE_LIMIT_PER_HOUR = 3;

/** Deliberately not the auth OTP key: the two codes are not interchangeable. */
const codeKey = (userId: string) => `deletion:code:${userId}`;
const attemptsKey = (userId: string) => `deletion:attempts:${userId}`;

/** What replaces a name everywhere the author object appears (0.15.2). */
const TOMBSTONE_NAME = 'Deleted';
const TOMBSTONE_SURNAME = 'account';

/** Account deletion and anonymisation (spec 0.15). */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly cache: CacheService,
    private readonly conversations: ConversationFactoryService,
    private readonly eventBus: EventBusService,
  ) {}

  /** Step 1: send a code to the address on the account. */
  async requestDeletion(userId: string) {
    const user = await this.database.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, firstName: true, isAnonymised: true },
    });

    if (!user) throw ApiException.notFound('That account could not be found.');

    if (user.isAnonymised) {
      throw ApiException.gone(
        ApiErrorCode.ACCOUNT_ALREADY_DELETED,
        'This account has already been deleted.',
      );
    }

    const attempts = (await this.cache.get<number>(attemptsKey(userId))) ?? 0;

    if (attempts >= RATE_LIMIT_PER_HOUR) {
      throw ApiException.rateLimited(
        ApiErrorCode.RATE_LIMITED,
        'Too many attempts. Try again in an hour.',
      );
    }

    const code = Util.generateOtp(6);

    await this.cache.set(codeKey(userId), await Util.generateHash(code), CODE_TTL_SECONDS);
    await this.cache.set(attemptsKey(userId), attempts + 1, 3600);

    // The same OTP mechanics, but a SEPARATE cache key from the login code on purpose: a code a member requested to sign in must not also be able to delete their account.
    this.eventBus.publish(
      new UserLoginOtpEvent(user.email, user.email, user.firstName ?? 'there', code),
    );

    return {
      message: 'We have sent a code to the email address on your account.',
      expiresInSeconds: CODE_TTL_SECONDS,
    };
  }

  /** Step 2: verify the code and anonymise in one transaction. */
  async confirmDeletion(userId: string, code: string) {
    const user = await this.database.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, isAnonymised: true },
    });

    if (!user) throw ApiException.notFound('That account could not be found.');

    if (user.isAnonymised) {
      // 410 rather than a confusing 404: the account existed, and it is gone.
      throw ApiException.gone(
        ApiErrorCode.ACCOUNT_ALREADY_DELETED,
        'This account has already been deleted.',
      );
    }

    const hashed = await this.cache.get<string>(codeKey(userId));
    const valid = hashed ? await Util.validateHash(code, hashed) : false;

    if (!valid) {
      // The attempt counts against the rate limit, so a wrong code is not free.
      const attempts = (await this.cache.get<number>(attemptsKey(userId))) ?? 0;

      await this.cache.set(attemptsKey(userId), attempts + 1, 3600);

      throw ApiException.unprocessable(
        ApiErrorCode.INVALID_CODE,
        'That code is wrong or has expired.',
        { details: [{ field: 'code', message: 'Wrong or expired.' }] },
      );
    }

    await this.anonymise(userId, user.email);
    await this.cache.delete(codeKey(userId), attemptsKey(userId));
  }

  /** The anonymisation itself, field by field (0.15.2). */
  private async anonymise(userId: string, email: string): Promise<void> {
    const now = new Date();
    // One-way, so the same address cannot silently re-register onto the old record and a 410 can be returned rather than a confusing 404.
    const emailHash = createHash('sha256').update(email.toLowerCase()).digest('hex');

    await this.database.$transaction(async tx => {
      await this.closeOpenWork(tx, userId, now);

      // ── Identity: destroyed, not flagged ────────────────────────────────────
      await tx.user.update({
        where: { id: userId },
        data: {
          firstName: TOMBSTONE_NAME,
          lastName: TOMBSTONE_SURNAME,
          username: null,
          profileImageUrl: null,
          email: `deleted+${userId}@circl.invalid`,
          deletedEmailHash: emailHash,
          isAnonymised: true,
          anonymisedAt: now,
          deletedAt: now,
          status: UserAccountStatus.SUSPENDED,
        },
      });

      // Date of birth, gender, country of origin, city, heritage, languages, interests and journey stage all go.
      await tx.userProfile.updateMany({
        where: { userId },
        data: {
          gender: null,
          cityId: null,
          countryOfOrigin: null,
          phoneNumber: null,
          phoneNumberDiallingCode: null,
          bio: null,
          canHelpWith: null,
          dateOfBirth: null,
          dateOfBirthSetAt: null,
          interests: Prisma.DbNull,
          languages: Prisma.DbNull,
          heritageTag: null,
          journeyStage: null,
          openInbox: false,
        },
      });

      // ── Credentials and devices: revoked immediately ─────────────────────── A logged-in second device stops working on its next request.
      await tx.userAuth.updateMany({
        where: { userId },
        data: { password: null, isBlocked: true },
      });
      await tx.userSession.updateMany({
        where: { userId },
        data: { isActive: false, revokedAt: now, refreshToken: null },
      });
      await tx.userSocialAuth.deleteMany({ where: { userId } });
      await tx.userNotificationPrefs.updateMany({
        where: { userId },
        data: { devicePushToken: null },
      });

      // ── Uploads: deleted from storage, not just dereferenced ─────────────── Their avatar, any identity document, and anything reserved but never attached.
      await tx.media.deleteMany({
        where: {
          uploadedById: userId,
          OR: [{ ownerType: null }, { ownerType: { in: ['AVATAR', 'IDENTITY_DOCUMENT'] } }],
        },
      });

      // ── Connect: deleted outright, with every pending request both ways ────
      await tx.connectionRequest.deleteMany({
        where: { OR: [{ fromUserId: userId }, { toUserId: userId }] },
      });
      await tx.connectProfile.deleteMany({ where: { userId } });

      // ── Store and listing: delisted, not deleted ───────────────────────────
      await tx.store.updateMany({
        where: { ownerId: userId },
        data: { status: 'CLOSED', deletedAt: now },
      });
      await tx.storeItem.updateMany({
        where: { store: { ownerId: userId } },
        data: { isAvailable: false },
      });
      await tx.professionalListing.updateMany({
        where: { userId },
        data: { isAcceptingWork: false, deletedAt: now },
      });

      // ── Everything else stays, re-attributed ─────────────────────────────── Posts, guides, comments, replies, reviews they wrote; messages they sent; reviews about them; moderation reports either way.
    });

    this.logger.log(`Anonymised account ${userId}`);
  }

  /** Open work at the moment of deletion (0.15.4). */
  private async closeOpenWork(tx: Prisma.TransactionClient, userId: string, now: Date) {
    const openStates = [
      JobState.PENDING_ACCEPTANCE,
      JobState.ACCEPTED,
      JobState.IN_PROGRESS,
      JobState.DELIVERED,
      JobState.CHANGES_REQUESTED,
    ];

    const bookings = await tx.booking.findMany({
      where: {
        state: { in: openStates },
        OR: [{ clientId: userId }, { professionalId: userId }],
      },
      select: { id: true, conversationId: true },
    });

    for (const booking of bookings) {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          state: JobState.CANCELLED,
          cancelledAt: now,
          cancelReason: 'The other party closed their account.',
          autoCompleteAt: null,
        },
      });
      await tx.bookingEvent.upsert({
        where: { bookingId_stage: { bookingId: booking.id, stage: JobStage.CANCELLED } },
        update: { reachedAt: now },
        create: { bookingId: booking.id, stage: JobStage.CANCELLED, note: 'Account closed' },
      });

      if (booking.conversationId) {
        await this.conversations.postSystemMessage(
          booking.conversationId,
          SystemMessageType.ACCOUNT_DELETED,
          'This booking was cancelled because the other party closed their account.',
          { bookingId: booking.id },
          tx,
        );
      }
    }

    const enquiries = await tx.enquiry.findMany({
      where: {
        state: { in: [JobState.ACCEPTED, JobState.IN_PROGRESS, JobState.DELIVERED] },
        OR: [{ buyerId: userId }, { sellerId: userId }],
      },
      select: { id: true, conversationId: true },
    });

    for (const enquiry of enquiries) {
      await tx.enquiry.update({
        where: { id: enquiry.id },
        data: {
          state: JobState.CANCELLED,
          cancelledAt: now,
          cancelReason: 'The other party closed their account.',
          expiresAt: null,
        },
      });

      if (enquiry.conversationId) {
        await this.conversations.postSystemMessage(
          enquiry.conversationId,
          SystemMessageType.ACCOUNT_DELETED,
          'This order was cancelled because the other party closed their account.',
          { enquiryId: enquiry.id },
          tx,
        );
      }
    }

    // An unresolved community request they posted is closed, and helpers who responded are notified once.
    await tx.communityRequest.updateMany({
      where: { authorId: userId, status: 'OPEN', deletedAt: null },
      data: { status: 'CANCELLED' },
    });

    // An open dispute continues against the anonymised party: Circl keeps the evidence already submitted, and no new evidence can come from this side (0.15.4).
  }

  /** Whether an address belonged to a deleted account, so registration can say so rather than failing confusingly. */
  async isDeletedEmail(email: string): Promise<boolean> {
    const hash = createHash('sha256').update(email.toLowerCase()).digest('hex');
    const existing = await this.database.user.findUnique({
      where: { deletedEmailHash: hash },
      select: { id: true },
    });

    return existing !== null;
  }
}
