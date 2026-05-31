import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { join } from 'path';
import { URL } from 'url';
import { ulid } from 'ulid';

const prisma = new PrismaClient();

const generateDatabaseURL = (schema: string) => {
  if (!process.env.DATABASE_URL) {
    throw new Error('please provide a database url');
  }
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.append('schema', schema);
  return url.toString();
};

const schemaId = `test-${ulid()}`;
const prismaBinary = join(__dirname, '..', 'node_modules', '.bin', 'prisma');

beforeAll(async () => {
  const databaseURL = generateDatabaseURL(schemaId);
  process.env.DATABASE_URL = databaseURL;
  execSync(`${prismaBinary} migrate deploy`, {
    env: {
      ...process.env,
      DATABASE_URL: databaseURL,
    },
  });
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaId}" CASCADE;`);
  await prisma.$disconnect();
});
