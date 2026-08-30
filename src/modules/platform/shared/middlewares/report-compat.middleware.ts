import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

/**
 * The report sheet names its fields `subjectType` / `subjectId` / `reason` / `detail`; the spec
 * names them `targetType` / `targetId` / `reasonCode` / `note`. Renaming either side would break
 * the other, and a report that 400s is a report nobody files twice.
 *
 * It runs here rather than as a `@Transform` on the DTO because class-transformer only fires a
 * property's transform when that property is present in the payload, so a transform on
 * `targetType` never runs for a body that only carries `subjectType`.
 */
const FIELD_ALIASES: Record<string, string> = {
  subjectType: 'targetType',
  subjectId: 'targetId',
  reason: 'reasonCode',
  detail: 'note',
};

/** The sheet's subject names, where they differ from the stored target types. */
const TARGET_ALIASES: Record<string, string> = {
  POST: 'UPDATE',
  ITEM: 'STORE_ITEM',
  PROFESSIONAL: 'PROFESSIONAL_LISTING',
  PROFILE: 'USER',
};

/** The sheet's chips, where they differ from the stored reasons. */
const REASON_ALIASES: Record<string, string> = {
  SAFETY: 'SAFETY_CONCERN',
  INAPPROPRIATE_CONTENT: 'INAPPROPRIATE',
};

@Injectable()
export class ReportCompatMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const body = req.body as Record<string, unknown> | undefined;

    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const [from, to] of Object.entries(FIELD_ALIASES)) {
        // The spec name wins when both are sent, so a caller using it is never second-guessed.
        if (body[to] === undefined && body[from] !== undefined) body[to] = body[from];

        delete body[from];
      }

      if (typeof body.targetType === 'string') {
        body.targetType = TARGET_ALIASES[body.targetType] ?? body.targetType;
      }

      if (typeof body.reasonCode === 'string') {
        body.reasonCode = REASON_ALIASES[body.reasonCode] ?? body.reasonCode;
      }

      // Sending an id to block is the same intent the boolean used to carry.
      if (typeof body.blockUserId === 'string' && body.alsoBlock === undefined) {
        body.alsoBlock = true;
      }
    }

    next();
  }
}
