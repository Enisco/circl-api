import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { StorageProvider } from '@/modules/platform/shared';
import { AuditChainService } from '../audit/audit-chain.service';
import { AdminAnnouncementService } from '../comms/admin-announcement.service';

/**
 * §13.6: the retention table, as a job.
 *
 * Every row in that table is a promise about how long something is kept, and a promise about
 * deletion that nothing performs is worse than no promise — it is the difference between a
 * retention policy and a filing cabinet. So this is one pass per rule, each counted, with the
 * counts in the run summary §5.22 shows.
 *
 * It lives on the admin surface because almost everything it touches is the portal's own
 * record-keeping, and because a member-only deployment has no business deleting the audit trail.
 *
 * **What it deliberately does not do yet** is as much a part of the policy as what it does:
 *
 *  - **`UserDailyActivity` (25 months)** is supposed to be *rolled into monthly rollups* and then
 *    deleted. There is no monthly rollup table, so deleting those rows would destroy the only
 *    record of monthly actives rather than compress it. It is left alone until the rollup it is
 *    meant to fold into exists — a smaller fault than a dashboard that silently loses two years.
 *  - **Evidence snapshots under legal hold (§13.8)** have no table yet; there is nothing to purge.
 *  - **`InternalNote`** is "life of the subject + 6 years", and almost nothing deletes a subject:
 *    members are anonymised rather than removed, and cases, threads and deals are kept. Two cases
 *    arise and both are handled below — a note about a member row that is genuinely gone, and a
 *    note about a website submission, which is the one subject this job deletes outright.
 */
@Injectable()
export class RetentionPurgeService {
  private readonly logger = new Logger(RetentionPurgeService.name);

  constructor(
    private readonly database: PrismaService,
    private readonly chain: AuditChainService,
    private readonly announcements: AdminAnnouncementService,
    private readonly storage: StorageProvider,
  ) {}

  /** Runs every rule and returns the one-line summary the job history keeps. */
  async run(now = new Date()): Promise<string | null> {
    const counts: string[] = [];
    const add = (what: string, count: number) => {
      if (count) counts.push(`${what} ${count}`);
    };

    const audit = await this.chain.purge(yearsBefore(now, AUDIT_YEARS));

    add('audit entries', audit.rows);
    add('chain segments', audit.segments);

    add('thread access grants', await this.purgeGrants(now));
    add('staff sessions', await this.purgeAdminSessions(now));
    add('staff invites', await this.purgeInvites(now));
    add('announcement deliveries', await this.purgeDeliveries(now));
    add('content scans', await this.purgeScans(now));
    add('risk term hits', await this.purgeTermHits(now));
    add('report snapshots cleared', await this.clearReportSnapshots(now));
    add('orphaned notes', await this.purgeOrphanedNotes(now));
    add('member export files', await this.purgeMemberExportFiles(now));
    add('website submissions', await this.purgeWebsiteSubmissions(now));
    add('website deletion requests', await this.purgeWebsiteDeletionRequests(now));
    add('deletion requests redacted', await this.redactWebsiteDeletionRequests(now));

    const summary = counts.length ? counts.join(', ') : null;

    if (summary) this.logger.log(`retention.purge: ${summary}`);

    return summary;
  }

  /**
   * Thread access grants, kept as long as the trail (§13.6).
   *
   * The same six years on purpose: a grant is the record of a member of staff reading a private
   * conversation, and the audit entry that says they did is useless without the reason the grant
   * carries. Purging one before the other would leave half an answer to "why was this read".
   */
  private async purgeGrants(now: Date): Promise<number> {
    const { count } = await this.database.threadAccessGrant.deleteMany({
      where: { grantedAt: { lte: yearsBefore(now, AUDIT_YEARS) } },
    });

    return count;
  }

  /**
   * Staff sessions, ninety days after they ended.
   *
   * Not while they are live, which is what the two conditions are for: a session is finished when
   * it was revoked or when its twelve hours ran out, and the ninety days run from then. §5.22's
   * list calls this `sessions.cleanup`; it is the same rule and there is no second job, because
   * two jobs deleting from one table on one schedule is a race for no benefit.
   */
  private async purgeAdminSessions(now: Date): Promise<number> {
    const ended = daysBefore(now, 90);
    const { count } = await this.database.adminSession.deleteMany({
      where: { OR: [{ revokedAt: { lte: ended } }, { absoluteExpiresAt: { lte: ended } }] },
    });

    return count;
  }

  /** Invites, a year after they were accepted, revoked or expired — never while one is live. */
  private async purgeInvites(now: Date): Promise<number> {
    const old = yearsBefore(now, 1);
    const { count } = await this.database.adminInvite.deleteMany({
      where: {
        OR: [
          { acceptedAt: { lte: old } },
          { revokedAt: { lte: old } },
          { expiresAt: { lte: old } },
        ],
      },
    });

    return count;
  }

  /**
   * Announcement deliveries, a year on — **after** the figures are written down.
   *
   * One row per member per channel is the biggest table this job touches: a platform-wide
   * announcement writes one per member, and what they are for is answering "was I sent this",
   * which nobody asks a year later.
   *
   * The catch, and the reason this is a loop rather than one `deleteMany`: §13.6 keeps the
   * announcement's **stats** for ever, and the stats endpoint counts these very rows. Deleting
   * them on their own would make a send to forty thousand people report as having reached nobody,
   * the day after this job first ran. So each affected announcement has its figures frozen onto
   * its own row first, while there is still something to count.
   *
   * A row that was never sent is dated by its announcement instead: `sentAt` is null on a delivery
   * that failed or that a cancelled send never reached, and those are the rows that would
   * otherwise stay for ever.
   */
  private async purgeDeliveries(now: Date): Promise<number> {
    const old = yearsBefore(now, 1);
    const due: Prisma.AnnouncementDeliveryWhereInput = {
      OR: [{ sentAt: { lte: old } }, { sentAt: null, announcement: { createdAt: { lte: old } } }],
    };
    const affected = await this.database.announcementDelivery.groupBy({
      by: ['announcementId'],
      where: due,
      // By id, which is not chronological and does not need to be: `take` requires an order, and
      // what this buys is a stable one, so a backlog clears in a repeatable order over the nights
      // it takes rather than re-shuffling on every run.
      orderBy: { announcementId: 'asc' },
      take: ANNOUNCEMENT_BATCH,
    });
    let total = 0;

    for (const { announcementId } of affected) {
      await this.announcements.freezeStats(announcementId);

      const { count } = await this.database.announcementDelivery.deleteMany({
        where: { announcementId, ...due },
      });

      total += count;
    }

    return total;
  }

  /**
   * Scans, two years on (§13.6).
   *
   * The verdict lives on `ContentSafety` and stays; this is the per-run detail behind it — which
   * terms fired, what the classifier said, how long it took. That detail answers "why was this
   * held" and "is this term any good", and both questions are asked within weeks.
   */
  private async purgeScans(now: Date): Promise<number> {
    const { count } = await this.database.contentScan.deleteMany({
      where: { createdAt: { lte: yearsBefore(now, 2) } },
    });

    return count;
  }

  /** The same two years for term hits, which are the false-positive evidence for one term. */
  private async purgeTermHits(now: Date): Promise<number> {
    const { count } = await this.database.riskTermHit.deleteMany({
      where: { createdAt: { lte: yearsBefore(now, 2) } },
    });

    return count;
  }

  /**
   * Report snapshots, six years on: **the text goes, the row stays**.
   *
   * A snapshot is the content as it was when somebody reported it, which is evidence; the report
   * itself is the record that somebody reported something, which is accountability. Deleting the
   * row would take the second with the first, so the column is nulled and the ids are kept — the
   * case history still says a report was filed, decided and by whom.
   *
   * Raw SQL for the `IS NOT NULL` test: Prisma's JSON filters distinguish a SQL null from a JSON
   * null, and getting that wrong here means either rewriting every old row every night or none of
   * them ever.
   */
  private async clearReportSnapshots(now: Date): Promise<number> {
    return this.database.$executeRaw`
      UPDATE "reports"
      SET "snapshot" = NULL
      WHERE "created_at" <= ${yearsBefore(now, AUDIT_YEARS)}
        AND "snapshot" IS NOT NULL
    `;
  }

  /**
   * Notes whose subject is genuinely gone, six years on.
   *
   * "Life of the subject + 6 years" (§13.6), and the only subject that can actually disappear is a
   * member row that was hard-deleted rather than anonymised — anonymisation keeps the row, which is
   * the whole point of it (S11.4). Cases, threads, disputes and deals are never deleted, so a note
   * about one is never orphaned and is never purged by this.
   *
   * Soft-deleted notes are **not** purged early. A note is somebody's judgement about a person,
   * recorded where that person cannot see it; the record of who wrote what is what keeps the
   * practice accountable, and deleting it on the author's say-so would end that.
   */
  private async purgeOrphanedNotes(now: Date): Promise<number> {
    return this.database.$executeRaw`
      DELETE FROM "internal_notes" n
      WHERE n."created_at" <= ${yearsBefore(now, AUDIT_YEARS)}
        AND n."subject_type" = 'MEMBER'
        AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = n."subject_id")
    `;
  }

  /**
   * A member's own GDPR export, seven days after it was built (§13.7).
   *
   * The file goes and the request stays: "you asked for your data on the fourth and we gave it to
   * you" is a record worth keeping, and the ZIP of everything they ever wrote is not. The key is
   * nulled in the same pass, so a stale link answers "that export has expired" rather than a
   * signed URL to an object that is no longer there.
   *
   * One request at a time rather than one `deleteMany`: each is a call to object storage, and a
   * bucket that refuses one file must not stop the other rules from running.
   */
  private async purgeMemberExportFiles(now: Date): Promise<number> {
    const stale = await this.database.dataExportRequest.findMany({
      where: { downloadKey: { not: null }, expiresAt: { lte: now } },
      take: FILE_BATCH,
      select: { id: true, downloadKey: true },
    });
    let cleared = 0;

    for (const request of stale) {
      try {
        if (request.downloadKey) await this.storage.delete(request.downloadKey);

        await this.database.dataExportRequest.update({
          where: { id: request.id },
          data: { downloadKey: null },
        });

        cleared += 1;
      } catch (error) {
        // Logged and skipped, not thrown: the row keeps its key and the next run tries again,
        // which is the behaviour that gets the file deleted eventually rather than never.
        this.logger.warn(
          `retention.purge: member export ${request.id} file not deleted — ${(error as Error).message}`,
        );
      }
    }

    return cleared;
  }

  // ─── The public website's forms (§5.27) ────────────────────────────────────

  /**
   * Messages and suggestions, two years on.
   *
   * The shorter clock of the two the website's forms are kept on, and it is the right way round: a
   * question about an account or an idea for the app has no legal weight and no further use once it
   * has been answered. A deletion request does, and is handled separately below.
   *
   * **The notes go with the submission**, in one statement, which is a deliberate reading of
   * §13.6's "life of the subject + 6 years". That rule exists for notes about *people* — a
   * judgement recorded where its subject cannot see it, which stays accountable only while the
   * record of who wrote it survives. A note on a website enquiry is about an enquiry, and keeping
   * it for six years after the enquiry has been deleted leaves a staff comment about nothing
   * anybody can look up. Deleted together, or not at all.
   */
  private async purgeWebsiteSubmissions(now: Date): Promise<number> {
    const cutoff = yearsBefore(now, WEBSITE_SUBMISSION_YEARS);

    return this.database.$transaction(async tx => {
      const doomed = await tx.websiteSubmission.findMany({
        where: {
          type: { in: ['CONTACT_MESSAGE', 'FEATURE_SUGGESTION'] },
          createdAt: { lte: cutoff },
        },
        select: { id: true },
        take: WEBSITE_BATCH,
      });

      if (!doomed.length) return 0;

      const ids = doomed.map(row => row.id);

      await tx.internalNote.deleteMany({
        where: { subjectType: 'WEBSITE_SUBMISSION', subjectId: { in: ids } },
      });

      const { count } = await tx.websiteSubmission.deleteMany({ where: { id: { in: ids } } });

      return count;
    });
  }

  /**
   * Deletion requests, six years on — the same clock as the audit trail, and for the same reason.
   *
   * A request to have an account deleted is a data-subject request, and the record that it was
   * received and what was done about it is the evidence of having complied. Six years is the UK
   * limitation period, so the record outlives any claim that it was mishandled. The row by then
   * holds no free text — `redactWebsiteDeletionRequests` cleared that years earlier — so what is
   * being deleted here is an address, four dates and an outcome.
   */
  private async purgeWebsiteDeletionRequests(now: Date): Promise<number> {
    const cutoff = yearsBefore(now, AUDIT_YEARS);

    return this.database.$transaction(async tx => {
      const doomed = await tx.websiteSubmission.findMany({
        where: { type: 'DELETION_REQUEST', createdAt: { lte: cutoff } },
        select: { id: true },
        take: WEBSITE_BATCH,
      });

      if (!doomed.length) return 0;

      const ids = doomed.map(row => row.id);

      await tx.internalNote.deleteMany({
        where: { subjectType: 'WEBSITE_SUBMISSION', subjectId: { in: ids } },
      });

      const { count } = await tx.websiteSubmission.deleteMany({ where: { id: { in: ids } } });

      return count;
    });
  }

  /**
   * The free text off a finished deletion request, a month after it was finished.
   *
   * Six years is the right clock for *that a request was made and handled*. It is far too long for
   * the paragraph somebody wrote about why they are leaving, which is often the most personal thing
   * in the whole table — a bad experience, a safety worry, a relationship. So the row is kept and
   * the words are not: `name` and `body` go, and the address, the reason code, the dates and the
   * outcome stay, which is exactly what makes it evidence of compliance.
   *
   * The month's grace is so that somebody querying how their request was handled can still be
   * answered from the record while it is fresh. After that the answer is the outcome, not the prose.
   *
   * Keyed on `completedAt` rather than `createdAt`, so this can never reach a request still being
   * worked — redacting one of those would delete the details from under the person working it.
   */
  private async redactWebsiteDeletionRequests(now: Date): Promise<number> {
    const { count } = await this.database.websiteSubmission.updateMany({
      where: {
        type: 'DELETION_REQUEST',
        // Finished for a month, by whichever clock applies. `DONE` has a `completedAt`; `SPAM`
        // never does, because it is set by the per-email limit and nobody ever worked it — so
        // keying only on `completedAt` would have kept the free text of every throttled request
        // for the full six years, which is the one group whose text was never needed at all.
        OR: [
          { completedAt: { lte: daysBefore(now, WEBSITE_REDACT_DAYS) } },
          { state: 'SPAM', createdAt: { lte: daysBefore(now, WEBSITE_REDACT_DAYS) } },
        ],
        // Only rows that still hold something, so a second pass counts nothing and the summary
        // does not report work it did not do.
        NOT: { name: null, body: null },
      },
      data: { name: null, body: null },
    });

    return count;
  }
}

/** Six years: the UK limitation period, which is what the audit rules are keyed on (S11.4). */
const AUDIT_YEARS = 6;

/** Twenty-four months for a website message or suggestion, as the product owner settled it. */
const WEBSITE_SUBMISSION_YEARS = 2;

/** How long after a deletion request is finished its free text is kept. */
const WEBSITE_REDACT_DAYS = 30;

/** How many submissions one pass deletes. A backlog clears over a few nights. */
const WEBSITE_BATCH = 500;

/** How many announcements one pass clears the deliveries of. Each one is a freeze and a delete. */
const ANNOUNCEMENT_BATCH = 100;

/** How many member export files one pass deletes. A backlog clears over a few nights. */
const FILE_BATCH = 200;

/**
 * Calendar arithmetic, not 365 days.
 *
 * "Six years" is a legal period and leap years are part of it. `setUTCFullYear` gives the same
 * date six years earlier, which is the date a court would read; counting 2,190 days drifts by a
 * day or two every four years, always in the direction of deleting early.
 */
const yearsBefore = (now: Date, years: number): Date => {
  const at = new Date(now.getTime());

  at.setUTCFullYear(at.getUTCFullYear() - years);

  return at;
};

const daysBefore = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
