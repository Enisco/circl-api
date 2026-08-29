import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { CityService } from '../services';

/** Every parameter across the API that carries a city. */
const CITY_FIELDS = ['cityId', 'city', 'cityIdOverride'] as const;

/**
 * The 1.0.3 compatibility shim, in one removable place.
 *
 * The shipped client sends a city NAME in `cityId`, so resolution keys off the
 * value rather than the parameter name. Delete this file once the app's pickers
 * hold ids.
 */
@Injectable()
export class CityCompatMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CityCompatMiddleware.name);

  constructor(private readonly cities: CityService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const query = { ...(req.query as Record<string, unknown>) };
      const rewrittenQuery = await this.rewrite(query, 'query');

      if (rewrittenQuery) {
        // Express 5 recomputes `req.query` on every access, so mutating what the getter returned is silently lost.
        Object.defineProperty(req, 'query', {
          value: query,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }

      if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
        await this.rewrite(req.body as Record<string, unknown>, 'body');
      }
    } catch (error) {
      // A city lookup must never be the reason a request fails.
      this.logger.warn(`City compatibility resolution skipped: ${(error as Error).message}`);
    }

    next();
  }

  /** Returns true when anything was rewritten. */
  private async rewrite(target: Record<string, unknown>, source: string): Promise<boolean> {
    let changed = false;

    for (const field of CITY_FIELDS) {
      const value = target[field];

      if (typeof value !== 'string' || !value.trim()) continue;

      // `city` is the deprecated spelling of the same thing, folded onto `cityId` so no handler has to know it ever existed.
      const destination = field === 'city' ? 'cityId' : field;

      if (field === 'city' && typeof target.cityId === 'string' && target.cityId.trim()) continue;

      const resolved = await this.cities.resolve(value);

      if (!resolved || target[destination] === resolved.id) continue;

      this.logger.log(`Deprecated city value in ${source}.${field}: "${value}" -> ${resolved.id}`);

      target[destination] = resolved.id;
      changed = true;
    }

    return changed;
  }
}
