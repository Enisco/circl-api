import { ErrorResponseDto } from '@/common';
import { ApiDocs } from '@/common/decorators';
import { HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UpdateProfileDto } from '../dtos';

const fullProfileExample = {
  id: '945b5de5-8dbd-458f-b401-130d7ec1217a',
  firstName: 'John',
  lastName: 'Doe',
  username: 'john_doe',
  profileImageUrl: 'https://r2.circl.app/avatars/945b5de5.jpg',
  email: 'john@example.com',
  createdAt: '2024-01-15T10:00:00.000Z',
  profile: {
    gender: 'MALE',
    city: { id: 'LONDON', name: 'London' },
    countryOfOrigin: 'Nigeria',
    phoneNumberDiallingCode: '+44',
    phoneNumber: '7911123456',
    bio: 'Moved to the UK in 2022. Happy to help newcomers.',
    canHelpWith: 'Visa applications, bank account setup, NHS registration',
    openInbox: true,
    onboardingStep: 2,
    onboardingCompleted: true,
  },
};

export const ProfileSwagger = {
  getProfile: ApiDocs(
    ApiBearerAuth(),
    ApiOperation({
      summary: 'Get current user profile',
      description:
        'Returns the authenticated user with their full profile. ' +
        '`profile` is `null` if onboarding has not been started.',
    }),
    ApiResponse({
      status: HttpStatus.OK,
      schema: {
        example: {
          status: 'success',
          message: 'Profile retrieved successfully',
          data: fullProfileExample,
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.UNAUTHORIZED,
      description: 'Missing or expired access token',
      type: ErrorResponseDto,
    }),
    ApiResponse({
      status: HttpStatus.NOT_FOUND,
      description: 'User not found',
      type: ErrorResponseDto,
    }),
  ),

  updateProfile: ApiDocs(
    ApiBearerAuth(),
    ApiOperation({
      summary: 'Update current user profile',
      description:
        'Partially updates the authenticated user profile. All fields are optional. ' +
        'Name / username fields update the user record; all other fields upsert the UserProfile record.',
    }),
    ApiBody({
      type: UpdateProfileDto,
      description: 'Profile fields to update (all optional)',
      examples: {
        arrivalStep: {
          summary: 'A-06 — Your Arrival step',
          value: {
            username: 'john_doe',
            cityId: 'LONDON',
            countryOfOrigin: 'Nigeria',
            phoneNumberDiallingCode: '+44',
            phoneNumber: '7911123456',
            onboardingStep: 2,
          },
        },
        editProfile: {
          summary: 'Edit community profile (PRF-02)',
          value: {
            bio: 'Moved to the UK in 2022. Happy to help newcomers.',
            canHelpWith: 'Visa applications, bank account setup',
            openInbox: true,
          },
        },
        onboardingComplete: {
          summary: 'Mark onboarding complete',
          value: { onboardingCompleted: true },
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.OK,
      schema: {
        example: {
          status: 'success',
          message: 'Profile updated successfully',
          data: null,
        },
      },
    }),
    ApiResponse({
      status: HttpStatus.BAD_REQUEST,
      description: 'Validation error',
      type: ErrorResponseDto,
    }),
    ApiResponse({
      status: HttpStatus.CONFLICT,
      description: 'Username already taken',
      type: ErrorResponseDto,
    }),
    ApiResponse({
      status: HttpStatus.UNAUTHORIZED,
      description: 'Missing or expired access token',
      type: ErrorResponseDto,
    }),
  ),
};
