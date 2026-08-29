import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { Pool } from 'pg';
import { resetDemo, seedDemo } from './seeders/demo';

/** The demo dataset, run on its own (Appendix B). */
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool as unknown as ConstructorParameters<typeof PrismaPg>[0]);
const prisma = new PrismaClient({ adapter, log: ['error', 'warn'] });

const main = async () => {
  await prisma.$connect();

  const reset = process.argv.includes('--reset');
  const only = process.argv.includes('--reset-only');

  if (reset || only) await resetDemo(prisma);
  if (!only) await seedDemo(prisma);
};

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
