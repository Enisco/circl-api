import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';

export function ApiPagination() {
  return applyDecorators(
    ApiQuery({
      name: 'page',
      required: false,
      type: Number,
      description: 'Page number',
    }),
    ApiQuery({
      name: 'perPage',
      required: false,
      type: Number,
      description: 'Number of items per page',
    }),
    ApiQuery({
      name: 'search',
      required: false,
      type: String,
      description: 'Search query',
    }),
    ApiQuery({
      name: 'sortBy',
      required: false,
      type: String,
      description: 'Sort by field',
    }),
    ApiQuery({
      name: 'sortOrder',
      required: false,
      type: String,
      description: 'Sort order (asc or desc)',
    }),
  );
}
