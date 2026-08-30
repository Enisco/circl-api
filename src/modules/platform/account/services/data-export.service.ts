import { Injectable, Logger } from '@nestjs/common';
import { DataExportStatus } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException } from '@/common';

/** How long a built export stays downloadable. */
const AVAILABLE_FOR_DAYS = 7;

/**
 * A subject access request under UK GDPR (G9). The button used to show a confirm sheet and a
 * snackbar and request nothing, which under UK GDPR either works or should not be on the screen.
 */
@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(private readonly database: PrismaService) {}

  async request(userId: string) {
    const pending = await this.database.dataExportRequest.findFirst({
      where: { userId, status: DataExportStatus.PENDING },
      select: { id: true, requestedAt: true },
    });

    // A second tap queues nothing: one request is already working.
    if (pending) {
      throw ApiException.conflict(
        ApiErrorCode.EXPORT_ALREADY_PENDING,
        'We are already putting your data together. We will email you when it is ready.',
      );
    }

    const created = await this.database.dataExportRequest.create({
      data: { userId, status: DataExportStatus.PENDING },
      select: { id: true, status: true, requestedAt: true },
    });

    this.logger.log(`Data export ${created.id} requested`);

    return {
      data: {
        id: created.id,
        status: created.status,
        requestedAt: created.requestedAt.toISOString(),
      },
    };
  }

  /** The latest request, or null data when the member has never asked. */
  async latest(userId: string) {
    const row = await this.database.dataExportRequest.findFirst({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
    });

    if (!row) return { data: null };

    // Expiry is read at request time rather than written by a job, so a stale row cannot serve a
    // link that should have gone.
    const isExpired =
      row.status === DataExportStatus.READY && !!row.expiresAt && row.expiresAt <= new Date();

    return {
      data: {
        id: row.id,
        status: isExpired ? DataExportStatus.EXPIRED : row.status,
        requestedAt: row.requestedAt.toISOString(),
        readyAt: row.readyAt?.toISOString() ?? null,
        // Delivery is by emailed link, so this stays null and the client reports the status.
        downloadUrl: null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      },
    };
  }

  /** Marks a built export ready. Called by whatever assembles the archive. */
  async markReady(id: string, downloadKey: string) {
    const readyAt = new Date();

    await this.database.dataExportRequest.update({
      where: { id },
      data: {
        status: DataExportStatus.READY,
        downloadKey,
        readyAt,
        expiresAt: new Date(readyAt.getTime() + AVAILABLE_FOR_DAYS * 86_400_000),
      },
    });
  }
}
