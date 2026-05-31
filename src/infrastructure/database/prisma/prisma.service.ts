import { Injectable, OnModuleInit, OnModuleDestroy, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class PrismaService
  extends PrismaClient<Prisma.PrismaClientOptions, 'query' | 'error' | 'warn'>
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  constructor(private readonly logger: PinoLogger) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    const adapter = new PrismaPg(pool as unknown as ConstructorParameters<typeof PrismaPg>[0]);

    super({
      adapter,
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });

    this.logger.setContext(PrismaService.name);
    this.setupLogging();
  }

  private setupLogging() {
    this.$on('query', (e: Prisma.QueryEvent) => {
      this.logger.debug({
        query: e.query,
        params: e.params,
        duration: `${e.duration}ms`,
        target: e.target,
      });
    });

    this.$on('error', (e: Prisma.LogEvent) => {
      this.logger.error({
        message: e.message,
        target: e.target,
        timestamp: e.timestamp,
      });
    });

    this.$on('warn', (e: Prisma.LogEvent) => {
      this.logger.warn({
        message: e.message,
        target: e.target,
        timestamp: e.timestamp,
      });
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.info('🔗 Successfully connected to the database');
    } catch (error) {
      this.logger.error('❌ Failed to connect to the database', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    try {
      await this.$disconnect();
      this.logger.info('Successfully disconnected from the database');
    } catch (error) {
      this.logger.error('Error disconnecting from the database', error);
      throw error;
    }
  }

  async onApplicationShutdown(signal?: string) {
    if (signal) {
      this.logger.info(`Received shutdown signal: ${signal}`);
    }
    await this.$disconnect();
  }

  async cleanDisconnect(): Promise<void> {
    await this.$disconnect();
  }
}
