import { ErrorResponseDto } from '@/common';
import { ApiDocs } from '@/common/decorators';
import { HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RegisterDeviceTokenDto } from '../dtos';

export const NotificationPrefsSwagger = {

  registerDeviceToken: ApiDocs(
    ApiBearerAuth(),
    ApiOperation({
      summary: 'Register or refresh device push token',
      description:
        'Call this on every app launch with the current FCM (Android) or APNs (iOS) token. ' +
        'The backend stores the latest token and uses it to send push notifications.',
    }),
    ApiBody({ type: RegisterDeviceTokenDto }),
    ApiResponse({
      status: HttpStatus.OK,
      schema: { example: { status: 'success', message: 'Device token registered' } },
    }),
    ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponseDto }),
    ApiResponse({ status: HttpStatus.FORBIDDEN, type: ErrorResponseDto }),
  ),
};
