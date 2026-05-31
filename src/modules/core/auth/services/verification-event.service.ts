import { UserLoginOtpEvent, EventBusService } from '@/modules/infrastructure/events';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Util } from '@/common';
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
    const code = Util.generateOtp(4);
    const hashedCode = await Util.generateHash(code);

    await this.cache.set(OTP_CACHE_KEY(email), hashedCode, ttl);

    this.eventBus.publish(
      new UserLoginOtpEvent(email, email, firstName ?? email.split('@')[0], code),
    );
  }
}
