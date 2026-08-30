import { OpenAPIObject } from '@nestjs/swagger';

const METHODS = ['get', 'post', 'patch', 'put', 'delete', 'head', 'options'] as const;

/** The envelope from spec 0.3, which `TransformResponseInterceptor` puts around every handler return. */
const ENVELOPE_SCHEMA = 'SuccessEnvelope';
const ERROR_SCHEMA = 'ErrorEnvelope';
const PAGE_META_SCHEMA = 'PageMeta';

/**
 * Every successful response in this API is wrapped by one interceptor, and every failure by one
 * filter. Documenting that per handler would mean 200 copies of the same decorator that drift the
 * moment one is forgotten, so it is applied to the finished document instead: whatever a handler
 * declared becomes `data`, and the wrapper around it is written once, here.
 */
export const applyResponseEnvelope = (document: OpenAPIObject): OpenAPIObject => {
  document.components = document.components ?? {};
  document.components.schemas = document.components.schemas ?? {};

  Object.assign(document.components.schemas, {
    [PAGE_META_SCHEMA]: {
      type: 'object',
      description: 'Present on every list response (spec 0.5).',
      properties: {
        currentPage: { type: 'integer', example: 1 },
        perPage: { type: 'integer', example: 20 },
        totalPages: { type: 'integer', example: 3 },
        totalCount: { type: 'integer', example: 47 },
        hasNextPage: { type: 'boolean', example: true },
        hasPreviousPage: { type: 'boolean', example: false },
      },
    },
    [ENVELOPE_SCHEMA]: {
      type: 'object',
      description: 'The success envelope. `data` holds the payload; list responses add `meta`.',
      required: ['success', 'status', 'message', 'data'],
      properties: {
        success: { type: 'boolean', example: true },
        status: { type: 'string', example: 'success' },
        message: { type: 'string', example: 'Operation successful' },
        data: { nullable: true, description: 'The payload. Null when there is nothing to return.' },
        meta: { $ref: `#/components/schemas/${PAGE_META_SCHEMA}` },
      },
    },
    [ERROR_SCHEMA]: {
      type: 'object',
      description:
        'The failure envelope (spec 0.4). `error.code` is the stable machine-readable code; ' +
        '`details` names the offending fields on a validation failure.',
      properties: {
        success: { type: 'boolean', example: false },
        status: { type: 'string', example: 'error' },
        message: { type: 'string', example: 'Write something before sending.' },
        data: { nullable: true, example: null },
        error: {
          type: 'object',
          properties: {
            code: { type: 'string', example: 'VALIDATION_FAILED' },
            errorType: { type: 'string', example: 'VALIDATION_FAILED' },
            message: { type: 'string', example: 'Write something before sending.' },
            details: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string', example: 'body' },
                  message: { type: 'string', example: 'This is required.' },
                },
              },
            },
          },
        },
      },
    },
  });

  for (const item of Object.values(document.paths)) {
    for (const method of METHODS) {
      const operation = (item as Record<string, any>)[method];

      if (!operation) continue;

      operation.responses = operation.responses ?? {};

      for (const [status, response] of Object.entries<any>(operation.responses)) {
        // 204 has no body by definition, and a handler that returns nothing should not claim one.
        if (status === '204') continue;

        if (Number(status) >= 400) {
          response.content = { 'application/json': { schema: { $ref: `#/components/schemas/${ERROR_SCHEMA}` } } };
          response.description = response.description || 'Failed';
          continue;
        }

        const declared = response.content?.['application/json']?.schema;

        response.description = response.description || 'Success';
        response.content = {
          'application/json': {
            schema: wrap(declared),
          },
        };
      }

      // Every route can fail the same three ways, and a client that has not seen the error
      // envelope writes its own guess at one.
      if (!operation.responses['400']) {
        operation.responses['400'] = errorResponse('Validation failed. `details` names the fields.');
      }

      if (operation.security?.length && !operation.responses['401']) {
        operation.responses['401'] = errorResponse('Missing, expired or revoked access token.');
      }
    }
  }

  return document;
};

/** Keeps whatever the handler declared, but puts it where the interceptor actually puts it. */
const wrap = (declared: unknown): Record<string, unknown> => {
  const envelope = { $ref: `#/components/schemas/${ENVELOPE_SCHEMA}` };

  if (!declared) return envelope;

  // An example written against the whole envelope already (the auth and profile routes do this)
  // is left alone rather than nested twice.
  const asSchema = declared as { example?: Record<string, unknown> };

  if (asSchema.example && ('status' in asSchema.example || 'data' in asSchema.example)) {
    return declared as Record<string, unknown>;
  }

  return { allOf: [envelope, { type: 'object', properties: { data: declared } }] };
};

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${ERROR_SCHEMA}` } } },
});
