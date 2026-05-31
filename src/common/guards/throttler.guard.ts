import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected throwThrottlingException(): never {
    throw new HttpException(
      {
        status: HttpStatus.TOO_MANY_REQUESTS,
        errorType: 'RateLimitExceeded',
        message: 'Too many requests. Please try again in a minute.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
