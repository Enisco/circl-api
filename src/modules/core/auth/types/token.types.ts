import { SocialProvider } from '@prisma/client';

export interface AccessTokenPayload {
  sub: string; // subject, usually the user id
  type: 'access';
  sid: string; // session id
  iat: number; // issued at
}

export interface SignupTokenPayload {
  email: string;
  provider: SocialProvider | 'email';
  providerId?: string;
}

export interface RefreshTokenPayload {
  sub: string; // subject, usually the user id
  type: 'refresh';
  jti: string; // jwt id, usually the session id
  iat: number; // issued at
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
