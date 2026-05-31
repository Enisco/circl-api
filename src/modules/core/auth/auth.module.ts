import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { RegisterController, TokenController, VerificationController } from './controllers';
import { JwtStrategy, RefreshTokenStrategy } from './strategies';
import {
  AccountSecurityService,
  AuthService,
  CookieService,
  LogOutService,
  RegisterService,
  SessionService,
  SignupTokenService,
  SocialAuthService,
  TokenService,
  VerificationEventService,
  VerificationService,
} from './services';
import { RouterModule } from '@nestjs/core';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: configService.get('JWT_ACCESS_EXPIRY') },
      }),
      inject: [ConfigService],
    }),
    RouterModule.register([
      {
        path: 'api/v1/auth',
        module: AuthModule,
        children: [RegisterController, VerificationController, TokenController],
      },
    ]),
  ],
  providers: [
    AccountSecurityService,
    AuthService,
    CookieService,
    LogOutService,
    RegisterService,
    SessionService,
    SignupTokenService,
    SocialAuthService,
    TokenService,
    VerificationEventService,
    VerificationService,
    JwtStrategy,
    RefreshTokenStrategy,
  ],
  controllers: [RegisterController, VerificationController, TokenController],
})
export class AuthModule {}
