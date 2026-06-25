import { HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiBody, ApiHeader } from '@nestjs/swagger';
import { ApiDocs } from '@/common/decorators';
import {
  RegisterUserDto,
  SendVerificationTokenDto,
  VerifyEmailDto,
  LogoutDto,
  SocialAuthDto,
} from '../dtos';
import { SHARED_HEADERS } from '@/common';

const MOBILE_REFRESH_TOKEN_HEADER = ApiHeader({
  name: 'x-refresh-token',
  description: 'Refresh token',
  required: true,
  schema: {
    type: 'string',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  },
});

export const AuthSwagger = {
  register: ApiDocs(
    ...SHARED_HEADERS,
    ApiOperation({
      summary: 'Register a new user',
      description:
        'Creates a new account using a short-lived signup token issued after OTP or social verification. ' +
        'If the email already exists (race condition), logs the user in instead.',
    }),
    ApiBody({
      type: RegisterUserDto,
      examples: {
        email: {
          summary: 'Email sign-up (A-05)',
          value: {
            signupToken:
              'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ.sig',
            firstName: 'John',
            lastName: 'Doe',
            gender: 'MALE',
          },
        },
        social: {
          summary: 'Social sign-up — Google / Apple (A-05)',
          value: {
            signupToken:
              'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ.sig',
            firstName: 'Jane',
            lastName: 'Smith',
            gender: 'FEMALE',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.CREATED,
      description: 'Session issued — new registration or existing user (race condition guard)',
      examples: {
        NEW_USER: {
          summary: 'New user registered',
          value: {
            status: 'success',
            message: 'Account registered successfully',
            data: {
              message: 'Account registered successfully',
              sessionId: '550e8400-e29b-41d4-a716-446655440000',
              accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
              refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
              onboardingCompleted: false,
              onboardingStep: 0,
            },
          },
        },
        EXISTING_USER: {
          summary: 'User already exists — logged in instead',
          value: {
            status: 'success',
            message: 'Login successful',
            data: {
              message: 'Login successful',
              sessionId: '550e8400-e29b-41d4-a716-446655440000',
              accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
              refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
              onboardingCompleted: true,
              onboardingStep: 5,
            },
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.BAD_REQUEST,
      description: 'Validation failure or invalid signup token',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'signupToken is required',
            errorType: 'ValidationError',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.UNAUTHORIZED,
      description: 'Signup token expired or malformed',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'Signup token has expired. Please verify your email again',
            errorType: 'UnauthorizedException',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.CONFLICT,
      description: 'Role record not found or unique constraint violated',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'No Role was found with the provided information',
            errorType: 'ConflictException',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      description: 'Internal server error',
      schema: {
        example: {
          status: 'error',
          error: {
            message:
              'An unexpected error occurred. Please try again later or contact support if the problem persists.',
            errorType: 'InternalServerError',
          },
        },
      },
    }),
  ),

  sendVerificationToken: ApiDocs(
    ApiOperation({
      summary: 'Send verification token',
      description:
        'Sends a 4-digit OTP to the given email — always, whether or not the account exists. ' +
        'The response message is worded neutrally to prevent email enumeration. ' +
        'OTP expires after 10 minutes. Rate limited to 10 attempts per minute.',
    }),
    ApiBody({
      type: SendVerificationTokenDto,
      description: 'Email to send a 4-digit OTP to',
      examples: {
        example: {
          summary: 'Send OTP',
          value: { email: 'john.doe@example.com' },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.CREATED,
      description: 'OTP sent',
      schema: {
        example: {
          status: 'success',
          message: 'If this email exists, a verification code has been sent',
          data: {
            success: true,
            message: 'If this email exists, a verification code has been sent',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.BAD_REQUEST,
      description: 'Invalid email format',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'Please provide a valid email address',
            errorType: 'ValidationError',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.TOO_MANY_REQUESTS,
      description: 'Too many requests',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'Too Many Requests',
            errorType: 'ThrottlerException',
          },
        },
      },
    }),
  ),

  verifyAccount: ApiDocs(
    ...SHARED_HEADERS,
    ApiOperation({
      summary: 'Verify OTP',
      description:
        'Verifies the 4-digit OTP. ' +
        'New users receive a short-lived signup token to proceed to POST /auth/register. ' +
        'Existing users receive a full session. ' +
        'Failed attempts against existing accounts are tracked; the account is locked after too many failures.',
    }),
    ApiBody({
      type: VerifyEmailDto,
      examples: {
        example: {
          summary: 'Verify OTP',
          value: { email: 'john.doe@example.com', code: '4821' },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.CREATED,
      description: 'OTP verified — signup token for new users, session for existing users',
      examples: {
        NEW_USER: {
          summary: 'New user — proceed to POST /auth/register',
          value: {
            status: 'success',
            message: 'Operation successful',
            data: {
              isNewUser: true,
              signupToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
            },
          },
        },
        EXISTING_USER: {
          summary: 'Existing user — session issued',
          value: {
            status: 'success',
            message: 'Email verified successfully',
            data: {
              message: 'Email verified successfully',
              sessionId: '4c714109-1159-4107-bebd-340fb8e3a857',
              accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
              refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
              onboardingCompleted: false,
              onboardingStep: 0,
            },
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.BAD_REQUEST,
      description: 'Invalid or expired OTP',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'Invalid verification code',
            errorType: 'BadRequestException',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.FORBIDDEN,
      description: 'Account blocked, suspended, or temporarily locked',
      examples: {
        BLOCKED: {
          summary: 'Account blocked after too many failed OTP attempts',
          value: {
            status: 'error',
            error: {
              message:
                'Account locked due to multiple failed login attempts. Please wait 15 minutes before trying again.',
              errorType: 'AccountBlocked',
            },
          },
        },
        SUSPENDED: {
          summary: 'Account suspended by admin',
          value: {
            status: 'error',
            error: {
              message: 'Access denied. Please, contact support for assistance.',
              errorType: 'AccountDisabled',
            },
          },
        },
        LOCKED: {
          summary: 'Account temporarily locked — lockout period still active',
          value: {
            status: 'error',
            error: {
              message: 'Your account is temporarily locked. Try again in 14 minutes.',
              errorType: 'AccountLocked',
            },
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.TOO_MANY_REQUESTS,
      description: 'Too many requests',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'Too Many Requests',
            errorType: 'ThrottlerException',
          },
        },
      },
    }),
  ),

  refreshTokens: ApiDocs(
    ...SHARED_HEADERS,
    MOBILE_REFRESH_TOKEN_HEADER,
    ApiOperation({
      summary: 'Refresh access token',
      description:
        'Issues a new access token and a new refresh token. The old refresh token is immediately ' +
        'invalidated — store the new one and discard the old one. This keeps the session alive ' +
        'indefinitely as long as the user refreshes within the 14-day window.\n\n' +
        'Mobile clients send the current refresh token in the `x-refresh-token` header and receive ' +
        'the new token pair in the response body. Web clients use the HttpOnly cookie automatically.',
    }),
    ApiResponse({
      status: HttpStatus.OK,
      description: 'Tokens refreshed',
      schema: {
        example: {
          status: 'success',
          message: 'Operation successful',
          data: {
            sessionId: '550e8400-e29b-41d4-a716-446655440000',
            accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
            refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.UNAUTHORIZED,
      description: 'Invalid or expired refresh token',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'Session expired. Please log in again',
            errorType: 'UnauthorizedException',
          },
        },
      },
    }),
  ),

  logout: ApiDocs(
    ApiBearerAuth(),
    ...SHARED_HEADERS,
    ApiOperation({
      summary: 'Logout',
      description:
        'Revokes the current session, or all sessions when revokeAll is true. ' +
        'Clears refresh token cookies for web clients.',
    }),
    ApiBody({
      type: LogoutDto,
      required: false,
      examples: {
        currentDevice: {
          summary: 'Current device only (default)',
          value: { revokeAll: false },
        },
        allDevices: {
          summary: 'All devices',
          value: { revokeAll: true },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.OK,
      description: 'Logged out',
      examples: {
        currentDevice: {
          summary: 'Single device logout',
          value: {
            status: 'success',
            message: 'Logout successful',
            data: { message: 'Logout successful' },
          },
        },
        allDevices: {
          summary: 'All devices logout',
          value: {
            status: 'success',
            message: 'Logged out from all devices successfully',
            data: { message: 'Logged out from all devices successfully' },
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.UNAUTHORIZED,
      description: 'Missing or expired access token',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'Unauthorized access. Please provide valid credentials',
            errorType: 'UnauthorizedException',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.BAD_REQUEST,
      description: 'Invalid request body',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'revokeAll must be a boolean value',
            errorType: 'ValidationError',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      description: 'Internal server error',
      schema: {
        example: {
          status: 'error',
          error: {
            message:
              'An unexpected error occurred. Please try again later or contact support if the problem persists.',
            errorType: 'InternalServerError',
          },
        },
      },
    }),
  ),

  socialVerify: ApiDocs(
    ...SHARED_HEADERS,
    ApiOperation({
      summary: 'Verify Google or Apple identity token',
      description:
        'Verifies a social identity token. ' +
        'Existing users receive a full session. ' +
        'New users receive a short-lived signup token to proceed to POST /auth/register.',
    }),
    ApiBody({
      type: SocialAuthDto,
      examples: {
        google: {
          summary: 'Google Sign-In',
          value: {
            provider: 'GOOGLE',
            idToken: 'eyJhbGciOiJSUzI1NiIs...',
            email: 'user@gmail.com',
          },
        },
        apple: {
          summary: 'Apple Sign-In',
          value: {
            provider: 'APPLE',
            idToken: 'eyJhbGciOiJSUzI1NiIs...',
            email: 'user@privaterelay.appleid.com',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.OK,
      description: 'Token verified — session for existing users, signup token for new users',
      examples: {
        NEW_USER: {
          summary: 'New user — proceed to POST /auth/register',
          value: {
            status: 'success',
            message: 'Operation successful',
            data: { isNewUser: true, signupToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
          },
        },
        EXISTING_USER: {
          summary: 'Existing user — session issued',
          value: {
            status: 'success',
            message: 'Login successful',
            data: {
              message: 'Login successful',
              isNewUser: false,
              sessionId: '550e8400-e29b-41d4-a716-446655440000',
              accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
              refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
              onboardingCompleted: false,
              onboardingStep: 0,
            },
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.UNAUTHORIZED,
      description: 'Token verification failed or email mismatch',
      examples: {
        INVALID_TOKEN: {
          summary: 'Token could not be verified',
          value: {
            status: 'error',
            error: {
              message: 'Social identity token could not be verified',
              errorType: 'UnauthorizedException',
            },
          },
        },
        EMAIL_MISMATCH: {
          summary: 'Email in token does not match the provided email',
          value: {
            status: 'error',
            error: {
              message: 'Email in token does not match the provided email',
              errorType: 'UnauthorizedException',
            },
          },
        },
        TOKEN_EXPIRED: {
          summary: 'Token has expired',
          value: {
            status: 'error',
            error: {
              message: 'Social identity token has expired',
              errorType: 'UnauthorizedException',
            },
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      description: 'Could not reach identity provider',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'Social identity token could not be verified',
            errorType: 'InternalServerErrorException',
          },
        },
      },
    }),
  ),
};
