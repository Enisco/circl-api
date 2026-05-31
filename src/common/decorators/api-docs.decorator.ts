import { applyDecorators } from '@nestjs/common';

export function ApiDocs(...decorators: any[]) {
  return applyDecorators(...decorators);
}
