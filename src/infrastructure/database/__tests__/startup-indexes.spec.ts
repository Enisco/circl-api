import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { INVISIBLE_INDEX_STATEMENTS } from '../startup-indexes';

const EXTRA_INDEXES = join(process.cwd(), 'prisma', 'sql', 'extra-indexes.sql');
const MODELS = join(process.cwd(), 'prisma', 'models');

const nameOf = (statement: string): string => /IF NOT EXISTS "([^"]+)"/.exec(statement)![1];

/**
 * Whitespace, casing, `= true` and the comment above it are not the difference between two index
 * definitions. What is left is the statement itself.
 */
const shape = (statement: string): string =>
  statement
    .split('\n')
    .filter(line => !/^\s*--/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/ = true\b/gi, '')
    .replace(/;$/, '')
    .trim()
    .toLowerCase();

const extraIndexes = (): Map<string, string> => {
  const found = new Map<string, string>();

  for (const statement of readFileSync(EXTRA_INDEXES, 'utf8').split(';')) {
    if (/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "/.test(statement)) {
      found.set(nameOf(statement), statement);
    }
  }

  return found;
};

const prismaSchema = (): string =>
  readdirSync(MODELS)
    .filter(file => file.endsWith('.prisma'))
    .map(file => readFileSync(join(MODELS, file), 'utf8'))
    .join('\n');

/**
 * Two files describe these indexes, for two different reasons: one re-asserts them at boot, the
 * other is replayed into every generated migration. They have come apart repeatedly — an index
 * added to the boot guard and not to the file, so every generated migration silently dropped it,
 * and a predicate that differed between them, where whichever ran first won and the other never
 * corrected it. Neither failure shows until something is slow or a rule quietly stops holding.
 */
describe('the indexes Prisma cannot describe', () => {
  const asserted = INVISIBLE_INDEX_STATEMENTS;
  const partial = asserted.filter(statement => /WHERE/i.test(statement));
  const trigram = asserted.filter(statement => /gin_trgm_ops/.test(statement));

  it('is the whole boot guard, partial and trigram', () => {
    expect(partial).toHaveLength(3);
    expect(trigram.length).toBeGreaterThanOrEqual(15);
    expect(partial.length + trigram.length).toBe(asserted.length);
  });

  it('every partial one is in extra-indexes.sql, or a generated migration drops it', () => {
    const file = extraIndexes();
    const absent = partial.map(nameOf).filter(name => !file.has(name));

    expect(absent).toEqual([]);
  });

  it('and both files define it the same way, down to the WHERE clause', () => {
    const file = extraIndexes();
    const differing = partial
      .filter(statement => shape(file.get(nameOf(statement)) ?? '') !== shape(statement))
      .map(nameOf);

    expect(differing).toEqual([]);
  });

  it('every trigram one is declared in the schema, which is what protects those', () => {
    const schema = prismaSchema();
    const undeclared = trigram.map(nameOf).filter(name => !schema.includes(name));

    expect(undeclared).toEqual([]);
  });
});
