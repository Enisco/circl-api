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
import {
  CityCompatMiddleware,
  ReportCompatMiddleware,
  TaxonomyCompatMiddleware,
} from '@/modules/platform/shared';
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
    // Spec 0.14.
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'default', limit: RATE_LIMITS.READ.limit, ttl: RATE_LIMITS.READ.ttl },
        // A second window, used only by messaging (5.7).
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
