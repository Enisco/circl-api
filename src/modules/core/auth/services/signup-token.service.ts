import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PinoLogger } from 'nestjs-pino';
import { ErrorMessage } from '@/common';
import { SignupTokenPayload } from '../types';

@Injectable()
export class SignupTokenService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.logger.setContext(SignupTokenService.name);
  }

  async sign(payload: SignupTokenPayload): Promise<string> {
    return this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow('JWT_SIGNUP_SECRET'),
      expiresIn: this.configService.get('JWT_SIGNUP_EXPIRY'),
    });
  }

  async verify(token: string): Promise<SignupTokenPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<SignupTokenPayload>(token, {
        secret: this.configService.getOrThrow('JWT_SIGNUP_SECRET'),
      });

      return payload;
    } catch (error) {
      if (error instanceof Error && error.name === 'TokenExpiredError') {
        throw new UnauthorizedException(ErrorMessage.SIGNUP_TOKEN_EXPIRED);
      }

      throw new UnauthorizedException(ErrorMessage.INVALID_SIGNUP_TOKEN);
    }
  }
}
