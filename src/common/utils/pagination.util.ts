import { PageMeta } from '../types/response.type';

/**
 * Builds the `meta` block from spec 0.5.
 *
 * `totalPages` is 0 when there are no results — not 1 — because "page 1 of 1"
 * over an empty list reads as a bug to anyone debugging it.
 */
export const buildPageMeta = (
  options: { currentPage: number; perPage: number },
  totalCount: number,
  extra?: Record<string, unknown>,
): PageMeta => {
  const { perPage, currentPage } = options;
  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / perPage);

  return {
    currentPage,
    perPage,
    totalPages,
    totalCount,
    hasNextPage: currentPage < totalPages,
    hasPreviousPage: currentPage > 1 && totalCount > 0,
    ...extra,
  };
};

/**
 * The feed cursor (0.5) is opaque, but it still has to be well-formed enough that
 * a mangled one is rejected rather than crashing a query. Base64url of a small
 * JSON object is enough: nothing secret goes in it.
 */
export const encodeCursor = (payload: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

export const decodeCursor = <T extends Record<string, unknown>>(cursor?: string): T | null => {
  if (!cursor) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));

    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : null;
  } catch {
    return null;
  }
};
