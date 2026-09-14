import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { TaxonomyKind } from '@prisma/client';
import { NextFunction, Request, Response } from 'express';
import { countryCodeFromName } from '../serializers/country.serializer';
import { TaxonomyService } from '../services';

/**
 * Profile fields whose names are unique across the API, so a value can be resolved against one
 * vocabulary without knowing the route. Ambiguous names like `categoryCode`, which means a
 * different vocabulary in Community and Commerce, are deliberately absent.
 */
const FIELDS: Record<string, TaxonomyKind> = {
  heritageTag: TaxonomyKind.HERITAGE_TAG,
  journeyStage: TaxonomyKind.JOURNEY_STAGE,
  gender: TaxonomyKind.GENDER,
  interests: TaxonomyKind.INTEREST,
  languages: TaxonomyKind.LANGUAGE,
};

/**
 * The 0.7 shim: the shipped client's pickers send labels, so `countryOfOrigin: "Nigeria"` arrives
 * where `NG` is expected. Keys off the value, so a client already sending codes is untouched.
 * Delete once the pickers hold codes; every rewrite is logged, so the logs say when.
 */
@Injectable()
export class TaxonomyCompatMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TaxonomyCompatMiddleware.name);

  constructor(private readonly taxonomy: TaxonomyService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as Record<string, unknown> | undefined;

      if (body && typeof body === 'object' && !Array.isArray(body)) {
        // Countries are not a vocabulary we keep, so they resolve against ICU rather than a kind.
        if (typeof body.countryOfOrigin === 'string') {
          const resolved = countryCodeFromName(body.countryOfOrigin);

          if (resolved && resolved !== body.countryOfOrigin) {
            this.logger.log(`Deprecated countryOfOrigin value: "${body.countryOfOrigin}" -> ${resolved}`);
            body.countryOfOrigin = resolved;
          }
        }

        for (const [field, kind] of Object.entries(FIELDS)) {
          const value = body[field];

          if (typeof value === 'string') {
            body[field] = await this.rewrite(kind, value, field);
          } else if (Array.isArray(value)) {
            body[field] = await Promise.all(
              value.map(entry =>
                typeof entry === 'string' ? this.rewrite(kind, entry, field) : entry,
              ),
            );
          }
        }
      }
    } catch (error) {
      // A lookup must never be the reason a request fails. An unresolved value falls through to
      // the normal validation, which rejects it with a message naming the field.
      this.logger.warn(`Taxonomy compatibility resolution skipped: ${(error as Error).message}`);
    }

    next();
  }

  private async rewrite(kind: TaxonomyKind, value: string, field: string): Promise<string> {
    if (!value.trim()) return value;

    const resolved = await this.taxonomy.resolveCode(kind, value);

    if (!resolved || resolved === value) return value;

    this.logger.log(`Deprecated ${field} value: "${value}" -> ${resolved}`);

    return resolved;
  }
}
