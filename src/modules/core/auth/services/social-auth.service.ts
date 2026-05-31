import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PinoLogger } from 'nestjs-pino';
import { OAuth2Client } from 'google-auth-library';
import * as jwksRsa from 'jwks-rsa';
import { PrismaService } from '@/infrastructure';
import { DeviceInfo, ErrorMessage, SuccessMessage } from '@/common';
import { SocialProvider } from '@prisma/client';
import { SessionService } from './session.service';
import { SignupTokenService } from './signup-token.service';
import { SocialAuthDto } from '../dtos';
import { SocialAuthResponse } from '../types';

@Injectable()
export class SocialAuthService {
  private readonly googleClient: OAuth2Client;
  private readonly appleJwksClient: jwksRsa.JwksClient;

  constructor(
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly database: PrismaService,
    private readonly sessionService: SessionService,
    private readonly signupTokenService: SignupTokenService,
  ) {
    this.logger.setContext(SocialAuthService.name);

    this.googleClient = new OAuth2Client(this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID'));

    this.appleJwksClient = new jwksRsa.JwksClient({
      jwksUri: this.configService.getOrThrow<string>('APPLE_JWKS_URI'),
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 600_000, // 10 minutes
    });
  }

  async handleSocialAuth(dto: SocialAuthDto, deviceInfo: DeviceInfo): Promise<SocialAuthResponse> {
    const { provider, idToken, email } = dto;

    let verifiedEmail: string;
    let providerId: string;

    if (provider === SocialProvider.GOOGLE) {
      ({ email: verifiedEmail, providerId } = await this.verifyGoogleToken(idToken, email));
    } else if (provider === SocialProvider.APPLE) {
      ({ email: verifiedEmail, providerId } = await this.verifyAppleToken(idToken, email));
    } else {
      throw new BadRequestException('Invalid provider');
    }

    const user = await this.database.user.findUnique({
      where: { email: verifiedEmail },
      select: {
        id: true,
        socialAuths: { select: { provider: true, providerId: true } },
        profile: { select: { onboardingCompleted: true, onboardingStep: true } },
      },
    });

    // New user — issue a signup token
    if (!user) {
      const signupToken = await this.signupTokenService.sign({
        email: verifiedEmail,
        provider,
        providerId,
      });

      return { isNewUser: true, signupToken };
    }

    // Existing user — link provider if not already linked
    const alreadyLinked = user.socialAuths.some(
      sa => sa.provider === provider && sa.providerId === providerId,
    );

    if (!alreadyLinked) {
      await this.database.userSocialAuth.upsert({
        where: { userId_provider: { userId: user.id, provider } },
        update: { providerId },
        create: { userId: user.id, provider, providerId },
      });
    }

    const { sessionId, tokenPair } = await this.sessionService.createSession({
      userId: user.id,
      deviceInfo,
    });

    return {
      message: SuccessMessage.LOGIN_SUCCESSFUL,
      isNewUser: false,
      sessionId,
      accessToken: tokenPair.accessToken,
      refreshToken: tokenPair.refreshToken,
      onboardingCompleted: user.profile?.onboardingCompleted ?? false,
      onboardingStep: user.profile?.onboardingStep ?? 0,
    };
  }

  private async verifyGoogleToken(
    idToken: string,
    requestEmail: string,
  ): Promise<{ email: string; providerId: string }> {
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: [
          this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID'),
          this.configService.getOrThrow<string>('GOOGLE_IOS_CLIENT_ID'),
          this.configService.getOrThrow<string>('GOOGLE_ANDROID_CLIENT_ID'),
        ],
      });

      const payload = ticket.getPayload();

      if (!payload?.email || !payload.sub) {
        throw new UnauthorizedException(ErrorMessage.INVALID_SOCIAL_TOKEN);
      }

      if (payload.email.toLowerCase() !== requestEmail.toLowerCase()) {
        throw new UnauthorizedException(ErrorMessage.SOCIAL_EMAIL_MISMATCH);
      }

      return { email: payload.email.toLowerCase(), providerId: payload.sub };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw new UnauthorizedException(ErrorMessage.INVALID_SOCIAL_TOKEN);
      }

      this.logger.error({ err: error }, 'Google token verification failed');

      if ((error as Error)?.message?.includes('Token used too late')) {
        throw new UnauthorizedException(ErrorMessage.SOCIAL_TOKEN_EXPIRED);
      }

      throw new InternalServerErrorException(ErrorMessage.INVALID_SOCIAL_TOKEN);
    }
  }

  private async verifyAppleToken(
    idToken: string,
    requestEmail: string,
  ): Promise<{ email: string; providerId: string }> {
    try {
      const decoded = this.jwtService.decode(idToken, { complete: true }) as {
        header: { kid: string; alg: string };
        payload: { sub: string; email?: string };
      };

      if (!decoded?.header?.kid) {
        throw new UnauthorizedException(ErrorMessage.INVALID_SOCIAL_TOKEN);
      }

      const signingKey = await this.appleJwksClient.getSigningKey(decoded.header.kid);
      const publicKey = signingKey.getPublicKey();

      const payload = await this.jwtService.verifyAsync<{ sub: string; email?: string }>(idToken, {
        publicKey,
        algorithms: ['RS256'],
        issuer: 'https://appleid.apple.com',
        audience: this.configService.getOrThrow<string>('APPLE_BUNDLE_ID'),
      });

      if (!payload?.sub) {
        throw new UnauthorizedException(ErrorMessage.INVALID_SOCIAL_TOKEN);
      }

      // Apple only sends email on first login; subsequent logins omit it
      if (payload.email && payload.email.toLowerCase() !== requestEmail.toLowerCase()) {
        throw new UnauthorizedException(ErrorMessage.SOCIAL_EMAIL_MISMATCH);
      }

      return { email: requestEmail.toLowerCase(), providerId: payload.sub };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw new UnauthorizedException(ErrorMessage.INVALID_SOCIAL_TOKEN);
      }

      this.logger.error({ err: error }, 'Apple token verification failed');

      if ((error as Error)?.name === 'TokenExpiredError') {
        throw new UnauthorizedException(ErrorMessage.SOCIAL_TOKEN_EXPIRED);
      }

      throw new InternalServerErrorException(ErrorMessage.INVALID_SOCIAL_TOKEN);
    }
  }
}
