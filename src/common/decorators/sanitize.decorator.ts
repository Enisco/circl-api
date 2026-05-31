import { Transform } from 'class-transformer';
import * as xss from 'xss';

/**
 * Trims whitespace then strips all XSS vectors from a string field.
 * Non-string values are passed through unchanged.
 */
export const Sanitize = () =>
  Transform(({ value }) => {
    if (typeof value !== 'string') return value;

    return xss.filterXSS(value.trim());
  });
