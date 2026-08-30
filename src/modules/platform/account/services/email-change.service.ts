import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, Util } from '@/common';
import { EventBusService, UserLoginOtpEvent } from '@/modules/infrastructure/events';
import { ChangeEmailDto, ConfirmEmailChangeDto } from '../dtos/account.dto';

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

    const code = Util.generateOtp(6);
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
        data: { email: pending.newEmail },
        select: { id: true, email: true, firstName: true, lastName: true, username: true },
      });
    });

    return { data: user, message: 'Your sign-in address has been changed.' };
  }
}
