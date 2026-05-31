import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CacheService } from '@/infrastructure';
import { EventBusService, UserForgotPasswordEvent } from '@/modules/infrastructure/events';
import { Util } from '@/common';
import { User } from '@prisma/client';
import { AdminVerificationType } from '../dtos';

@Injectable()
export class VerificationEventService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly cache: CacheService,
    private readonly eventBus: EventBusService,
  ) {
    this.logger.setContext(VerificationEventService.name);
  }

  async sendVerificationEmail(user: User, type: AdminVerificationType): Promise<void> {
    const code = await this.generateAndStoreCode(type, user.email);

    switch (type) {
      case AdminVerificationType.PASSWORD_RESET:
        this.eventBus.publish(
          new UserForgotPasswordEvent(user.id, user.email, user.firstName, code),
        );
        break;
    }
  }

  async generateAndStoreCode(
    type: AdminVerificationType,
    email: string,
    ttlSeconds = 600,
  ): Promise<string> {
    const code = Util.generateOtp(6);
    const hashed = await Util.generateHash(code);

    await this.cache.set(this.cacheKey(type, email), hashed, ttlSeconds);

    return code;
  }

  async validateCode(type: AdminVerificationType, email: string, input: string): Promise<boolean> {
    const hashed = await this.cache.get<string>(this.cacheKey(type, email));

    if (!hashed) return false;

    return Util.validateHash(input, hashed);
  }

  async deleteCode(type: AdminVerificationType, email: string): Promise<void> {
    await this.cache.delete(this.cacheKey(type, email));
  }

  private cacheKey(type: AdminVerificationType, email: string): string {
    return `admin_${type}_verification_${email}`;
  }
}
