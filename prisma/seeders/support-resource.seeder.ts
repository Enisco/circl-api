import { PrismaClient } from '@prisma/client';

/** The UK crisis and advice lines (6.3.3). */
const RESOURCES: Array<{
  name: string;
  phone: string;
  url: string;
  hours: string;
  /** What the line is for, in the member's words. The app renders it under the name. */
  description: string;
  isCrisis: boolean;
}> = [
  {
    name: 'Samaritans',
    phone: '116 123',
    url: 'https://www.samaritans.org',
    hours: 'Free, 24 hours a day',
    description: 'Free, any time, for anything that is weighing on you.',
    isCrisis: true,
  },
  {
    name: 'National Domestic Abuse Helpline',
    phone: '0808 2000 247',
    url: 'https://www.nationaldahelpline.org.uk',
    hours: 'Free, 24 hours a day',
    description: 'If you are frightened of someone at home, or someone you know is.',
    isCrisis: true,
  },
  {
    name: 'Shelter: housing advice',
    phone: '0808 800 4444',
    url: 'https://www.shelter.org.uk',
    hours: '8am to 8pm weekdays, 9am to 5pm weekends',
    description: 'Eviction, disrepair, homelessness and landlords who will not act.',
    isCrisis: false,
  },
  {
    name: 'Citizens Advice',
    phone: '0800 144 8848',
    url: 'https://www.citizensadvice.org.uk',
    hours: '9am to 5pm, weekdays',
    description: 'Benefits, debt, work and consumer problems, explained plainly.',
    isCrisis: false,
  },
  {
    name: 'Modern Slavery & Exploitation Helpline',
    phone: '08000 121 700',
    url: 'https://www.modernslaveryhelpline.org',
    hours: 'Free, 24 hours a day',
    description: 'If you are being made to work or live somewhere against your will.',
    isCrisis: true,
  },
  {
    name: 'Migrant Help: asylum support',
    phone: '0808 8010 503',
    url: 'https://www.migranthelpuk.org',
    hours: 'Free, 24 hours a day',
    description: 'Asylum support, accommodation and what you are entitled to ask for.',
    isCrisis: false,
  },
];

export const seedSupportResources = async (prisma: PrismaClient) => {
  console.info('Seeding support resources...');

  for (const [index, resource] of RESOURCES.entries()) {
    const existing = await prisma.supportResource.findFirst({
      where: { countryCode: 'GB', name: resource.name },
    });

    if (existing) {
      await prisma.supportResource.update({
        where: { id: existing.id },
        data: { ...resource, sort: index + 1, lastCheckedAt: new Date() },
      });
      continue;
    }

    await prisma.supportResource.create({
      data: { ...resource, countryCode: 'GB', sort: index + 1, lastCheckedAt: new Date() },
    });
  }

  console.info(`  ✅ Seeded ${RESOURCES.length} support resources`);
};
