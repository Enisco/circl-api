import { getLoggerConfig } from './logger.config';
import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Global()
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: configService => getLoggerConfig(configService),
    }),
  ],
  exports: [LoggerModule],
})
export class AppLoggerModule {}
