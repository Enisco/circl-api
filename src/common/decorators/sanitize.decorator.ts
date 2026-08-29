import { Transform } from 'class-transformer';
import * as xss from 'xss';

/** Trims whitespace then strips all XSS vectors from a string field. */
export const Sanitize = () =>
  Transform(({ value }) => {
    if (typeof value !== 'string') return value;

    return xss.filterXSS(value.trim());
  });
