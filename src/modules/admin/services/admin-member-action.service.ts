import { Injectable, Logger } from '@nestjs/common';
import {
  EnforcementSourceType,
  NotificationKind,
  Prisma,
  TaxonomyKind,
  UserAccountStatus,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/infrastructure';
import {
  ApiErrorCode,
  ApiException,
  ReasonedDto,
  SYSTEM_CONFIG_KEYS,
  ageFromDateOfBirth,
} from '@/common';
import { AccountDeletionService, DataExportService } from '@/modules/platform/account';
import { NotificationFeedService, NotificationOutcome } from '@/modules/platform/notifications';
import {
  CityService,
  SessionRevocationService,
  SystemConfigService,
  TaxonomyService,
} from '@/modules/platform/shared';
import { AuditService } from '../audit/audit.service';
import { AdminMailService } from '../auth/admin-mail.service';
import { adminContext } from '../common/admin-context';
import { AdminPolicyService } from '../common/admin-policy.service';
import { AdminPrincipal } from '../common/admin-principal';
import { mayEditField } from '../common/member-editable-fields';
import {
  AnonymiseMemberDto,
  BulkRevokeSessionsDto,
  ChangeSuspensionDto,
  PatchMemberDto,
  ReasonOnlyDto,
  RevokeMemberSessionsDto,
  SuspendMemberDto,
  WarnMemberDto,
} from '../dtos/admin-member-actions.dto';
import { contactHash, maskEmail, maskPhone } from '../serializers/pii.serializer';
import { AdminMemberService } from './admin-member.service';
import { EnforcementService } from './enforcement.service';

/** A reason that has been through `assertReasoned`, so no caller can be handed an unchecked one. */
type CheckedReason = ReturnType<ReasonedDto['assertReasoned']>;

/** The fields on `PatchMemberDto` that are the reason, not the change. */
const REASON_FIELDS = new Set(['reasonCode', 'policySubtype', 'note']);

/** Contact fields never appear in an audit entry in the clear (S8.4). */
const CONTACT_FIELDS = new Set(['email', 'phoneNumber']);

/** How long each named duration lasts. `permanent` has no end; `custom` is given one. */
const DURATION_MS: Record<string, number | null> = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  permanent: null,
};

/** The reasons that justify correcting a locked date of birth (§5.5, D10/D15). */
const DOB_REASONS = new Set(['CORRECTION', 'LEGAL_GDPR']);

/**
 * Everything staff can *do* to a member, as opposed to read about them (§5.5).
 *
 * Separate from `AdminMemberService` because the two have opposite shapes. Reading is a dozen
 * queries with no consequences; each of these is one decision with side effects that reach the
 * member — an email they did not ask for, a session that stops working mid-sentence, an account
 * that cannot be recovered. So every one of them goes through `audit.mutate`, which means a change
 * written without an entry beside it does not compile, and every one takes a checked reason.
 */
@Injectable()
export class AdminMemberActionService {
  private readonly logger = new Logger(AdminMemberActionService.name);
  private readonly supportEmail: string;

  constructor(
    private readonly database: PrismaService,
    private readonly audit: AuditService,
    private readonly policy: AdminPolicyService,
    private readonly members: AdminMemberService,
    private readonly enforcement: EnforcementService,
    private readonly sessions: SessionRevocationService,
    private readonly cities: CityService,
    private readonly taxonomy: TaxonomyService,
    private readonly config: SystemConfigService,
    private readonly notifications: NotificationFeedService,
    private readonly mail: AdminMailService,
    private readonly exports: DataExportService,
    private readonly deletion: AccountDeletionService,
    configService: ConfigService,
  ) {
    this.supportEmail = configService.getOrThrow<string>('SUPPORT_EMAIL');
  }

  // ─── Profile edits ─────────────────────────────────────────────────────────

  /**
   * Corrects a member's profile.
   *
   * Three gates, in order, because each one answers a different question and the order matters.
   * The allowlist asks whether this caller may touch this field at all (S10.2) and refuses with the
   * field's name — a staff member needs to know which of six edits was rejected. The validators ask
   * whether the value is usable, with the same rules the member's own profile save applies, so the
   * two paths cannot leave one account holding something the other would refuse. Only then is
   * anything written.
   */
  async patch(actor: AdminPrincipal, id: string, dto: PatchMemberDto) {
    await this.policy.assertIsMember(id);

    const reason = dto.assertReasoned();
    const changes = Object.entries(dto).filter(
      ([field, value]) => !REASON_FIELDS.has(field) && value !== undefined,
    );

    if (!changes.length) {
      throw ApiException.badRequest(ApiErrorCode.VALIDATION_FAILED, 'Nothing to change.');
    }

    for (const [field] of changes) this.assertMayEdit(actor, field, reason.reasonCode);

    const current = await this.database.user.findUniqueOrThrow({
      where: { id },
      select: {
        email: true,
        firstName: true,
        lastName: true,
        username: true,
        avatarKey: true,
        profile: { select: PROFILE_FIELDS },
      },
    });

    const { user, profile } = await this.validate(id, dto, current);
    const emailChanged = dto.email !== undefined && dto.email !== current.email;

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    for (const [field, value] of changes) {
      const was =
        (current as Record<string, unknown>)[field] ??
        (current.profile as Record<string, unknown> | null)?.[field] ??
        null;

      if (field === 'removeAvatar') {
        before.avatar = current.avatarKey ? 'set' : 'none';
        after.avatar = 'none';
        continue;
      }

      // Contact details are recorded masked, plus a SHA-256 of the full value (S8.4). An
      // investigator holding a candidate address can confirm it was the one, and the trail — which
      // is never deleted — does not become a second copy of everybody's contact details.
      if (CONTACT_FIELDS.has(field)) {
        const wasCode = current.profile?.phoneNumberDiallingCode ?? null;
        // The code that will be stored, which is not the old one when both are changing at once.
        const willCode =
          dto.phoneNumberDiallingCode !== undefined ? dto.phoneNumberDiallingCode : wasCode;

        const mask = (raw: unknown, code: string | null) =>
          field === 'email'
            ? maskEmail(raw as string | null)
            : maskPhone(code, raw as string | null);

        before[field] = { masked: mask(was, wasCode), sha256: contactHash(was as string | null) };
        after[field] = {
          masked: mask(value, willCode),
          sha256: contactHash(value as string | null),
        };
        continue;
      }

      before[field] = was;
      // What will actually be stored, not what was sent. `cityId` is resolved through the city
      // service and may come back as a different id from a loose spelling, and
      // `countryOfOriginCode` is upper-cased — so a trail built from the request would say the
      // field was set to something the row does not hold. The audit service's own comment warns
      // about exactly this: an entry that records what was asked for rather than what happened is
      // the one difference worth having the trail for.
      after[field] = this.storedValue(field, value, user, profile);
    }

    const { result, auditId } = await this.audit.mutate(
      {
        action: 'member.updated',
        targetType: 'MEMBER',
        targetId: id,
        before,
        after,
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
        metadata: { fields: changes.map(([field]) => field) },
      },
      async tx => {
        if (Object.keys(user).length) await tx.user.update({ where: { id }, data: user });

        if (Object.keys(profile).length) {
          // `upsert`, not `update`: every member created through registration has a profile row,
          // but a row written by a script or a seeder may not, and a 500 on an edit is a worse
          // answer than creating the row the edit implies.
          await tx.userProfile.upsert({
            where: { userId: id },
            update: profile,
            create: {
              ...(profile as Prisma.UserProfileUncheckedCreateInput),
              user: { connect: { id } },
            } as Prisma.UserProfileCreateInput,
          });
        }

        if (emailChanged) {
          // Unverified until the member confirms it. Staff can correct a typo in an address; staff
          // cannot vouch that somebody reads it, and `emailVerifiedAt` is a claim about the second.
          //
          // `updateMany` rather than a nested update, which would throw where there is no
          // `UserAuth` row — and an account with no credentials row has nothing to unverify.
          await tx.userAuth.updateMany({ where: { userId: id }, data: { emailVerifiedAt: null } });
        }

        return true;
      },
    );

    void result;
    await this.announceEdit(current, dto);

    return { data: await this.members.detail(id), auditId };
  }

  /**
   * The value the write will put in the row, for the audit entry.
   *
   * Reads it back out of the two update objects the validators built, falling back to the request
   * for a field that is neither (`removeAvatar` is handled before this is called). A `connect`
   * shape is unwrapped to the id it connects to, because "the city is `{ connect: { id: … } }`" is
   * not a sentence anybody reviewing a trail wants to read.
   */
  private storedValue(
    field: string,
    requested: unknown,
    user: Prisma.UserUpdateInput,
    profile: Prisma.UserProfileUpdateInput,
  ): unknown {
    const fromUser = (user as Record<string, unknown>)[field];
    const fromProfile = (profile as Record<string, unknown>)[field];

    // `city: { connect: { id } }` is how a relation is written; `cityId` is what the entry calls it.
    const connected = (profile as { city?: { connect?: { id?: string } } }).city?.connect?.id;

    if (field === 'cityId' && connected) return connected;

    if (fromUser !== undefined) return fromUser;
    if (fromProfile !== undefined) return fromProfile;

    return requested;
  }

  /**
   * Who may touch which field, and why a date of birth is different.
   *
   * An age gates Connect and the adult sections, so "editing" one is a safeguarding change wearing
   * a profile field's clothes — which is why it is restricted to two roles **and** to two reasons.
   * A member asking for a correction and a legal request are the only two things it can honestly be.
   */
  private assertMayEdit(actor: AdminPrincipal, field: string, reasonCode: string): void {
    if (!mayEditField(actor.roleCode, field)) {
      throw ApiException.forbidden(ApiErrorCode.FIELD_NOT_EDITABLE, `You cannot change ${field}.`, {
        details: [{ field, message: 'Not editable by your role.' }],
      });
    }

    // `content:moderate` alone reaches this endpoint for the avatar and nothing else, so a caller
    // without `members:edit` asking for any other field is refused by name rather than by a blanket
    // 403 that does not say which field was the problem.
    if (field !== 'removeAvatar' && !actor.permissions.has('members:edit')) {
      throw ApiException.forbidden(
        ApiErrorCode.FIELD_NOT_EDITABLE,
        `You can only remove an avatar, not change ${field}.`,
        { details: [{ field, message: 'Needs members:edit.' }] },
      );
    }

    if (field === 'dateOfBirth' && !DOB_REASONS.has(reasonCode)) {
      throw ApiException.unprocessable(
        ApiErrorCode.REASON_NOT_ALLOWED,
        'A date of birth can only be corrected, or changed for a legal request.',
        { details: [{ field: 'reasonCode', message: 'CORRECTION or LEGAL_GDPR.' }] },
      );
    }
  }

  /**
   * The values, checked the way the member's own profile save checks them.
   *
   * Split into the two tables an edit can touch, so the write is two statements and not a guess.
   * Uniqueness is checked here *and* enforced by the column, because between the check and the
   * write somebody else can take the name — the check gives a 409 that names the field, and the
   * constraint is what makes the claim true.
   */
  private async validate(
    id: string,
    dto: PatchMemberDto,
    current: { username: string | null; email: string },
  ): Promise<{ user: Prisma.UserUpdateInput; profile: Prisma.UserProfileUpdateInput }> {
    const user: Prisma.UserUpdateInput = {};
    const profile: Prisma.UserProfileUpdateInput = {};

    if (dto.firstName !== undefined) user.firstName = dto.firstName;
    if (dto.lastName !== undefined) user.lastName = dto.lastName;
    if (dto.removeAvatar) user.avatarKey = null;

    if (dto.username !== undefined && dto.username !== current.username) {
      const taken = await this.database.user.findFirst({
        where: { username: dto.username, id: { not: id } },
        select: { id: true },
      });

      if (taken) {
        throw ApiException.conflict(ApiErrorCode.USERNAME_TAKEN, 'That username is taken.', {
          details: [{ field: 'username', message: 'Taken.' }],
        });
      }

      // The old name is freed by the same write: `username` is unique, so nothing holds it once
      // this row stops pointing at it.
      user.username = dto.username;
    }

    if (dto.email !== undefined && dto.email !== current.email) {
      const taken = await this.database.user.findFirst({
        where: { email: dto.email, id: { not: id } },
        select: { id: true },
      });

      if (taken) {
        throw ApiException.conflict(ApiErrorCode.EMAIL_TAKEN, 'That address is already in use.', {
          details: [{ field: 'email', message: 'Already in use.' }],
        });
      }

      user.email = dto.email;
    }

    if (dto.cityId !== undefined) {
      const city = await this.cities.assertValid(dto.cityId);

      profile.city = { connect: { id: city.id } };
    }

    if (dto.gender !== undefined) profile.gender = dto.gender;
    if (dto.headline !== undefined) profile.headline = dto.headline;
    if (dto.bio !== undefined) profile.bio = dto.bio;
    if (dto.canHelpWith !== undefined) profile.canHelpWith = dto.canHelpWith;

    if (dto.countryOfOriginCode !== undefined) {
      profile.countryOfOriginCode = dto.countryOfOriginCode
        ? dto.countryOfOriginCode.toUpperCase()
        : null;
    }

    if (dto.heritageTag !== undefined) {
      if (dto.heritageTag)
        await this.taxonomy.assertValid(TaxonomyKind.HERITAGE_TAG, dto.heritageTag, 'heritageTag');
      profile.heritageTag = dto.heritageTag;
    }

    if (dto.journeyStage !== undefined) {
      if (dto.journeyStage)
        await this.taxonomy.assertValid(
          TaxonomyKind.JOURNEY_STAGE,
          dto.journeyStage,
          'journeyStage',
        );
      profile.journeyStage = dto.journeyStage;
    }

    if (dto.languages !== undefined) {
      profile.languages = await this.assertCodes(
        TaxonomyKind.LANGUAGE,
        dto.languages,
        'languages',
        await this.config.get(SYSTEM_CONFIG_KEYS.MAX_LANGUAGES),
      );
    }

    if (dto.interests !== undefined) {
      profile.interests = await this.assertCodes(
        TaxonomyKind.INTEREST,
        dto.interests,
        'interests',
        await this.config.get(SYSTEM_CONFIG_KEYS.MAX_INTERESTS),
      );
    }

    if (dto.dateOfBirth !== undefined) {
      profile.dateOfBirth = this.assertAge(dto.dateOfBirth);
      profile.dateOfBirthSetAt = new Date();
    }

    this.assertPhone(dto);

    if (dto.phoneNumberDiallingCode !== undefined) {
      profile.phoneNumberDiallingCode = dto.phoneNumberDiallingCode;
    }

    if (dto.phoneNumber !== undefined) profile.phoneNumber = dto.phoneNumber;

    return { user, profile };
  }

  /** A number and its dialling code travel together, or neither does: half a number cannot be rung. */
  private assertPhone(dto: PatchMemberDto): void {
    const number = dto.phoneNumber;
    const code = dto.phoneNumberDiallingCode;
    const clearingBoth = number === null && code === null;

    if (clearingBoth) return;

    // Both present, or both absent, or both cleared. Anything else leaves half a number: a code
    // with nothing to dial, or digits with no country, and neither can be rung.
    const bothSent = number !== undefined && code !== undefined;
    const neitherSent = number === undefined && code === undefined;

    if (!bothSent && !neitherSent) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'Send the dialling code and the number together.',
        { details: [{ field: 'phoneNumber', message: 'Both or neither.' }] },
      );
    }

    if (bothSent && (number === null) !== (code === null)) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'Clear the dialling code and the number together.',
        { details: [{ field: 'phoneNumber', message: 'Clear both or neither.' }] },
      );
    }

    if (number && number.replace(/\D/g, '').length < 9) {
      throw ApiException.badRequest(ApiErrorCode.VALIDATION_FAILED, 'That number is too short.', {
        details: [{ field: 'phoneNumber', message: 'At least 9 digits.' }],
      });
    }
  }

  /**
   * 18 to 110. The floor is the platform's minimum age; the ceiling catches a mistyped year.
   *
   * Through `ageFromDateOfBirth`, which counts calendar years. Dividing elapsed milliseconds by an
   * average year is wrong by up to a day either side of a birthday — and on the one boundary that
   * matters, that is a member who turned 18 today being told their date of birth is invalid.
   */
  private assertAge(value: string): Date {
    const date = new Date(`${value}T00:00:00.000Z`);
    const age = Number.isNaN(date.getTime()) ? null : ageFromDateOfBirth(date);

    if (age === null || age < 18 || age > 110) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'That date of birth gives an age outside 18 to 110.',
        { details: [{ field: 'dateOfBirth', message: 'Age must be 18–110.' }] },
      );
    }

    return date;
  }

  /** Known codes, within the configured limit — the same two checks the member's own save makes. */
  private async assertCodes(
    kind: TaxonomyKind,
    codes: string[],
    field: string,
    limit: number,
  ): Promise<string[]> {
    const unique = [...new Set(codes)];

    if (unique.length > limit) {
      throw ApiException.unprocessable(ApiErrorCode.VALIDATION_FAILED, `At most ${limit}.`, {
        details: [{ field, message: `At most ${limit}.` }],
      });
    }

    for (const code of unique) await this.taxonomy.assertValid(kind, code, field);

    return unique;
  }

  /**
   * Tells the member what staff changed — and tells the **old** address, where there was one.
   *
   * Sent after the write, never inside the transaction, and a failure is logged rather than thrown:
   * an edit that succeeded and an email that did not arrive is recoverable, while an edit refused
   * because the mail provider was down is a correction somebody has to make twice.
   *
   * The old address is the one that matters. If the change was not the member's idea, the new
   * address belongs to whoever made it, and a notice sent only there tells the wrong person.
   */
  private async announceEdit(current: { email: string }, dto: PatchMemberDto): Promise<void> {
    const changed: string[] = [];

    if (dto.email !== undefined && dto.email !== current.email) changed.push('email address');
    if (dto.phoneNumber !== undefined) changed.push('phone number');
    if (dto.firstName !== undefined || dto.lastName !== undefined) changed.push('name');

    if (!changed.length) return;

    try {
      await this.mail.memberContactChanged(current.email, changed, this.supportEmail);

      if (dto.email && dto.email !== current.email) {
        await this.mail.memberEmailChanged(dto.email, this.supportEmail);
      }
    } catch (error) {
      this.logger.warn({
        event: 'member_edit_notice_not_sent',
        message: (error as Error).message,
      });
    }
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  /**
   * Signs a member out of one device, or all of them.
   *
   * Through the shared revocation service, so the Redis blacklist key is the one the member's own
   * sign-out writes and the member strategy checks. A staff revoke that only updated the database
   * row would leave every issued access token working until it expired, which is a sign-out that
   * is not one.
   */
  async revokeSessions(id: string, dto: RevokeMemberSessionsDto) {
    await this.policy.assertIsMember(id);

    return this.revokeFor(id, dto.assertReasoned(), dto.sessionId);
  }

  /** The revoke itself, taking a reason that has already been checked — see `bulkRevokeSessions`. */
  private async revokeFor(id: string, reason: CheckedReason, sessionId?: string) {
    const dto = { sessionId };

    if (dto.sessionId) {
      const session = await this.database.userSession.findFirst({
        where: { id: dto.sessionId, userId: id },
        select: { id: true },
      });

      if (!session) throw ApiException.notFound('No such session.');
    }

    const { result, auditId } = await this.audit.mutate(
      (revokedCount: number) => ({
        action: 'member.sessions_revoked',
        targetType: 'MEMBER',
        targetId: id,
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
        metadata: {
          count: revokedCount,
          sessionId: dto.sessionId ?? null,
          scope: dto.sessionId ? 'one' : 'all',
        },
      }),
      // The revocation itself is not part of the transaction: it writes to Redis as well as to
      // Postgres, and a Redis write cannot be rolled back. Done inside, a failed audit insert
      // would leave sessions blacklisted with nothing recording why.
      async () => this.sessions.revoke(id, dto.sessionId),
    );

    // Push tokens go with the last session. A device signed out that still receives notifications
    // is the one thing a member reads as "they are still in my account".
    if (!dto.sessionId) await this.database.pushDevice.deleteMany({ where: { userId: id } });

    return { data: { revokedCount: result }, auditId };
  }

  async bulkRevokeSessions(dto: BulkRevokeSessionsDto) {
    const reason = dto.assertReasoned();
    const ids = [...new Set(dto.memberIds)];

    let revokedCount = 0;
    const done: string[] = [];

    for (const id of ids) {
      // One member's problem does not stop the rest: a bulk action that aborts half way through
      // leaves nobody able to say which half.
      try {
        await this.policy.assertIsMember(id);

        // Straight to the revoke, with the reason checked once for the whole batch. Going back
        // through the DTO path would mean re-checking it a hundred times, and casting a bulk DTO
        // into a single-member one would quietly change meaning the day somebody adds a field.
        const { data } = await this.revokeFor(id, reason);

        revokedCount += data.revokedCount;
        done.push(id);
      } catch (error) {
        this.logger.warn({
          event: 'bulk_revoke_skipped',
          userId: id,
          message: (error as Error).message,
        });
      }
    }

    const auditId = await this.audit.record(this.database, {
      action: 'member.bulk_action',
      targetType: 'MEMBER',
      targetId: null,
      reasonCode: reason.reasonCode,
      policySubtype: reason.policySubtype,
      reason: reason.note,
      metadata: {
        action: 'sessions_revoked',
        requested: ids.length,
        members: done.length,
        revokedCount,
      },
    });

    return { data: { members: done.length, revokedCount }, auditId };
  }

  /** Clears a lockout from failed sign-ins — the same three columns the login path writes. */
  async unlock(id: string, dto: ReasonOnlyDto) {
    await this.policy.assertIsMember(id);

    const reason = dto.assertReasoned();
    const auth = await this.database.userAuth.findUnique({
      where: { userId: id },
      select: { isBlocked: true, failedLoginAttempts: true },
    });

    const { auditId } = await this.audit.mutate(
      {
        action: 'member.login_unlocked',
        targetType: 'MEMBER',
        targetId: id,
        before: {
          isBlocked: auth?.isBlocked ?? false,
          failedLoginAttempts: auth?.failedLoginAttempts ?? 0,
        },
        after: { isBlocked: false, failedLoginAttempts: 0 },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
      },
      async tx =>
        tx.userAuth.updateMany({
          where: { userId: id },
          data: { isBlocked: false, failedLoginAttempts: 0, lastFailedLoginAt: null },
        }),
    );

    return { data: await this.members.detail(id), auditId };
  }

  // ─── Enforcement ───────────────────────────────────────────────────────────

  /**
   * Suspends an account.
   *
   * Four writes that have to happen together, and the order of the last two is the point: the
   * `Suspension` row is the record, `User.status` is what every read path checks, and the session
   * revocation is what makes it true *now*. Today's endpoint updated the database rows and left
   * the member's access tokens working until they expired — a suspension somebody could keep using
   * for an hour.
   *
   * 409 when one is already in force: extending or shortening goes through
   * `PATCH admin/suspensions/:id`, so that a second suspension cannot silently shadow the first and
   * leave two rows disagreeing about when the account comes back.
   */
  async suspend(id: string, dto: SuspendMemberDto) {
    await this.policy.assertIsMember(id);

    const reason = dto.assertReasoned();
    const endsAt = this.endOfSuspension(dto);

    const { result, auditId } = await this.audit.mutate(
      (created: { id: string }) => ({
        action: 'member.suspended',
        targetType: 'MEMBER',
        targetId: id,
        after: {
          suspensionId: created.id,
          duration: dto.duration,
          endsAt: endsAt?.toISOString() ?? null,
        },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
        metadata: {
          sourceType: dto.sourceType ?? EnforcementSourceType.MANUAL,
          sourceId: dto.sourceId ?? null,
        },
      }),
      async tx => {
        // Checked inside the transaction, not before it. Read outside, two staff members acting at
        // the same moment both see no suspension and both create one — and two rows then disagree
        // about when the account comes back, which is the state the 409 exists to prevent.
        const existing = await this.enforcement.activeSuspension(id, tx);

        if (existing) {
          throw ApiException.conflict(
            ApiErrorCode.ALREADY_SUSPENDED,
            'That account is already suspended. Change the existing suspension instead.',
            { data: { suspensionId: existing.id } },
          );
        }

        const created = await tx.suspension.create({
          data: {
            userId: id,
            endsAt,
            reasonCode: reason.reasonCode,
            policySubtype: reason.policySubtype,
            note: reason.note,
            sourceType: dto.sourceType ?? EnforcementSourceType.MANUAL,
            sourceId: dto.sourceId ?? null,
            sourceTargetType: dto.sourceTargetType ?? null,
            issuedById: this.actorId(),
          },
          select: { id: true },
        });

        await tx.user.update({
          where: { id },
          data: { status: UserAccountStatus.SUSPENDED, suspendedUntil: endsAt },
        });

        return created;
      },
    );

    // Outside the transaction, because it writes to Redis as well: a rolled-back transaction
    // cannot un-blacklist a session, and a suspension whose sessions were missed is not one.
    await this.sessions.revoke(id);
    await this.database.pushDevice.deleteMany({ where: { userId: id } });

    this.tellMember(id, {
      outcome: 'REJECTED',
      title: 'Your Circl account has been suspended',
      body: this.suspensionMessage(endsAt, reason.note),
    });

    void result;

    return { data: await this.members.detail(id), auditId };
  }

  /** Extends or shortens one that is already in force, which is the only way to change it. */
  async changeSuspension(suspensionId: string, dto: ChangeSuspensionDto) {
    const reason = dto.assertReasoned();
    const suspension = await this.database.suspension.findUnique({
      where: { id: suspensionId },
      select: { id: true, userId: true, endsAt: true, liftedAt: true },
    });

    if (!suspension || suspension.liftedAt) throw ApiException.notFound('No such suspension.');

    await this.policy.assertIsMember(suspension.userId);

    if (dto.endsAt === undefined) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'Send the new end date, or `null` to make it indefinite.',
        { details: [{ field: 'endsAt', message: 'Required. Send null for indefinite.' }] },
      );
    }

    const endsAt = dto.endsAt === null ? null : new Date(dto.endsAt);

    if (endsAt && endsAt.getTime() <= Date.now()) {
      throw ApiException.badRequest(
        ApiErrorCode.VALIDATION_FAILED,
        'That end is in the past. Reactivate the account instead.',
        { details: [{ field: 'endsAt', message: 'Must be in the future.' }] },
      );
    }

    const { auditId } = await this.audit.mutate(
      {
        action: 'member.suspension_changed',
        targetType: 'MEMBER',
        targetId: suspension.userId,
        before: { endsAt: suspension.endsAt?.toISOString() ?? null },
        after: { endsAt: endsAt?.toISOString() ?? null },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
        metadata: { suspensionId },
      },
      async tx => {
        await tx.suspension.update({ where: { id: suspensionId }, data: { endsAt } });

        // `User.suspendedUntil` is what the member-facing paths read, so it moves with the row it
        // is a copy of. Left behind, the account would come back on the old date.
        await tx.user.update({
          where: { id: suspension.userId },
          data: { suspendedUntil: endsAt },
        });

        return true;
      },
    );

    const updated = await this.database.suspension.findUniqueOrThrow({
      where: { id: suspensionId },
    });

    this.tellMember(suspension.userId, {
      title: endsAt ? 'Your suspension has been changed' : 'Your suspension is now indefinite',
      body: this.suspensionMessage(endsAt, reason.note),
    });

    return {
      data: {
        id: updated.id,
        startsAt: updated.startsAt.toISOString(),
        endsAt: updated.endsAt?.toISOString() ?? null,
        reasonCode: updated.reasonCode,
        note: updated.note,
        liftedAt: updated.liftedAt?.toISOString() ?? null,
        active: true,
      },
      auditId,
    };
  }

  /** Lifts the suspension in force and puts the account back. */
  async reactivate(id: string, dto: ReasonOnlyDto) {
    await this.policy.assertIsMember(id);

    const reason = dto.assertReasoned();
    const active = await this.enforcement.activeSuspension(id);
    const member = await this.database.user.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });

    if (!active && member.status !== UserAccountStatus.SUSPENDED) {
      throw ApiException.conflict(
        ApiErrorCode.INVALID_TRANSITION,
        'That account is not suspended.',
      );
    }

    const { auditId } = await this.audit.mutate(
      {
        action: 'member.reactivated',
        targetType: 'MEMBER',
        targetId: id,
        before: { status: member.status, suspensionId: active?.id ?? null },
        after: { status: UserAccountStatus.ACTIVE },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
      },
      async tx => {
        if (active) {
          // Lifted *by somebody*, which is what tells this apart from the expiry job — that one
          // sets `liftedAt` and leaves `liftedById` null on purpose.
          await tx.suspension.update({
            where: { id: active.id },
            data: { liftedAt: new Date(), liftedById: this.actorId(), liftReason: reason.note },
          });
        }

        await tx.user.update({
          where: { id },
          data: { status: UserAccountStatus.ACTIVE, suspendedUntil: null },
        });

        return true;
      },
    );

    this.tellMember(id, {
      outcome: 'APPROVED',
      title: 'Your Circl account is active again',
      body: reason.note ?? 'You can sign in as usual.',
    });

    return { data: await this.members.detail(id), auditId };
  }

  /**
   * Where the member stands on strikes, and whether the portal should prompt for a suspension.
   *
   * Public because every decide path reports it back (§5.9's decide response) and the threshold is
   * configuration — a second place reading `safety.suggestSuspensionAtStrikes` is a second place
   * that can be changed and missed.
   */
  async strikeStanding(
    userId: string,
  ): Promise<{ authorActiveStrikes: number; suggestSuspension: boolean }> {
    const threshold = await this.config.get(SYSTEM_CONFIG_KEYS.SUGGEST_SUSPENSION_AT_STRIKES);
    const activeStrikes = await this.enforcement.activeStrikeCount(userId);

    return { authorActiveStrikes: activeStrikes, suggestSuspension: activeStrikes >= threshold };
  }

  /**
   * Records a strike and tells the member.
   *
   * A warning *is* a strike plus a notification — the same row, the difference being whether
   * anybody told them — so `notifiedAt` is set here and nowhere else. The returned
   * `suggestSuspension` is a prompt and never an action: nothing on this platform suspends itself.
   */
  async warn(id: string, dto: WarnMemberDto) {
    await this.policy.assertIsMember(id);

    const reason = dto.assertReasoned();
    const expiryDays = await this.config.get(SYSTEM_CONFIG_KEYS.STRIKE_EXPIRY_DAYS);
    const threshold = await this.config.get(SYSTEM_CONFIG_KEYS.SUGGEST_SUSPENSION_AT_STRIKES);

    const { result, auditId } = await this.audit.mutate(
      (created: { id: string }) => ({
        action: 'member.warned',
        targetType: 'MEMBER',
        targetId: id,
        after: { strikeId: created.id, message: dto.message ?? null },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
        metadata: {
          sourceType: dto.sourceType ?? EnforcementSourceType.MANUAL,
          sourceId: dto.sourceId ?? null,
        },
      }),
      async tx =>
        tx.strike.create({
          data: {
            userId: id,
            reasonCode: reason.reasonCode,
            policySubtype: reason.policySubtype,
            note: dto.message ?? reason.note,
            sourceType: dto.sourceType ?? EnforcementSourceType.MANUAL,
            sourceId: dto.sourceId ?? null,
            sourceTargetType: dto.sourceTargetType ?? null,
            issuedById: this.actorId(),
            expiresAt: new Date(Date.now() + expiryDays * 86_400_000),
            notifiedAt: new Date(),
          },
          select: { id: true },
        }),
    );

    void result;

    this.tellMember(id, {
      outcome: 'REJECTED',
      title: 'A warning about your Circl account',
      body: dto.message ?? 'Something you posted broke our community guidelines.',
    });

    const activeStrikes = await this.enforcement.activeStrikeCount(id);

    return {
      data: { activeStrikes, suggestSuspension: activeStrikes >= threshold },
      auditId,
    };
  }

  /** Withdraws a strike. The row stays: that it was issued and then withdrawn is part of the account. */
  async revokeStrike(id: string, strikeId: string, dto: ReasonOnlyDto) {
    await this.policy.assertIsMember(id);

    const reason = dto.assertReasoned();
    const strike = await this.database.strike.findFirst({
      where: { id: strikeId, userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
    });

    // A strike that has already been withdrawn, or has expired, is not one there is anything left
    // to do to — and a 404 says that without telling a caller probing ids which case it was.
    if (!strike) throw ApiException.notFound('No such live strike.');

    const { auditId } = await this.audit.mutate(
      {
        action: 'member.strike_revoked',
        targetType: 'MEMBER',
        targetId: id,
        before: { strikeId, revokedAt: null },
        after: { strikeId, revokedAt: new Date().toISOString() },
        reasonCode: reason.reasonCode,
        policySubtype: reason.policySubtype,
        reason: reason.note,
      },
      async tx =>
        tx.strike.update({
          where: { id: strikeId },
          data: { revokedAt: new Date(), revokedById: this.actorId(), revokeReason: reason.note },
        }),
    );

    const updated = await this.database.strike.findUniqueOrThrow({ where: { id: strikeId } });

    return {
      data: {
        id: updated.id,
        reasonCode: updated.reasonCode,
        policySubtype: updated.policySubtype,
        note: updated.note,
        issuedAt: updated.issuedAt.toISOString(),
        expiresAt: updated.expiresAt.toISOString(),
        active: false,
        revokedAt: updated.revokedAt?.toISOString() ?? null,
      },
      auditId,
    };
  }

  // ─── Data ──────────────────────────────────────────────────────────────────

  /** Starts the member's own data export on their behalf, through the member service. */
  async dataExport(id: string, dto: ReasonOnlyDto) {
    await this.policy.assertIsMember(id);

    const reason = dto.assertReasoned();

    await this.exports.request(id);

    const auditId = await this.audit.record(this.database, {
      action: 'member.data_export_triggered',
      targetType: 'MEMBER',
      targetId: id,
      reasonCode: reason.reasonCode,
      policySubtype: reason.policySubtype,
      reason: reason.note,
    });

    return { data: { state: 'PENDING' as const }, auditId };
  }

  /**
   * Destroys a member's personal data, on their behalf.
   *
   * Irreversible, so the confirmation is typed rather than clicked: the username — or the id where
   * there is none — has to be sent in the body and match. A dialog with a button is dismissed by
   * muscle memory; a name has to be read off the page first.
   *
   * The audit entry is written **before** the destruction, in its own statement, because afterwards
   * there is no row to describe: the entry holds the masked address and its hash, which is the only
   * remaining way to answer "whose account was this".
   */
  async anonymise(id: string, dto: AnonymiseMemberDto) {
    await this.policy.assertIsMember(id);

    const reason = dto.assertReasoned();
    const member = await this.database.user.findUniqueOrThrow({
      where: { id },
      select: { username: true, email: true },
    });

    const expected = member.username ?? id;

    if (dto.confirmUsername !== expected) {
      throw ApiException.unprocessable(
        ApiErrorCode.CONFIRMATION_MISMATCH,
        'That does not match. Type the username exactly.',
        { details: [{ field: 'confirmUsername', message: `Expected ${expected}.` }] },
      );
    }

    const auditId = await this.audit.record(this.database, {
      action: 'member.anonymised',
      targetType: 'MEMBER',
      targetId: id,
      before: {
        username: member.username,
        email: { masked: maskEmail(member.email), sha256: contactHash(member.email) },
      },
      reasonCode: reason.reasonCode,
      policySubtype: reason.policySubtype,
      reason: reason.note,
    });

    await this.deletion.anonymiseOnBehalf(id);

    return { data: { anonymised: true as const }, auditId };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** When the suspension ends, from a named duration or an explicit date. */
  private endOfSuspension(dto: SuspendMemberDto): Date | null {
    if (dto.duration === 'custom') {
      if (!dto.until) {
        throw ApiException.badRequest(
          ApiErrorCode.VALIDATION_FAILED,
          'A custom suspension needs an end date.',
          { details: [{ field: 'until', message: 'Required when duration is custom.' }] },
        );
      }

      const until = new Date(dto.until);

      if (until.getTime() <= Date.now()) {
        throw ApiException.badRequest(ApiErrorCode.VALIDATION_FAILED, 'That end is in the past.', {
          details: [{ field: 'until', message: 'Must be in the future.' }],
        });
      }

      return until;
    }

    const span = DURATION_MS[dto.duration];

    return span === null ? null : new Date(Date.now() + span);
  }

  private suspensionMessage(endsAt: Date | null, note: string | null): string {
    const when = endsAt
      ? `It ends on ${endsAt.toISOString().slice(0, 10)}.`
      : 'It does not have an end date.';

    return [note, when, 'Reply in your Circl support thread if you think this is wrong.']
      .filter(Boolean)
      .join(' ');
  }

  /**
   * Tells the member, in the app and by email, through the one category they cannot mute.
   *
   * Fire and forget: a notification that fails must not fail the enforcement it describes, and a
   * suspension half-applied because an email bounced is worse than a suspension nobody was told
   * about — which the audit entry records either way.
   */
  /**
   * The in-app notice a member gets about something staff did (§7.3's reporter outcome, and the
   * warning and suspension notices). Public because the report case path tells reporters the
   * same way, and a second notification shape for the same kind of message would drift.
   */
  notifyMember(userId: string, message: MemberNotice): void {
    this.tellMember(userId, message);
  }

  /**
   * One envelope for everything staff tell a member about their account.
   *
   * `route` is the caller's to set, and most of these do not set one. It used to be hardcoded to
   * `/support` for all of them, which was a route the app does not have: `NotificationDestination`
   * resolves an unknown path to nothing, so every one of these rows marked itself read and went
   * nowhere. A dead default is worse than none, because it reads at the call site as though a
   * destination had been thought about.
   *
   * So: nothing by default, and a route only where there is something at the other end to do. A
   * warning, a suspension and an appeal outcome are all read in the row itself — the appeal route
   * is an email (§13.3), not a screen — and a row that opens nothing is the honest rendering of
   * that. The listing rows are the exception, and they say where they go.
   */
  private tellMember(userId: string, message: MemberNotice): void {
    this.notifications.raise({
      userId,
      kind: NotificationKind.MODERATION,
      categoryCode: 'ACCOUNT',
      title: message.title,
      body: message.body,
      route: message.route ?? null,
      outcome: message.outcome ?? null,
    });
  }

  /**
   * Who is acting, from the request context.
   *
   * Read here rather than passed down, for the same reason the audit service reads it: a parameter
   * is a parameter a caller can get wrong, and the one that forgets records an enforcement nobody
   * is named for. Throws rather than writing null — every one of these actions has a person behind
   * it, and a strike issued by nobody is not reviewable.
   */
  private actorId(): string {
    const actorId = adminContext.current()?.actorId;

    if (!actorId) {
      // Not reachable through the guard stack, which establishes the context before any handler
      // runs. Thrown rather than written as null so that if it ever becomes reachable the action
      // fails loudly instead of recording an enforcement nobody is named for.
      throw new Error('No staff member in context for this action.');
    }

    return actorId;
  }
}

/** What a section hands over when staff have something to tell a member about their account. */
interface MemberNotice {
  title: string;
  body: string;
  /** Where it opens, for the few that have somewhere. Nothing means the row is the whole message. */
  route?: string | null;
  /**
   * Whether the decision went their way, for the notices that report one.
   *
   * Without it every one of these is `kind: MODERATION` and a client can only tell an approval
   * from a refusal by reading our wording, which is a contract nobody agreed to and copy editing
   * breaks.
   */
  outcome?: NotificationOutcome | null;
}

/** The profile columns an edit can touch, and therefore the ones a `before` has to read. */
const PROFILE_FIELDS = {
  cityId: true,
  gender: true,
  dateOfBirth: true,
  countryOfOriginCode: true,
  heritageTag: true,
  journeyStage: true,
  languages: true,
  interests: true,
  headline: true,
  bio: true,
  canHelpWith: true,
  phoneNumberDiallingCode: true,
  phoneNumber: true,
} satisfies Prisma.UserProfileSelect;
