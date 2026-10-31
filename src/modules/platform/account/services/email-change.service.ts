import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, OTP_LENGTH, Util } from '@/common';
import { EventBusService, UserLoginOtpEvent } from '@/modules/infrastructure/events';
import { ChangeEmailDto, ConfirmEmailChangeDto } from '../dtos/account.dto';
import { AccountDeletionService } from './account-deletion.service';

/** The same TTL and attempt ceiling as the sign-in code, rather than a second set of rules. */
const CODE_TTL_SECONDS = 600;
const MAX_ATTEMPTS = 5;

/**
 * Changing a sign-in address verifies the new one before the old one is released (G10), so it is
 * two calls. It deliberately does not touch the session: throwing a member out mid-flow for
 * changing their email is a worse outcome than the one it would be guarding against.
 */
@Injectable()
export class EmailChangeService {
  constructor(
    private readonly database: PrismaService,
    private readonly eventBus: EventBusService,
    private readonly deletion: AccountDeletionService,
  ) {}

  async request(userId: string, dto: ChangeEmailDto) {
    const user = await this.database.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, firstName: true },
    });

    if (!user) throw ApiException.notFound('That account could not be found.');

    if (user.email.toLowerCase() === dto.newEmail) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'That is already the address on your account.',
        { details: [{ field: 'newEmail', message: 'This is already your address.' }] },
      );
    }

    const taken = await this.database.user.findFirst({
      where: { email: dto.newEmail, id: { not: userId } },
      select: { id: true },
    });

    if (taken) {
      throw ApiException.conflict(
        ApiErrorCode.EMAIL_TAKEN,
        'That address is already in use on another account.',
      );
    }

    // An address that belonged to a deleted account is refused here for the same reason
    // registration refuses it (0.15.3): a one-way hash of it is kept so the deletion cannot be
    // undone by claiming the address again, and allowing it in through this door would be the
    // same takeover by a longer route.
    if (await this.deletion.isDeletedEmail(dto.newEmail)) {
      throw ApiException.conflict(
        ApiErrorCode.EMAIL_TAKEN,
        'That address cannot be used on Circl.',
      );
    }

    const code = Util.generateOtp(OTP_LENGTH);
    const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);

    // Only one change can be in flight, so a second request replaces the first rather than
    // leaving two codes that both work.
    await this.database.emailChangeRequest.deleteMany({ where: { userId, confirmedAt: null } });
    await this.database.emailChangeRequest.create({
      data: { userId, newEmail: dto.newEmail, codeHash: await Util.generateHash(code), expiresAt },
    });

    // The code goes to the NEW address: it is the one being proved.
    this.eventBus.publish(
      new UserLoginOtpEvent(dto.newEmail, dto.newEmail, user.firstName ?? 'there', code),
    );

    return {
      data: { newEmail: dto.newEmail, expiresInSeconds: CODE_TTL_SECONDS },
      message: `We have sent a code to ${dto.newEmail}. Enter it to finish the change.`,
    };
  }

  async confirm(userId: string, dto: ConfirmEmailChangeDto) {
    const pending = await this.database.emailChangeRequest.findFirst({
      where: { userId, confirmedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!pending) {
      throw ApiException.notFound('There is no email change waiting to be confirmed.');
    }

    if (pending.expiresAt <= new Date()) {
      throw ApiException.gone(ApiErrorCode.CODE_EXPIRED, 'That code has expired. Ask for another.');
    }

    if (pending.attempts >= MAX_ATTEMPTS) {
      throw ApiException.rateLimited(
        ApiErrorCode.RATE_LIMITED,
        'Too many attempts. Ask for a new code.',
      );
    }

    const valid = await Util.validateHash(dto.code, pending.codeHash);

    if (!valid) {
      // A wrong code is not free, or the six digits are guessable.
      await this.database.emailChangeRequest.update({
        where: { id: pending.id },
        data: { attempts: { increment: 1 } },
      });

      throw ApiException.badRequest(ApiErrorCode.INVALID_CODE, 'That code is wrong.', {
        details: [{ field: 'code', message: 'Wrong code.' }],
      });
    }

    // Re-checked at the last moment: the address may have been claimed while the code sat unused.
    const taken = await this.database.user.findFirst({
      where: { email: pending.newEmail, id: { not: userId } },
      select: { id: true },
    });

    if (taken) {
      throw ApiException.conflict(
        ApiErrorCode.EMAIL_TAKEN,
        'That address was taken while you were confirming. Try another.',
      );
    }

    const user = await this.database.$transaction(async tx => {
      await tx.emailChangeRequest.update({
        where: { id: pending.id },
        data: { confirmedAt: new Date() },
      });

      return tx.user.update({
        where: { id: userId },
        data: {
          email: pending.newEmail,
          // The code that just arrived proves this address, so the account's verified state is
          // about the new one. Left alone, a member who changed address kept whatever the old one
          // had — which is a verified flag about an inbox nobody has proved, and the deletion and
          // export flows both read it before they promise somebody an email.
          userAuth: {
            upsert: {
              create: { emailVerifiedAt: new Date() },
              update: { emailVerifiedAt: new Date() },
            },
          },
        },
        select: { id: true, email: true, firstName: true, lastName: true, username: true },
      });
    });

    return { data: user, message: 'Your sign-in address has been changed.' };
  }
}
