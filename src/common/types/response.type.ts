/** Pagination metadata (spec 0.5). */
export interface PageMeta {
  currentPage: number;
  perPage: number;
  totalPages: number;
  /** Total matching the filters, not the page. */
  totalCount: number;
  /** Sent, not computed by the client. */
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  [key: string]: unknown;
}

/** The feed is the one exception to page-based paging (0.5): an infinite scroll over data that shifts while the user reads, where page numbers duplicate and drop items. */
export interface CursorMeta {
  nextCursor: string | null;
  hasNextPage: boolean;
  totalCount: null;
  [key: string]: unknown;
}

export type ResponseMeta = PageMeta | CursorMeta | Record<string, unknown>;

/** One envelope for every response (spec 0.3). */
export interface SuccessResponse<T> {
  success: true;
  status: 'success';
  /** Human readable. Never parsed by the client. Safe to reword at any time. */
  message: string;
  data: T;
  meta?: ResponseMeta;
}

export interface ErrorResponse {
  success: false;
  status: 'error';
  message: string;
  data: null;
  error: {
    /** UPPER_SNAKE. The only thing the client branches on (0.4). */
    code: string;
    /** One entry per offending field, for validation failures only. */
    details?: Array<{ field: string; message: string }>;
    /** Retained for the shipped build, which reads `error.errorType`. */
    errorType: string;
    message: string;
  };
}

/** What a service returns when it wants to set the message or attach meta. */
export interface Envelope<T> {
  data: T;
  message?: string;
  meta?: ResponseMeta;
}

/** A page of results plus its meta, the shape every list service returns. */
export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}
