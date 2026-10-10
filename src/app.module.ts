import { MiddlewareConsumer, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  DeviceInfoMiddleware,
  CommonModule,
  CustomThrottlerGuard,
  IdempotencyInterceptor,
  RATE_LIMITS,
} from '@/common';
import { MODULES } from '@/modules';
import {
  CityCompatMiddleware,
  ReportCompatMiddleware,
  TaxonomyCompatMiddleware,
} from '@/modules/platform/shared';
import { configValidationSchema } from '@/config';
import { AppCacheModule, AppLoggerModule, AppQueueModule, PrismaModule } from '@/infrastructure';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
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
    // Spec 0.14.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          { name: 'default', limit: RATE_LIMITS.READ.limit, ttl: RATE_LIMITS.READ.ttl },
          // A second window, used only by messaging (5.7).
          { name: 'secondary', limit: 100_000, ttl: 3_600_000 },
        ],
        // Counted in Redis, not in the process.
        //
        // In memory, every instance kept its own tally, so a limit of five was five per instance —
        // and every tally reset on deploy. A login lockout that a redeploy clears is not a lockout,
        // and it is the control standing between a leaked staff password and the account (B10).
        storage: new ThrottlerStorageRedisService(config.getOrThrow<string>('REDIS_URL')),
      }),
    }),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
    {
      // Honours Idempotency-Key on the creates that declare @Idempotent() (0.12).
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(DeviceInfoMiddleware, CityCompatMiddleware, TaxonomyCompatMiddleware)
      .forRoutes('*');
    // Only the report sheet sends these names, so the rewrite is scoped to the one route.
    consumer.apply(ReportCompatMiddleware).forRoutes('api/v1/moderation/reports');
  }
}
