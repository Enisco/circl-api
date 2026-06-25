export interface VerificationResponse {
  success: boolean;
  message: string;
}

export interface BaseResponse {
  message?: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
}

export interface LoginResponse extends BaseResponse, Partial<TokenResponse> {
  sessionId: string;
  onboardingCompleted?: boolean;
  onboardingStep?: number;
}

export interface SignupTokenResponse {
  isNewUser: true;
  signupToken: string;
}

export interface SocialLoginResponse extends BaseResponse, Partial<TokenResponse> {
  isNewUser: false;
  sessionId: string;
  onboardingCompleted?: boolean;
  onboardingStep?: number;
}

export interface RefreshResult {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  message?: string;
}

export type VerifyOtpResponse = SocialLoginResponse | SignupTokenResponse;
export type SocialAuthResponse = SocialLoginResponse | SignupTokenResponse;
