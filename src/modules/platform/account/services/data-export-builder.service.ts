import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataExportStatus } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { rowDigest } from '@/common';
import { StorageProvider } from '@/modules/platform/media/storage';
import { ResendProvider } from '@/modules/infrastructure/notification/providers';
import { DataExportService } from './data-export.service';
import { ZipEntry, jsonEntry, zip } from './zip';

/** §13.7: three tries, then it stays failed and somebody has to look. */
const MAX_ATTEMPTS = 3;

/** How long the emailed link lives (§13.7). The file itself stays for seven days. */
const LINK_HOURS = 24;

/** How many requests one pass builds, so a backlog cannot hold the job open for an hour. */
const BATCH = 5;

/**
 * B16: the job that actually builds a subject access request.
 *
 * `DataExportRequest` rows have been created since the member-facing button existed, and
 * `markReady` had no caller — so every request sat `PENDING` for ever. Under UK GDPR that is worse
 * than not having the button: the member has exercised a right, we have recorded that they did,
 * and nothing happens.
 *
 * **Polled on a schedule rather than queued on BullMQ.** The defect register says "add a
 * `data-exports.build` BullMQ job", and the five-minute poll is the same thing with less
 * machinery: a new queue needs a producer in whichever process took the request, a worker in
 * whichever process can read member data, and a dead-letter policy — where the schedule needs a
 * `@Cron` line and already has a "Run now" button, a run log and a failure count. The cost is that
 * a request waits up to five minutes before it starts, against a statutory month.
 *
 * **The media are a manifest, not the bytes.** §13.7 asks for `media/` with the originals; B16's
 * own fix line says "JSON + media manifest to S3". The manifest is what this writes, and
 * deliberately: the platform's whole upload design is that bytes never pass through the API (0.11),
 * and streaming a member's photo library back through it to build a two-gigabyte archive would
 * undo that for the one feature that needs it least. Every file is listed with a signed URL valid
 * for the same 24 hours as the archive, so the member can download every byte they uploaded — and
 * the "split exports over 2 GB into parts" requirement stops existing, because the archive is
 * kilobytes.
 */
@Injectable()
export class DataExportBuilderService {
  private readonly logger = new Logger(DataExportBuilderService.name);
  private readonly appUrl: string;

  constructor(
    private readonly database: PrismaService,
    private readonly storage: StorageProvider,
    private readonly exports: DataExportService,
    private readonly resend: ResendProvider,
    config: ConfigService,
  ) {
    this.appUrl = (config.get<string>('CLIENT_URL') ?? '').replace(/\/$/, '');
  }

  /**
   * One pass: the oldest pending requests, built in order.
   *
   * Returns a summary for the job log, or null when there was nothing to do — the convention every
   * other job in `PlatformJobsService` follows, so a quiet platform does not write a log line every
   * five minutes.
   */
  async buildPending(): Promise<string | null> {
    const pending = await this.database.dataExportRequest.findMany({
      where: { status: DataExportStatus.PENDING, attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { requestedAt: 'asc' },
      take: BATCH,
      select: { id: true, userId: true, attempts: true },
    });

    if (!pending.length) return null;

    let built = 0;
    let failed = 0;

    for (const request of pending) {
      // Claimed before the work, conditional on the attempt count it was read with. Two
      // instances run this schedule, and without the claim both would build the same export and
      // email two links to the same member.
      //
      // The count is the claim token rather than a `BUILDING` status, because `DataExportStatus`
      // has no such value and adding one would be a migration of its own — Postgres refuses a new
      // enum value in the transaction that added it, so it would be two — for a state nothing
      // outside this loop would ever read.
      const { count } = await this.database.dataExportRequest.updateMany({
        where: { id: request.id, status: DataExportStatus.PENDING, attempts: request.attempts },
        data: { attempts: { increment: 1 } },
      });

      if (!count) continue;

      try {
        await this.build(request.id, request.userId);
        built += 1;
      } catch (error) {
        failed += 1;
        await this.giveUpOrRetry(request.id, request.attempts + 1, error as Error);
      }
    }

    return `built ${built}, failed ${failed}`;
  }

  /** Builds one export: assemble, archive, store, mark ready, email the member. */
  async build(id: string, userId: string): Promise<void> {
    const entries = await this.assemble(userId);
    const archive = zip(entries);
    // Keyed on the request, not the member: a second export is a second file, and the key of the
    // first must not be guessable from the member's id after its seven days are up.
    const key = `exports/members/${userId}/${id}.zip`;

    await this.storage.put(key, archive, 'application/zip');
    await this.exports.markReady(id, key);

    this.logger.log(`Data export ${id} built (${archive.length} bytes, ${entries.length} files)`);

    await this.notify(userId, key);
    await this.note(userId, id, 'member.data_export_ready', {
      bytes: archive.length,
      files: entries.length,
    });
  }

  /**
   * The documents §13.7 names.
   *
   * Everything here is read with an explicit `select`. Not for performance — for the exclusion
   * list: internal notes, risk scores, reviewer identities and staff-only fields must not be in a
   * member's own export, and a `select` is the only way to be sure of that. `include` on a
   * relation would carry whatever anybody adds to that model next year straight into the archive.
   */
  private async assemble(userId: string): Promise<ZipEntry[]> {
    const [profile, content, messages, connections, commerce, reports, enforcement, settings] =
      await Promise.all([
        this.profile(userId),
        this.content(userId),
        this.messages(userId),
        this.connections(userId),
        this.commerce(userId),
        this.reportsFiled(userId),
        this.enforcement(userId),
        this.settings(userId),
      ]);

    return [
      jsonEntry('profile.json', profile),
      jsonEntry('content.json', content),
      jsonEntry('messages.json', messages),
      jsonEntry('connections.json', connections),
      jsonEntry('bookings_orders_deals.json', commerce),
      jsonEntry('reports_filed.json', reports),
      jsonEntry('enforcement.json', enforcement),
      jsonEntry('consents_settings.json', settings),
      jsonEntry('media/manifest.json', await this.media(userId)),
      {
        name: 'README.txt',
        body: Buffer.from(README, 'utf8'),
      },
    ];
  }

  private async profile(userId: string) {
    const user = await this.database.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        email: true,
        status: true,
        signupMethod: true,
        createdAt: true,
        lastActiveAt: true,
        lastPlatform: true,
        lastAppVersion: true,
        profile: {
          select: {
            gender: true,
            cityId: true,
            countryOfOriginCode: true,
            dateOfBirth: true,
            interests: true,
            languages: true,
            heritageTag: true,
            journeyStage: true,
            phoneNumberDiallingCode: true,
            phoneNumber: true,
            headline: true,
            bio: true,
            canHelpWith: true,
            openInbox: true,
            onboardingCompleted: true,
            createdAt: true,
          },
        },
        trustChecks: { select: { check: true, status: true, verifiedAt: true } },
        userAuth: { select: { emailVerifiedAt: true, lastLoginAt: true } },
      },
    });

    return { exportedAt: new Date().toISOString(), ...user };
  }

  /**
   * Everything they authored, removed items included and marked (§13.7).
   *
   * **No visibility filtering anywhere in here, deliberately.** Every other read of these tables
   * hides held, limited and removed content, because every other read is somebody else looking.
   * This one is the author asking for their own data under UK GDPR, and a subject access request
   * that quietly left out the post we took down would be the one thing they most wanted to see.
   * So the rows come out whatever state they are in, and `deletedAt` marks the ones that were
   * removed — which is what §13.7 means by "incl. removed items, marked".
   *
   * Each query carries a `visibility:` marker of its own: the coverage test in
   * `content-visibility-coverage.spec.ts` asks every content read to say what it does about this,
   * and a comment nine lines above the first of eleven queries would not be saying it about the
   * other ten.
   */
  private async content(userId: string) {
    const removable = { select: { deletedAt: true } };
    const [
      requests,
      responses,
      offers,
      updates,
      guides,
      groups,
      groupPosts,
      groupReplies,
      connect,
      reviews,
      listing,
    ] = await Promise.all([
      // visibility: not filtered — their own requests, held and removed ones included. See above.
      this.database.communityRequest.findMany({
        where: { authorId: userId },
        select: { id: true, title: true, description: true, createdAt: true, ...removable.select },
      }),
      // visibility: not filtered — their own replies and help offers. See above.
      this.database.requestResponse.findMany({
        where: { authorId: userId },
        select: {
          id: true,
          requestId: true,
          content: true,
          isHelpOffer: true,
          createdAt: true,
          deletedAt: true,
        },
      }),
      // visibility: not filtered — their own offers. See above.
      this.database.communityOffer.findMany({
        where: { authorId: userId },
        select: { id: true, title: true, description: true, createdAt: true, deletedAt: true },
      }),
      // visibility: not filtered — their own posts, anonymous ones included. See above.
      this.database.communityUpdate.findMany({
        where: { authorId: userId },
        select: { id: true, content: true, visibility: true, createdAt: true, deletedAt: true },
      }),
      // visibility: not filtered — their own guides, drafts included. See above.
      this.database.guide.findMany({
        where: { authorId: userId },
        select: { id: true, title: true, intro: true, createdAt: true, deletedAt: true },
      }),
      // visibility: not filtered — the groups they created. See above.
      this.database.group.findMany({
        where: { createdById: userId },
        select: { id: true, name: true, description: true, createdAt: true, deletedAt: true },
      }),
      // visibility: not filtered — their own group posts. See above.
      this.database.groupPost.findMany({
        where: { authorId: userId },
        select: { id: true, groupId: true, content: true, createdAt: true, deletedAt: true },
      }),
      // visibility: not filtered — their own replies. See above.
      this.database.groupPostReply.findMany({
        where: { authorId: userId },
        select: { id: true, postId: true, content: true, createdAt: true, deletedAt: true },
      }),
      // visibility: not filtered — their own Connect profile, posts and prompt answers. See above.
      this.database.connectProfile.findUnique({
        where: { userId },
        select: {
          id: true,
          typeCode: true,
          lookingFor: true,
          hobbies: true,
          occupation: true,
          createdAt: true,
          posts: { select: { id: true, kind: true, caption: true, postedAt: true } },
          prompts: { select: { code: true, answer: true, createdAt: true } },
        },
      }),
      // visibility: not filtered — reviews they wrote, not ones written about them. See above.
      this.database.review.findMany({
        where: { reviewerId: userId },
        select: {
          id: true,
          subjectUserId: true,
          context: true,
          rating: true,
          comment: true,
          createdAt: true,
          deletedAt: true,
        },
      }),
      // visibility: not filtered — their own listing, whatever state it is in. See above.
      this.database.professionalListing.findUnique({
        where: { userId },
        select: { id: true, professionTitle: true, about: true, createdAt: true },
      }),
    ]);

    return {
      note: 'A `deletedAt` that is not null means the item was removed — by you or by Circl.',
      requests,
      responses,
      offers,
      updates,
      guides,
      groups,
      groupPosts,
      groupReplies,
      connect,
      reviewsWritten: reviews,
      professionalListing: listing,
    };
  }

  /**
   * The messages **they sent** (§13.7).
   *
   * Other people's messages are excluded, which is the whole reason this is a separate document
   * rather than a thread export: a conversation is two people's data, and a subject access request
   * is one person's. The conversation id is included so the member can see which exchange a
   * message belonged to without the other half of it.
   */
  private async messages(userId: string) {
    const messages = await this.database.message.findMany({
      where: { senderId: userId },
      select: {
        id: true,
        conversationId: true,
        kind: true,
        body: true,
        sentAt: true,
        deletedAt: true,
      },
      orderBy: { sentAt: 'asc' },
    });

    return {
      note: 'Only messages you sent. Messages other people sent you are their data, not yours.',
      messages,
    };
  }

  private async connections(userId: string) {
    const [sent, received, blocks, threads, invites] = await Promise.all([
      this.database.connectionRequest.findMany({
        where: { fromUserId: userId },
        select: { id: true, toUserId: true, note: true, state: true, createdAt: true },
      }),
      this.database.connectionRequest.findMany({
        where: { toUserId: userId },
        // Their note is included: they wrote it **to** this member, so it is addressed to them.
        select: { id: true, fromUserId: true, note: true, state: true, createdAt: true },
      }),
      this.database.block.findMany({
        where: { blockerId: userId },
        select: { blockedId: true, createdAt: true },
      }),
      this.database.conversationParticipant.findMany({
        where: { userId },
        select: { conversationId: true, role: true, joinedAt: true, leftAt: true },
      }),
      this.database.groupMembership.findMany({
        where: { userId },
        select: { groupId: true, state: true, isAdmin: true, joinedAt: true },
      }),
    ]);

    return {
      note: 'Who you asked to connect with, who asked you, and the threads and groups you are in.',
      connectionRequestsSent: sent,
      connectionRequestsReceived: received,
      blocksYouMade: blocks,
      conversations: threads,
      groupMemberships: invites,
    };
  }

  private async commerce(userId: string) {
    const [bookingsAsClient, bookingsAsPro, enquiriesAsBuyer, enquiriesAsSeller, deals, managed] =
      await Promise.all([
        this.database.booking.findMany({
          where: { clientId: userId },
          select: { id: true, listingId: true, state: true, preferredDate: true, createdAt: true },
        }),
        this.database.booking.findMany({
          where: { professionalId: userId },
          select: { id: true, clientId: true, state: true, preferredDate: true, createdAt: true },
        }),
        this.database.enquiry.findMany({
          where: { buyerId: userId },
          select: { id: true, reference: true, storeId: true, state: true, createdAt: true },
        }),
        this.database.enquiry.findMany({
          where: { sellerId: userId },
          select: { id: true, reference: true, buyerId: true, state: true, createdAt: true },
        }),
        this.database.deal.findMany({
          where: { OR: [{ payerId: userId }, { providerId: userId }] },
          select: {
            id: true,
            payerId: true,
            providerId: true,
            amount: true,
            currency: true,
            summary: true,
            createdAt: true,
          },
        }),
        this.database.managedRequest.findMany({
          where: { userId },
          select: { id: true, subjectType: true, state: true, notes: true, createdAt: true },
        }),
      ]);

    return {
      bookingsAsClient,
      bookingsAsProfessional: bookingsAsPro,
      enquiriesAsBuyer,
      enquiriesAsSeller,
      deals,
      managedRequests: managed,
    };
  }

  /** Reports they made. Never reports about them — those are somebody else's words (§13.7). */
  private async reportsFiled(userId: string) {
    const reports = await this.database.report.findMany({
      where: { reporterId: userId },
      select: {
        id: true,
        targetType: true,
        reasonCode: true,
        note: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      note: 'Reports you filed. Reports other people filed about you are their words, not your data.',
      reports,
    };
  }

  /**
   * Their strikes, suspensions and appeals, "with reasons as shown to them" (§13.7).
   *
   * No `issuedById`, `revokedById`, `reviewerId` or `originalDeciderId` anywhere: reviewer
   * identities are excluded, and a member who knows which member of staff struck them has
   * something to take it out on.
   */
  private async enforcement(userId: string) {
    const [strikes, suspensions, appeals] = await Promise.all([
      this.database.strike.findMany({
        where: { userId },
        select: {
          id: true,
          reasonCode: true,
          policySubtype: true,
          note: true,
          issuedAt: true,
          expiresAt: true,
          revokedAt: true,
        },
      }),
      this.database.suspension.findMany({
        where: { userId },
        select: {
          id: true,
          reasonCode: true,
          policySubtype: true,
          note: true,
          startsAt: true,
          endsAt: true,
          liftedAt: true,
        },
      }),
      this.database.appeal.findMany({
        where: { userId },
        select: {
          id: true,
          subjectType: true,
          statement: true,
          state: true,
          decisionNote: true,
          createdAt: true,
          decidedAt: true,
        },
      }),
    ]);

    return { strikes, suspensions, appeals };
  }

  private async settings(userId: string) {
    const [preferences, profile] = await Promise.all([
      this.database.notificationPreference.findMany({
        where: { userId },
        select: { categoryCode: true, push: true, email: true },
      }),
      this.database.userProfile.findUnique({
        where: { userId },
        select: { openInbox: true, bioVisibilityState: true },
      }),
    ]);

    return { notificationPreferences: preferences, privacy: profile };
  }

  /**
   * Every file they uploaded, with a link (§13.7, B16).
   *
   * `scanStatus` and the moderation columns are left out: what a scanner thought of a photo is a
   * staff-only field, and a member reading "FLAGGED" beside their own picture in a data export is
   * being told something nobody decided to tell them.
   */
  private async media(userId: string) {
    const media = await this.database.media.findMany({
      where: { uploadedById: userId },
      select: {
        id: true,
        storageKey: true,
        mimeType: true,
        byteSize: true,
        purpose: true,
        fileName: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      note:
        'Each link is valid for 24 hours from when this export was built. The files themselves ' +
        'are not inside this archive — download them with the links below.',
      count: media.length,
      files: media.map(file => ({
        ...file,
        downloadUrl: this.storage.downloadUrl(file.storageKey, {
          expiresInSeconds: LINK_HOURS * 3600,
          // The name the member uploaded it under, where we kept one. A browser saving twelve
          // files called `a1b2c3.jpg` is a download nobody can make sense of.
          filename: file.fileName ?? `${file.id}`,
        }),
      })),
    };
  }

  /**
   * Returns the request to `PENDING` for another try, or gives up after three (§13.7).
   *
   * The attempt was counted when the row was claimed, so a process that dies mid-build still
   * counts — otherwise an export that kills the process would be retried for ever by design.
   */
  private async giveUpOrRetry(id: string, attempts: number, error: Error): Promise<void> {
    const done = attempts >= MAX_ATTEMPTS;

    this.logger.error(
      `Data export ${id} failed on attempt ${attempts}${done ? ' (giving up)' : ''}: ${error.message}`,
      error.stack,
    );

    const row = await this.database.dataExportRequest.update({
      where: { id },
      data: done
        ? { status: DataExportStatus.FAILED, failedAt: new Date() }
        : { status: DataExportStatus.PENDING },
      select: { userId: true },
    });

    if (done) {
      await this.note(row.userId, id, 'member.data_export_failed', {
        attempts,
        message: error.message.slice(0, 500),
      });
    }
  }

  /**
   * The emailed link, to the member's **verified** address and nowhere else (§13.7).
   *
   * Unverified means we do not know that address is theirs, and an export is their whole account
   * in one file — so a request from an account whose email was never confirmed is built and held
   * rather than sent, and `GET account/data-export` still reports it ready.
   *
   * Plain text through the provider, like the staff notices in `AdminMailService`: this is a
   * one-time link rather than a product message, and the member template registry is built around
   * events with a verification code in them. If this should be branded, it is one template away.
   */
  private async notify(userId: string, key: string): Promise<void> {
    const user = await this.database.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true, userAuth: { select: { emailVerifiedAt: true } } },
    });

    if (!user?.email || !user.userAuth?.emailVerifiedAt) {
      this.logger.warn(`Data export for ${userId} built but not emailed: address not verified`);

      return;
    }

    const link = this.storage.downloadUrl(key, {
      expiresInSeconds: LINK_HOURS * 3600,
      filename: 'circl-data-export.zip',
    });
    const text = [
      `Hi ${user.firstName},`,
      ``,
      `The copy of your Circl data is ready. This link works for ${LINK_HOURS} hours:`,
      link,
      ``,
      `Inside you will find your profile, everything you have posted, the messages you have sent,`,
      `your bookings and deals, and a list of every file you have uploaded with its own link.`,
      ``,
      `If you did not ask for this, tell us${this.appUrl ? ` at ${this.appUrl}` : ''} straight away.`,
    ].join('\n');

    try {
      await this.resend.send({
        to: user.email,
        template: {
          name: 'member-data-export',
          subject: 'Your Circl data is ready to download',
          text,
          html: `<pre style="font: 14px/1.5 -apple-system, sans-serif; white-space: pre-wrap">${text}</pre>`,
        },
      });
    } catch (error) {
      // The export is built and `latest` reports it ready, so a failed email is a nuisance rather
      // than a lost right. Failing the build here would roll back a finished archive.
      this.logger.error(`Data export email failed for ${userId}: ${(error as Error).message}`);
    }
  }

  /**
   * The two audit entries §13.7 asks for, written directly.
   *
   * `AuditService` lives in the admin module and member-facing code must not import it — that is
   * the boundary the whole surface split rests on. So this writes the row, with `actorId: null`,
   * which is also what the spec asks for: nobody triggered it, a schedule did.
   *
   * The digest comes from `@/common` for exactly that reason (S11.3): the trail is append-only, so
   * a row's hash has to be written with it, and an entry written on this side of the boundary must
   * not be the one entry verification cannot name. `prevHash` stays null — reading the chain's tip
   * is admin-side work — and an unanchored row is still sealed and still digested.
   */
  private async note(
    userId: string,
    requestId: string,
    action: 'member.data_export_ready' | 'member.data_export_failed',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      const entry = {
        id: randomUUID(),
        occurredAt: new Date(),
        action,
        // MEMBERS, as `audit-actions.ts` registers both of these. Spelled rather than imported,
        // for the boundary above.
        area: 'MEMBERS' as const,
        actorId: null,
        targetType: 'MEMBER',
        targetId: userId,
        metadata: { requestId, ...metadata },
      };

      await this.database.auditLog.create({
        data: { ...entry, hash: rowDigest(entry) },
      });
    } catch (error) {
      this.logger.warn(`Audit entry ${action} not written: ${(error as Error).message}`);
    }
  }
}

const README = `Your Circl data
===============

profile.json                 who you are, as we hold it
content.json                 everything you have posted, removed items included and marked
messages.json                the messages you sent (not the ones other people sent you)
connections.json             connection requests, blocks, threads and groups
bookings_orders_deals.json   bookings, enquiries, deals and managed requests
reports_filed.json           reports you made
enforcement.json             strikes, suspensions and appeals, with the reasons you were given
consents_settings.json       your notification and privacy settings
media/manifest.json          every file you uploaded, each with a download link

Some things are deliberately not here: notes Circl staff have written about you, what our
scanners thought of your content, and the names of the people who reviewed it. The first two are
our records rather than your data, and the third is somebody else's.

The links in media/manifest.json last 24 hours from when this export was built. Ask for a new
export if they have expired.
`;
