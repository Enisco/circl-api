import { Request, Response } from 'express';
import { ClientPlatform } from '@/common';
import { CookieService } from '../services';
import { BaseResponse, LoginResponse, SignupTokenResponse } from '../types';

export class BaseController {
  constructor(protected readonly cookieService: CookieService) {}

  protected handleLogOutResponse(req: Request, res: Response, response: BaseResponse) {
    const isMobile = this.isMobileClient(req);

    if (!isMobile) {
      this.cookieService.clearTokensFromCookies(res);
    }

    return { message: response.message };
  }

  protected isMobileClient(req: Request): boolean {
    const platform = (req.headers['x-client-platform'] as string)?.toLowerCase();

    return platform === ClientPlatform.MOBILE;
  }

  protected handleAuthResponse(
    req: Request,
    res: Response,
    response: LoginResponse | SignupTokenResponse,
  ) {
    // New user — no tokens to set, return signup token directly
    if ('isNewUser' in response && response.isNewUser) {
      return response;
    }

    const loginResponse = response as LoginResponse;
    const isMobile = this.isMobileClient(req);

    if (!isMobile) {
      this.cookieService.setTokensInCookies(
        res,
        loginResponse.refreshToken,
        loginResponse.accessToken,
      );
    }

    const { refreshToken, accessToken, ...rest } = loginResponse;

    return {
      message: loginResponse.message,
      ...rest,
      ...(isMobile && { accessToken, refreshToken }),
    };
  }
}
