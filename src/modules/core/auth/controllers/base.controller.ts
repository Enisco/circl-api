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

    // Cookies stay for the admin web client, which has a cookie jar and wants httpOnly.
    if (!isMobile) {
      this.cookieService.setTokensInCookies(
        res,
        loginResponse.refreshToken,
        loginResponse.accessToken,
      );
    }

    // The tokens are ALSO in the body, unconditionally. The mobile client has no cookie jar and
    // an httpOnly cookie is invisible to Dart by design, so a body that omitted them parsed
    // `accessToken` as null and treated a returning member as a brand-new signup. Keying this on
    // the `x-client-platform` header made it depend on a header the client was not sending.
    return { message: loginResponse.message, ...loginResponse };
  }
}
