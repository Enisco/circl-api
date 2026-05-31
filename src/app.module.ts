import { MiddlewareConsumer, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DeviceInfoMiddleware, CommonModule, CustomThrottlerGuard } from '@/common';
import { MODULES } from '@/modules';
import { configValidationSchema } from '@/config';
import { AppCacheModule, AppLoggerModule, AppQueueModule, PrismaModule } from '@/infrastructure';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

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
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          limit: 100,
          ttl: 60000, // 1 minute
        },
      ],
    }),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(DeviceInfoMiddleware).forRoutes('*');
  }
}
