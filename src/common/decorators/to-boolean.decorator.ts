import { Transform } from 'class-transformer';

/**
 * A query-string boolean.
 *
 * `enableImplicitConversion` coerces a declared `boolean` with `Boolean(value)`, and
 * `Boolean('false')` is true, so `?flag=false` switched the filter ON. Reading the raw value off
 * the source object side-steps the conversion, which is the only place the original string
 * survives.
 */
export const ToBoolean = () =>
  Transform(({ obj, key }) => {
    const raw = (obj as Record<string, unknown> | undefined)?.[key];

    if (raw === undefined || raw === null || raw === '') return undefined;

    return raw === true || raw === 'true' || raw === 1 || raw === '1';
  });
