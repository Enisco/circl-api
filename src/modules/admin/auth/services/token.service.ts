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
    const [accessToken, refreshToken] = await Promise.all([
      this.generateAccessToken(data),
      this.generateRefreshToken(data),
    ]);

    return { accessToken, refreshToken };
  }

  async validateRefreshToken(refreshToken: string): Promise<TokenValidationResult | null> {
    try {
      const decoded = await this.jwtService.verifyAsync(refreshToken, {
        secret: this.configService.get('ADMIN_JWT_REFRESH_SECRET'),
      });

      if (!this.isValidRefreshPayload(decoded)) {
        this.logger.error('Invalid admin refresh token format');

        return null;
      }

      return { userId: decoded.sub, sessionId: decoded.jti };
    } catch (error) {
      this.logger.error(error);

      return null;
    }
  }

  async generateAccessToken(data: { userId: string; sessionId: string }): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: data.userId,
      type: 'access',
      sid: data.sessionId,
      iat: Math.floor(Date.now() / 1000),
    };

    return this.jwtService.signAsync(payload, {
      secret: this.configService.get('ADMIN_JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get('ADMIN_JWT_ACCESS_EXPIRY'),
    });
  }

  private async generateRefreshToken(data: { userId: string; sessionId: string }): Promise<string> {
    const payload: RefreshTokenPayload = {
      sub: data.userId,
      type: 'refresh',
      jti: data.sessionId,
      iat: Math.floor(Date.now() / 1000),
    };

    return this.jwtService.signAsync(payload, {
      secret: this.configService.get('ADMIN_JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get('ADMIN_JWT_REFRESH_EXPIRY'),
    });
  }

  private isValidRefreshPayload(payload: unknown): payload is RefreshTokenPayload {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'sub' in payload &&
      'type' in payload &&
      'jti' in payload &&
      (payload as any).type === 'refresh'
    );
  }
}
