import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PinoLogger } from 'nestjs-pino';
import {
  AccessTokenPayload,
  RefreshTokenPayload,
  TokenPair,
  TokenValidationResult,
} from '../types';
import { MEMBER_TOKEN_AUDIENCE } from '../constants';

@Injectable()
export class TokenService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.logger.setContext(TokenService.name);
  }

  async generateTokenPair(data: { userId: string; sessionId: string }): Promise<TokenPair> {
    const accessToken = await this.generateAccessToken(data);
    const refreshToken = await this.generateRefreshToken(data);

    return { accessToken, refreshToken };
  }

  /** Generates a short-lived access token. */
  async generateAccessToken(data: { userId: string; sessionId: string }): Promise<string> {
    const { userId, sessionId } = data;
    const payload: AccessTokenPayload = {
      sub: userId,
      type: 'access',
      sid: sessionId,
      iat: Math.floor(Date.now() / 1000),
    };

    return this.jwtService.signAsync(payload, {
      secret: this.configService.get('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get('JWT_ACCESS_EXPIRY'),
      audience: MEMBER_TOKEN_AUDIENCE,
    });
  }

  /** Generates a long-lived refresh token. */
  async generateRefreshToken(data: { userId: string; sessionId: string }): Promise<string> {
    const { userId, sessionId } = data;
    const payload: RefreshTokenPayload = {
      sub: userId,
      type: 'refresh',
      jti: sessionId,
      iat: Math.floor(Date.now() / 1000),
    };

    return this.jwtService.signAsync(payload, {
      secret: this.configService.get('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRY'),
      audience: MEMBER_TOKEN_AUDIENCE,
    });
  }

  async validateRefreshToken(refreshToken: string): Promise<TokenValidationResult | null> {
    try {
      const decoded = await this.jwtService.verifyAsync(refreshToken, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
        // Not pinned: tokens minted before the audience existed are still in circulation and must
        // keep working until they expire. The access path logs each one it sees (`jwt.strategy.ts`)
        // so the day the last one goes can be read off the logs rather than guessed at.
      });

      if (!this.isValidRefreshTokenPayload(decoded)) {
        this.logger.error('Invalid token format');

        return null;
      }

      return { userId: decoded.sub, sessionId: decoded.jti };
    } catch (error) {
      this.logger.error(error);

      return null;
    }
  }

  private isValidRefreshTokenPayload(payload: unknown): payload is RefreshTokenPayload {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'sub' in payload &&
      'type' in payload &&
      'jti' in payload &&
      payload.type === 'refresh'
    );
  }
}
