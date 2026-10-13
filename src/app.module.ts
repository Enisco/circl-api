import { MiddlewareConsumer, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  AppVersionInterceptor,
  DeviceInfoMiddleware,
  CommonModule,
  CustomThrottlerGuard,
  IdempotencyInterceptor,
  RATE_LIMITS,
} from '@/common';
import { MODULES, appSurface } from '@/modules';
import { MemberActivityInterceptor } from '@/modules/platform/intelligence';
import {
  CityCompatMiddleware,
  ReportCompatMiddleware,
  TaxonomyCompatMiddleware,
} from '@/modules/platform/shared';
import { configValidationSchema } from '@/config';
import { AppCacheModule, AppLoggerModule, AppQueueModule, PrismaModule } from '@/infrastructure';
import { ScheduleModule } from '@nestjs/schedule';
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
    // Registered once, here, rather than inside a feature module. The admin surface runs its own
    // scheduled work (ending suspensions) and does not import the platform jobs module, so a
    // registration living in there would mean an admin-only process had a cron decorator and no
    // scheduler to honour it — a suspension that never ends, and nothing in the logs about it.
    // Two `forRoot()` calls would register two schedulers and run every job twice.
    ScheduleModule.forRoot(),
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
    // Notes that a member was here, at most once every fifteen minutes. The source of every
    // active-user and retention number, and a day somebody was present cannot be recovered
    // afterwards — so it is recorded as it happens rather than derived later.
    //
    // Only where member routes are served. An admin-only process has no member requests to
    // count, and registering it there would mean depending on a module that process does not
    // have — which is the boundary telling the truth rather than getting in the way.
    ...(appSurface() === 'admin'
      ? []
      : [
          { provide: APP_INTERCEPTOR, useClass: MemberActivityInterceptor },
          // §5.21's force-update gate. Member routes only: a staff request carries no
          // `x-app-version`, and the portal is not a build anybody updates from a store.
          //
          // The app's own launch check is what should catch this; the interceptor is for the case
          // it does not — a client holding a stale policy, one that ignored the answer, or a build
          // old enough not to ask. It skips the paths a locked-out app still needs, and the crisis
          // lines are one of them.
          { provide: APP_INTERCEPTOR, useClass: AppVersionInterceptor },
        ]),
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    // All three read headers or rewrite parameters that only the member clients send. An
    // admin-only process serves none of those routes, so applying them there would be three
    // middlewares running on every staff request to do nothing.
    if (appSurface() === 'admin') return;

    consumer
      .apply(DeviceInfoMiddleware, CityCompatMiddleware, TaxonomyCompatMiddleware)
      .forRoutes('*');
    // Only the report sheet sends these names, so the rewrite is scoped to the one route.
    consumer.apply(ReportCompatMiddleware).forRoutes('api/v1/moderation/reports');
  }
}
