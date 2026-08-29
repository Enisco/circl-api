import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { Pool } from 'pg';
import { seedCities } from './seeders/city.seeder';
import { seedPermissions } from './seeders/permission.seeder';
import { seedRiskTerms } from './seeders/risk-term.seeder';
import { seedRoles } from './seeders/role.seeder';
import { seedSupportResources } from './seeders/support-resource.seeder';
import { seedTaxonomy } from './seeders/taxonomy.seeder';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool as unknown as ConstructorParameters<typeof PrismaPg>[0]);
const prisma = new PrismaClient({ adapter, log: ['error', 'warn', 'info'] });

const main = async () => {
  console.info('Starting database seeding...');

  try {
    await prisma.$connect();
    console.info('Connected to database');

    await seedPermissions(prisma);
    await seedRoles(prisma);
    await seedCities(prisma);
    await seedTaxonomy(prisma);
    await seedRiskTerms(prisma);
    await seedSupportResources(prisma);

    console.info('Database seeding completed successfully');
  } catch (error) {
    console.error('Database seeding failed:', error);
    throw error;
  }
};

main()
  .catch(e => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
    console.info('Disconnected from database');
  });
