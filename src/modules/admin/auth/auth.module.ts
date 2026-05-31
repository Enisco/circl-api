import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import {
  LoginController,
  PasswordController,
  TokenController,
  VerificationController,
} from './controllers';
import { AdminLocalStrategy, AdminJwtStrategy, AdminRefreshTokenStrategy } from './strategies';
import {
  AccountSecurityService,
  AuthService,
  CookieService,
  LoginService,
  LogoutService,
  PasswordService,
  SessionService,
  TokenService,
  VerificationEventService,
  VerificationService,
} from './services';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('ADMIN_JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: configService.get('ADMIN_JWT_ACCESS_EXPIRY') },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    AccountSecurityService,
    AuthService,
    CookieService,
    LoginService,
    LogoutService,
    PasswordService,
    SessionService,
    TokenService,
    VerificationEventService,
    VerificationService,
    AdminLocalStrategy,
    AdminJwtStrategy,
    AdminRefreshTokenStrategy,
  ],
  controllers: [LoginController, PasswordController, VerificationController, TokenController],
  exports: [SessionService],
})
export class AdminAuthModule {}
