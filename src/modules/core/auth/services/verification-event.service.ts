import { UserLoginOtpEvent, EventBusService } from '@/modules/infrastructure/events';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { OTP_LENGTH, Util } from '@/common';
import { CacheService } from '@/infrastructure';

export const OTP_CACHE_KEY = (email: string) => `auth-otp-${email}`;

@Injectable()
export class VerificationEventService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly cache: CacheService,
    private readonly eventBus: EventBusService,
  ) {
    this.logger.setContext(VerificationEventService.name);
  }

  async sendVerificationOtp(email: string, firstName?: string | null, ttl: number = 60 * 10) {
    // Six, like every other code this API sends. It was four here alone, which gave a sign-in
    // code a hundredth of the keyspace of the one that confirms an email change — the weaker
    // factor guarding the larger thing.
    const code = Util.generateOtp(OTP_LENGTH);
    const hashedCode = await Util.generateHash(code);

    await this.cache.set(OTP_CACHE_KEY(email), hashedCode, ttl);

    this.eventBus.publish(
      new UserLoginOtpEvent(email, email, firstName ?? email.split('@')[0], code),
    );
  }
}
