export interface SuccessResponse<T> {
  status: 'success';
  message: string;
  data: T;
  meta?: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface ErrorResponse {
  status: 'error';
  error: {
    message: string;
    errorType: string;
  };
}
