import { PrismaService } from '@/infrastructure';
import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { HealthCheckService, HealthCheck, PrismaHealthIndicator } from '@nestjs/terminus';

@ApiExcludeController()
@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private prismaHealth: PrismaHealthIndicator,
    private prisma: PrismaService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([async () => this.prismaHealth.pingCheck('database', this.prisma)]);
  }
}
