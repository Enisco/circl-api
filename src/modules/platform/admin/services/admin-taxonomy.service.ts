import { Injectable } from '@nestjs/common';
import { RiskCategory, TaxonomyKind } from '@prisma/client';
import { PrismaService } from '@/infrastructure';
import { ApiErrorCode, ApiException, buildPageMeta, toJsonOrUndefined } from '@/common';
import { TaxonomyService } from '../../shared';
import { ListRiskTermsDto, UpsertRiskTermDto, UpsertTaxonomyTermDto } from '../dtos/admin.dto';

/**
 * Taxonomy and lexicon administration.
 *
 * This is what makes two of the spec's promises real rather than aspirational:
 * "reword a label without an app release" (0.8), and Guard's lexicon being
 * editable the moment safeguarding staff see a phrase used rather than at the
 * next deploy.
 *
 * Every write bumps the taxonomy version, which is what invalidates the caches in
 * every running process and the ETag the client is holding.
 */
@Injectable()
export class AdminTaxonomyService {
  constructor(
    private readonly database: PrismaService,
    private readonly taxonomy: TaxonomyService,
  ) {}

  async list(kind: TaxonomyKind) {
    const terms = await this.database.taxonomyTerm.findMany({
      where: { kind },
      orderBy: { sort: 'asc' },
    });

    return terms.map(term => ({
      id: term.id,
      kind: term.kind,
      code: term.code,
      label: term.label,
      description: term.description,
      sort: term.sort,
      isActive: term.isActive,
      metadata: term.metadata,
      updatedAt: term.updatedAt.toISOString(),
    }));
  }

  async upsert(dto: UpsertTaxonomyTermDto) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(dto.code)) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        'A code must be UPPER_SNAKE.',
        { details: [{ field: 'code', message: 'Use UPPER_SNAKE, e.g. AIRPORT_PICKUP.' }] },
      );
    }

    const term = await this.database.taxonomyTerm.upsert({
      where: { kind_code: { kind: dto.kind, code: dto.code } },
      update: {
        label: dto.label,
        description: dto.description ?? null,
        ...(dto.sort !== undefined ? { sort: dto.sort } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.metadata !== undefined ? { metadata: toJsonOrUndefined(dto.metadata) } : {}),
      },
      create: {
        kind: dto.kind,
        code: dto.code,
        label: dto.label,
        description: dto.description ?? null,
        sort: dto.sort ?? 0,
        isActive: dto.isActive ?? true,
        metadata: toJsonOrUndefined(dto.metadata),
      },
    });

    // Bumps the version stamp, which invalidates every process's cache and the
    // client's ETag in one write.
    const version = await this.taxonomy.bumpVersion();

    return { term, version: version.toISOString() };
  }

  /**
   * Deactivates rather than deletes.
   *
   * Content already carries this code. Deleting the term would leave rows
   * pointing at a label that no longer exists, and the client would render a raw
   * code to a member.
   */
  async deactivate(kind: TaxonomyKind, code: string) {
    const term = await this.database.taxonomyTerm.findUnique({
      where: { kind_code: { kind, code } },
    });

    if (!term) throw ApiException.notFound('That term could not be found.');

    await this.database.taxonomyTerm.update({
      where: { id: term.id },
      data: { isActive: false },
    });

    const version = await this.taxonomy.bumpVersion();

    return { kind, code, isActive: false, version: version.toISOString() };
  }

  // ─── Guard lexicon ─────────────────────────────────────────────────────────

  async listRiskTerms(query: ListRiskTermsDto) {
    const [total, rows] = await this.database.$transaction([
      this.database.riskTerm.count(),
      this.database.riskTerm.findMany({
        orderBy: [{ category: 'asc' }, { weight: 'desc' }],
        skip: query.skip,
        take: query.take,
      }),
    ]);

    return {
      data: rows.map(row => ({
        id: row.id,
        category: row.category,
        pattern: row.pattern,
        weight: row.weight,
        isActive: row.isActive,
        updatedAt: row.updatedAt.toISOString(),
      })),
      meta: buildPageMeta(query, total),
    };
  }

  async upsertRiskTerm(dto: UpsertRiskTermDto) {
    if (!Object.values(RiskCategory).includes(dto.category as RiskCategory)) {
      throw ApiException.unprocessable(
        ApiErrorCode.VALIDATION_FAILED,
        `"${dto.category}" is not a risk category.`,
        { details: [{ field: 'category', message: 'Not a valid risk category.' }] },
      );
    }

    const pattern = dto.pattern.toLowerCase().trim();

    const term = await this.database.riskTerm.upsert({
      where: { category_pattern: { category: dto.category as RiskCategory, pattern } },
      update: {
        ...(dto.weight !== undefined ? { weight: dto.weight } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      create: {
        category: dto.category as RiskCategory,
        pattern,
        weight: dto.weight ?? 10,
        isActive: dto.isActive ?? true,
      },
    });

    // The scanner reloads within its own short TTL, so a phrase added now is
    // matching within a couple of minutes — not at the next deploy.
    return {
      id: term.id,
      category: term.category,
      pattern: term.pattern,
      weight: term.weight,
      isActive: term.isActive,
    };
  }

  async removeRiskTerm(id: string) {
    const term = await this.database.riskTerm.findUnique({ where: { id } });

    if (!term) throw ApiException.notFound('That term could not be found.');

    // Deactivated rather than deleted, so a phrase staff turned off stays off
    // through the next seed run.
    await this.database.riskTerm.update({ where: { id }, data: { isActive: false } });

    return { id, isActive: false };
  }
}
