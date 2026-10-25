import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebsiteSubmissionType } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '@/infrastructure';
import { ContactMessageDto, DeletionRequestDto, FeatureSuggestionDto } from '../dtos';
import { WebsiteMailService } from './website-mail.service';

/**
 * At most this many deletion requests per address per day, on top of the per-IP rate limit.
 *
 * The per-IP limit protects the API; this protects a *person*. Without it the form is a way to
 * make Circl email somebody repeatedly by typing their address in from a new network each time.
 * Requests past the limit are answered exactly as the others are — see `deletionRequest`.
 */
const DELETION_REQUESTS_PER_EMAIL_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The three forms on the public website (`API-WEBSITE-FORMS.md`).
 *
 * Two of them are ordinary: validate, store, tell the team. The third is the one with rules, and
 * they are all consequences of a single fact — **anyone can type anyone's address into a public
 * form.** So a deletion request never deletes anything, never says whether the address belongs to
 * an account, and never causes an email to any address but the one on that account.
 */
@Injectable()
export class WebsiteSubmissionService {
  private readonly logger = new Logger(WebsiteSubmissionService.name);
  private readonly ipSalt: string;

  constructor(
    private readonly database: PrismaService,
    private readonly mail: WebsiteMailService,
    config: ConfigService,
  ) {
    // An existing required secret, reused as a salt. An unsalted SHA-256 of an IPv4 address is
    // reversible by brute force in under a minute — four billion hashes — so an unsalted column
    // would be the address with extra steps, which is the thing this column exists not to keep.
    //
    // A consequence worth knowing: rotating this secret makes old hashes incomparable with new
    // ones. That is acceptable here, because the only thing the column is for is spotting a burst
    // from one source in the recent past.
    this.ipSalt = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  async contactMessage(dto: ContactMessageDto, ip: string | null) {
    const row = await this.database.websiteSubmission.create({
      data: {
        type: WebsiteSubmissionType.CONTACT_MESSAGE,
        name: dto.name,
        email: dto.email,
        topic: dto.topic,
        body: dto.message,
        ipHash: this.hashIp(ip),
      },
      select: { id: true },
    });

    this.logger.log({ event: 'website_submission', type: 'CONTACT_MESSAGE', id: row.id });

    // Awaited: this form has nothing to hide, and a visitor who is told "we got it" should not
    // have been told that if the only place it was going is a mailbox nobody checks. The mail
    // service swallows provider failures, so this cannot fail the request either way.
    await this.mail.contactMessage({
      id: row.id,
      name: dto.name,
      email: dto.email,
      topic: dto.topic,
      message: dto.message,
    });

    return { id: row.id };
  }

  async featureSuggestion(dto: FeatureSuggestionDto, ip: string | null) {
    const row = await this.database.websiteSubmission.create({
      data: {
        type: WebsiteSubmissionType.FEATURE_SUGGESTION,
        email: dto.email ?? null,
        area: dto.area,
        title: dto.title,
        body: dto.details,
        ipHash: this.hashIp(ip),
      },
      select: { id: true },
    });

    this.logger.log({ event: 'website_submission', type: 'FEATURE_SUGGESTION', id: row.id });

    await this.mail.featureSuggestion({
      id: row.id,
      title: dto.title,
      area: dto.area,
      details: dto.details,
      email: dto.email ?? null,
    });

    return { id: row.id };
  }

  /**
   * "Ask us to delete your account" — the page Google Play requires, for somebody who cannot or
   * would rather not do it in the app.
   *
   * **The response is the same whatever happens next.** Same status, same body, and as close to
   * the same time as this can manage: whether an address belongs to a Circl account is not
   * something a public form may answer, and for this community that is not a theoretical concern.
   * So the row is written — an insert whose duration says nothing about any account — and
   * everything that *does* depend on the address happens after the response has gone.
   *
   * The deferred half is intentionally fire-and-forget rather than awaited. Awaiting it would put
   * the account lookup inside the response time, which is the timing channel this exists to close.
   */
  async deletionRequest(dto: DeletionRequestDto, ip: string | null): Promise<void> {
    const recent = await this.database.websiteSubmission.count({
      where: {
        type: WebsiteSubmissionType.DELETION_REQUEST,
        email: dto.email,
        createdAt: { gt: new Date(Date.now() - DAY_MS) },
      },
    });

    const row = await this.database.websiteSubmission.create({
      data: {
        type: WebsiteSubmissionType.DELETION_REQUEST,
        name: dto.name,
        email: dto.email,
        reason: dto.reason,
        body: dto.details ?? null,
        ipHash: this.hashIp(ip),
        // Still recorded, still visible to staff, and over the limit: the record of somebody
        // trying four times is worth keeping, and `SPAM` is what stops it being worked a fourth
        // time. What it does not do is send a fourth email.
        ...(recent >= DELETION_REQUESTS_PER_EMAIL_PER_DAY ? { state: 'SPAM' as const } : {}),
      },
      select: { id: true, state: true },
    });

    this.logger.log({
      event: 'website_submission',
      type: 'DELETION_REQUEST',
      id: row.id,
      // The outcome, not the address: NFR-5. A count is enough to see a flood without naming
      // whose inbox was being flooded.
      throttled: recent >= DELETION_REQUESTS_PER_EMAIL_PER_DAY,
    });

    if (recent >= DELETION_REQUESTS_PER_EMAIL_PER_DAY) return;

    // Deliberately not awaited, and not left unhandled either. `void` plus a `catch` says this is
    // a decision rather than a forgotten `await`.
    void this.afterResponding(row.id, dto.email).catch(error =>
      this.logger.error({
        event: 'website_deletion_followup_failed',
        id: row.id,
        message: (error as Error).message,
      }),
    );
  }

  /**
   * The half that may not influence the response: does this address belong to an account?
   *
   * Recorded on the row rather than put in the email, so that the answer survives the inbox and a
   * member of staff picking the request up tomorrow sees what was true when it arrived.
   *
   * Nothing is emailed to the address itself — not even "no account uses this email". That note is
   * still an open team decision, and the safe default is silence: a note sent on a stranger's
   * typing makes the form a way to send mail to arbitrary addresses in Circl's name.
   */
  private async afterResponding(id: string, email: string): Promise<void> {
    const match = await this.database.user.findFirst({
      // A deleted account's address is already anonymised, so this cannot match one — which is
      // right: there is nothing left to delete.
      where: { email, isAnonymised: false },
      select: { id: true },
    });

    const row = await this.database.websiteSubmission.update({
      where: { id },
      data: { matchedUserId: match?.id ?? null, checkedAt: new Date() },
      select: { id: true, name: true, email: true, reason: true, body: true },
    });

    this.logger.log({
      event: 'website_deletion_checked',
      id,
      // Whether an account matched, never which one and never the address.
      matched: !!match,
    });

    await this.mail.deletionRequest({
      id: row.id,
      name: row.name ?? '(not given)',
      email: row.email ?? '(not given)',
      reason: row.reason ?? 'OTHER',
      details: row.body,
      matched: !!match,
    });
  }

  private hashIp(ip: string | null): string | null {
    return ip ? createHash('sha256').update(`${this.ipSalt}:${ip}`).digest('hex') : null;
  }
}
