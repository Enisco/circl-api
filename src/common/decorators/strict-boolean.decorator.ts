import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean } from 'class-validator';

/**
 * A boolean that will not quietly become `true`.
 *
 * The global pipe runs with `enableImplicitConversion: true`, which is what makes `?page=2` arrive
 * as a number. For a declared `boolean` it means class-transformer applies JavaScript truthiness,
 * and **every non-empty string is true**:
 *
 * ```
 * { openInbox: "false" } → true
 * { openInbox: "no" }    → true
 * { openInbox: "0" }     → true
 * ```
 *
 * On a privacy toggle that is the wrong failure in the worst direction: a client sending the string
 * `"false"` — from form state, a URL-encoded body, a template that stringified a flag — **opens**
 * an inbox the member asked to close, with a 200 and nothing to notice.
 *
 * So this accepts a real boolean, and the two strings a JSON client plausibly sends for one, and
 * refuses everything else by name. `"yes"`, `"0"` and `"maybe"` are mistakes worth being told
 * about rather than guessed at.
 *
 * Use it for any body field where being wrong matters more than being lenient. `@ToBoolean()`
 * remains the right decorator for **query strings**, where `?mine=true` is the only shape there is
 * and a caller has no way to send a real boolean.
 */
export const StrictBoolean = () =>
  applyDecorators(
    // Reads the **raw** value off the source object rather than the `value` argument.
    //
    // With `enableImplicitConversion` the conversion happens before `@Transform` runs, so `value`
    // is already `true` by the time this sees it — a first version of this decorator checked
    // `typeof value === 'boolean'`, found a boolean, passed it straight through, and changed
    // nothing at all. `obj[key]` is what the client actually sent.
    Transform(({ obj, key }) => {
      const raw = (obj as Record<string, unknown>)?.[key];

      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;

      // Returned unchanged so `@IsBoolean` refuses it and names the field. Mapping it to a
      // boolean here — either one — is how the original bug worked.
      return raw;
    }),
    IsBoolean(),
  );
