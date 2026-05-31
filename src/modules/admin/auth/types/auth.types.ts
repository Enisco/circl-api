export interface VerificationResponse {
  success: boolean;
  message: string;
}

export interface BaseResponse {
  message?: string;
}

export interface AdminLoginResponse extends BaseResponse {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
}

export interface AdminRefreshResult {
  sessionId: string;
  accessToken: string;
}

export type PasswordResetResponse = BaseResponse;
