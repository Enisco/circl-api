import { MiddlewareConsumer, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  DeviceInfoMiddleware,
  CommonModule,
  CustomThrottlerGuard,
  IdempotencyInterceptor,
  RATE_LIMITS,
} from '@/common';
import { MODULES } from '@/modules';
import { configValidationSchema } from '@/config';
import { AppCacheModule, AppLoggerModule, AppQueueModule, PrismaModule } from '@/infrastructure';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: configValidationSchema,
      validationOptions: {
        abortEarly: true,
      },
    }),
    CommonModule,
    PrismaModule,
    AppCacheModule,
    AppLoggerModule,
    AppQueueModule,
    ...MODULES,
    // Spec 0.14. Each action class gets its own named bucket, so writing does
    // not eat a member's allowance to read. `default` is the backstop for
    // anything not explicitly classified.
    // Spec 0.14. Exactly two throttlers are registered, because every named
    // throttler applies to every route: a third bucket at 20-an-hour would cap
    // reads at 20 an hour too. `@RateLimit()` overrides these per route instead.
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'default', limit: RATE_LIMITS.READ.limit, ttl: RATE_LIMITS.READ.ttl },
        // A second window, used only by messaging (5.7). Effectively unlimited
        // until a route overrides it, so it never constrains anything else.
        { name: 'secondary', limit: 100_000, ttl: 3_600_000 },
      ],
    }),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
    {
      // Honours Idempotency-Key on the creates that declare @Idempotent() (0.12).
      // Registered here rather than in main.ts because it needs Prisma injected.
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(DeviceInfoMiddleware).forRoutes('*');
  }
}
