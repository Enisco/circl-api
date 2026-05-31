import { ErrorResponseDto } from '@/common';
import { ApiDocs } from '@/common/decorators';
import { HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RegisterDeviceTokenDto } from '../dtos';

const prefsExample = {
  devicePushToken: null,
  updatedAt: '2026-05-18T10:00:00.000Z',
};

export const NotificationPrefsSwagger = {
  getPrefs: ApiDocs(
    ApiBearerAuth(),
    ApiOperation({ summary: 'Get notification preferences' }),
    ApiResponse({
      status: HttpStatus.OK,
      schema: {
        example: {
          status: 'success',
          message: 'Notification preferences retrieved',
          data: prefsExample,
        },
      },
    }),
    ApiResponse({ status: HttpStatus.UNAUTHORIZED, type: ErrorResponseDto }),
    ApiResponse({ status: HttpStatus.FORBIDDEN, type: ErrorResponseDto }),
  ),

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
