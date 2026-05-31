import { ApiDocs } from '@/common/decorators';
import { HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  AdminLoginDto,
  AdminSendVerificationTokenDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyPasswordResetTokenDto,
} from '../dtos';

export const AuthSwagger = {
  login: ApiDocs(
    ApiOperation({
      summary: 'Admin login',
      description:
        'Authenticate an admin user with email and password. Returns an access token in the response body and sets the refresh token as an HttpOnly cookie.',
    }),
    ApiBody({
      type: AdminLoginDto,
      examples: {
        valid: {
          summary: 'Valid credentials',
          value: { email: 'admin@circl.app', password: 'Admin@123!' },
        },
        invalid: {
          summary: 'Wrong password',
          value: { email: 'admin@circl.app', password: 'wrongpassword' },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.OK,
      description:
        'Login successful. Access token returned in body; refresh token set in HttpOnly cookie.',
      schema: {
        example: {
          status: 'success',
          message: 'Login successful',
          data: {
            message: 'Login successful',
            sessionId: '550e8400-e29b-41d4-a716-446655440000',
            accessToken:
              'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLWlkIiwidHlwZSI6ImFjY2VzcyIsInNpZCI6InNlc3Npb24taWQiLCJpYXQiOjE2MDAwMDAwMDB9.signature',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.BAD_REQUEST,
      description: 'Invalid credentials or validation error',
      schema: {
        examples: {
          invalidCredentials: {
            summary: 'Wrong email or password',
            value: {
              status: 'error',
              error: {
                message: 'The provided credentials are incorrect',
                errorType: 'BadRequestException',
              },
            },
          },
          validationError: {
            summary: 'Missing required field',
            value: {
              status: 'error',
              error: { message: 'Email is required', errorType: 'ValidationError' },
            },
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.FORBIDDEN,
      description: 'Account blocked, suspended, or email not verified',
      schema: {
        examples: {
          accountBlocked: {
            summary: 'Too many failed attempts',
            value: {
              status: 'error',
              error: {
                message:
                  'Account locked due to multiple failed login attempts. Please wait 15 minutes before trying again.',
                errorType: 'ForbiddenException',
              },
            },
          },
          accountDisabled: {
            summary: 'Account suspended',
            value: {
              status: 'error',
              error: {
                message: 'Access denied. Contact support for assistance.',
                errorType: 'AccountDisabled',
              },
            },
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.TOO_MANY_REQUESTS,
      description: 'Rate limit exceeded (10 requests per minute)',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'Too many requests. Please try again later.',
            errorType: 'TooManyRequestsException',
          },
        },
      },
    }),
  ),
  forgotPassword: ApiDocs(
    ApiOperation({
      summary: 'Request password reset',
      description:
        'Send a 6-digit reset code to the admin email. For security, the response is the same whether or not the account exists. Code expires in 10 minutes.',
    }),
    ApiBody({
      type: ForgotPasswordDto,
      examples: {
        validEmail: { summary: 'Existing admin email', value: { email: 'admin@circl.app' } },
        unknownEmail: {
          summary: 'Non-existent email (same response)',
          value: { email: 'unknown@example.com' },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.OK,
      description: 'Reset code dispatched (response is identical whether account exists or not)',
      schema: {
        example: {
          status: 'success',
          message: 'If a user with this email exists, a password reset link has been sent.',
          data: {
            message: 'If a user with this email exists, a password reset link has been sent.',
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
          error: { message: 'Please provide a valid email address', errorType: 'ValidationError' },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.TOO_MANY_REQUESTS,
      description: 'Rate limit exceeded',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'Too many requests. Please try again later.',
            errorType: 'TooManyRequestsException',
          },
        },
      },
    }),
  ),
  resetPassword: ApiDocs(
    ApiOperation({
      summary: 'Reset password',
      description:
        'Complete the password reset flow. Requires a valid 6-digit code sent to the email. All active sessions are revoked on success.',
    }),
    ApiBody({
      type: ResetPasswordDto,
      examples: {
        valid: {
          summary: 'Valid reset',
          value: { email: 'admin@circl.app', code: '123456', password: 'NewAdmin@123!' },
        },
        invalidCode: {
          summary: 'Expired or wrong code',
          value: { email: 'admin@circl.app', code: '000000', password: 'NewAdmin@123!' },
        },
        samePassword: {
          summary: 'Same as current password',
          value: { email: 'admin@circl.app', code: '123456', password: 'CurrentAdmin@123!' },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.OK,
      description: 'Password reset successfully. All sessions revoked.',
      schema: {
        example: {
          status: 'success',
          message: 'Password reset successfully',
          data: { message: 'Password reset successfully' },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.BAD_REQUEST,
      description: 'Invalid code, weak password, or same-as-old password',
      schema: {
        examples: {
          invalidCode: {
            summary: 'Invalid verification code',
            value: {
              status: 'error',
              error: { message: 'Invalid verification code', errorType: 'BadRequestException' },
            },
          },
          samePassword: {
            summary: 'New password same as old',
            value: {
              status: 'error',
              error: {
                message:
                  'Your new password cannot be a recently used password. Please choose a different password',
                errorType: 'BadRequestException',
              },
            },
          },
          weakPassword: {
            summary: 'Password too short',
            value: {
              status: 'error',
              error: {
                message: 'Password must be at least 8 characters long',
                errorType: 'ValidationError',
              },
            },
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.NOT_FOUND,
      description: 'Admin user not found',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'No user was found with the provided information',
            errorType: 'BadRequestException',
          },
        },
      },
    }),
  ),
  refreshTokens: ApiDocs(
    ApiOperation({
      summary: 'Refresh access token',
      description:
        'Generate a new access token and rotate the refresh token using the HttpOnly cookie. New refresh token is set in cookie; new access token returned in body.',
    }),
    ApiResponse({
      status: HttpStatus.OK,
      description: 'Tokens rotated. New access token in body.',
      schema: {
        example: {
          status: 'success',
          message: 'Operation successful',
          data: {
            sessionId: '550e8400-e29b-41d4-a716-446655440000',
            accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.newtoken.signature',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.UNAUTHORIZED,
      description: 'Missing, invalid, or expired refresh token cookie',
      schema: {
        examples: {
          noCookie: {
            summary: 'No refresh token cookie',
            value: {
              status: 'error',
              error: {
                message: 'Session expired. Please log in again',
                errorType: 'UnauthorizedException',
              },
            },
          },
          invalidToken: {
            summary: 'Tampered or expired token',
            value: {
              status: 'error',
              error: {
                message: 'Session expired. Please log in again',
                errorType: 'UnauthorizedException',
              },
            },
          },
        },
      },
    }),
  ),
  logout: ApiDocs(
    ApiBearerAuth(),
    ApiOperation({
      summary: 'Logout',
      description:
        'Revoke the current device session or all sessions. Clears the refresh token cookie. Requires a valid Bearer access token.',
    }),
    ApiResponse({
      status: HttpStatus.OK,
      description: 'Logged out successfully',
      schema: {
        examples: {
          singleDevice: {
            summary: 'Current device logout',
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
  ),
  sendVerificationToken: ApiDocs(
    ApiOperation({
      summary: 'Send verification code',
      description:
        'Send a 6-digit OTP to the admin email. Rate limited to 10 requests per minute. Code expires in 10 minutes.',
    }),
    ApiBody({
      type: AdminSendVerificationTokenDto,
      examples: {
        passwordReset: {
          summary: 'Request password-reset code',
          value: { type: 'password-reset', email: 'admin@circl.app' },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.OK,
      description: 'Code sent (response is the same regardless of whether the email exists)',
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
      description: 'Validation error',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'Verification type must be password-reset',
            errorType: 'ValidationError',
          },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.TOO_MANY_REQUESTS,
      description: 'Rate limit exceeded (3 per minute)',
      schema: {
        example: {
          status: 'error',
          error: {
            message: 'Too many requests. Please try again later.',
            errorType: 'TooManyRequestsException',
          },
        },
      },
    }),
  ),
  verifyPasswordResetToken: ApiDocs(
    ApiOperation({
      summary: 'Verify password reset code',
      description:
        'Validate the 6-digit OTP before submitting a new password. Returns success if the code is valid.',
    }),
    ApiBody({
      type: VerifyPasswordResetTokenDto,
      examples: {
        valid: { summary: 'Valid code', value: { email: 'admin@circl.app', code: '123456' } },
        invalid: { summary: 'Wrong code', value: { email: 'admin@circl.app', code: '000000' } },
      },
    }),
    ApiResponse({
      status: HttpStatus.OK,
      description: 'Code is valid',
      schema: {
        example: {
          status: 'success',
          message: 'Code verified successfully',
          data: { success: true, message: 'Code verified successfully' },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.BAD_REQUEST,
      description: 'Code invalid or expired',
      schema: {
        example: {
          status: 'error',
          error: { message: 'Invalid verification code', errorType: 'BadRequestException' },
        },
      },
    }),
  ),
};
