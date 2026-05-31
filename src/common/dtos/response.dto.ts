import { ApiProperty } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({
    example: 'error',
    description: 'Response status',
  })
  status: 'error';

  @ApiProperty({
    example: {
      message: 'Invalid input data',
      errorType: 'ValidationError',
    },
    description: 'Error details',
  })
  error: {
    message: string;
    errorType: string;
  };
}

export class SuccessResponseDto<T = any> {
  @ApiProperty({
    example: 'success',
    description: 'Response status',
  })
  status: 'success';

  @ApiProperty({
    example: 'Operation completed successfully',
    description: 'Success message',
  })
  message: string;

  @ApiProperty({
    description: 'Response data',
  })
  data: T;

  @ApiProperty({
    description: 'Pagination metadata',
    required: false,
    example: {
      total: 100,
      page: 1,
      limit: 10,
      totalPages: 10,
    },
  })
  meta?: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}
