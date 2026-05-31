export interface AccessTokenPayload {
  sub: string;
  type: 'access';
  sid: string;
  iat: number;
}

export interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
  jti: string;
  iat: number;
}

export type TokenPayload = AccessTokenPayload | RefreshTokenPayload;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TokenValidationResult {
  userId: string;
  sessionId: string;
}
