import { Response } from 'express';
import { CookieService } from '../services/cookie.service';
import { AdminLoginResponse } from '../types';

export class BaseController {
  constructor(protected readonly cookieService: CookieService) {}

  protected handleAuthResponse(res: Response, response: AdminLoginResponse) {
    this.cookieService.setRefreshTokenInCookie(res, response.refreshToken);

    return {
      message: response.message,
      sessionId: response.sessionId,
      accessToken: response.accessToken,
    };
  }

  protected handleLogOutResponse(res: Response, response: { message: string }) {
    this.cookieService.clearRefreshTokenFromCookie(res);

    return { message: response.message };
  }
}
