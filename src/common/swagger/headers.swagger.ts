import { ApiHeader } from '@nestjs/swagger';

export const SHARED_HEADERS = [
  ApiHeader({
    name: 'x-device-id',
    description: 'Unique identifier for the device',
    required: true,
    schema: {
      type: 'string',
      example: '550e8400-e29b-41d4-a716-446655440000',
    },
  }),
  ApiHeader({
    name: 'x-device-name',
    description: 'Name of the device (required for mobile clients only)',
    required: true,
    schema: {
      type: 'string',
      example: 'iPhone 13 Pro',
    },
  }),
  ApiHeader({
    name: 'x-app-version',
    description: 'Version of the client application (required for mobile clients only)',
    required: true,
    schema: {
      type: 'string',
      example: '1.0.0',
    },
  }),
  ApiHeader({
    name: 'x-timezone',
    description: "User's timezone",
    required: true,
    schema: {
      type: 'string',
      example: 'Africa/Lagos',
    },
  }),
  ApiHeader({
    name: 'x-client-platform',
    description: 'Platform type',
    required: true,
    schema: {
      type: 'string',
      enum: ['mobile'],
      example: 'mobile',
    },
  }),
  ApiHeader({
    name: 'x-session-id',
    description: 'Current session identifier (optional)',
    required: false,
    schema: {
      type: 'string',
      example: '550e8400-e29b-41d4-a716-446655440000',
    },
  }),
] as const;
