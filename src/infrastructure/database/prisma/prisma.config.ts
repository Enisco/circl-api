import { Prisma } from '@prisma/client';

export const prismaConfig: Prisma.PrismaClientOptions = {
  log: ['error', 'warn'],
  errorFormat: 'minimal',
};

export const isDevelopment = process.env.NODE_ENV === 'local';

if (isDevelopment) {
  prismaConfig.log = ['query', 'error', 'warn'];
}
