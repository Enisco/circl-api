import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { CONTENT_SOURCE } from '../content-source';

/**
 * `CONTENT_SOURCE` is a map of strings that nothing else checks.
 *
 * Every value in it is used to build raw SQL or a `media` lookup in a worker, a second after the
 * member has been told their post went up. A table name with a typo in it is a runtime error
 * nobody sees; an `owner_type` that no code attaches under is worse, because it fails silently —
 * the lookup returns no rows, the classifier is shown no images, and the scan looks like it
 * worked. That is exactly how this map's first version claimed a Connect profile owned
 * `CONNECT_POSTER`, which is a video's poster frame attached to a *post*.
 *
 * So both halves are checked against the rest of the codebase rather than against themselves.
 */
const root = join(__dirname, '../../../../../..');

const read = (dir: string, match: RegExp): string => {
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap(entry => {
      const full = join(path, entry.name);

      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);

      return match.test(entry.name) ? [readFileSync(full, 'utf8')] : [];
    });

  return walk(join(root, dir)).join('\n');
};

describe('CONTENT_SOURCE', () => {
  const sources = Object.entries(CONTENT_SOURCE);

  it('names tables that exist in the schema', () => {
    const schema = read('prisma/models', /\.prisma$/);
    const tables = new Set([...schema.matchAll(/@@map\("([a-z_]+)"\)/g)].map(groups => groups[1]));

    expect(tables.size).toBeGreaterThan(40);

    const missing = sources
      .filter(([, source]) => !tables.has(source!.table))
      .map(([target, source]) => `${target} → ${source!.table}`);

    expect(missing).toEqual([]);
  });

  it('names visibility columns that exist on those tables', () => {
    const schema = read('prisma/models', /\.prisma$/);
    const columns = new Set([...schema.matchAll(/@map\("([a-z_]+)"\)/g)].map(groups => groups[1]));

    const missing = sources
      .filter(([, source]) => source!.column && !columns.has(source!.column!))
      .map(([target, source]) => `${target} → ${source!.column}`);

    expect(missing).toEqual([]);
  });

  it('names media owners that something actually attaches under', () => {
    // The `*_OWNER = '...'` constants every `MediaService.attach` call passes.
    const code = read('src', /\.ts$/);
    const owners = new Set(
      [...code.matchAll(/_OWNER\s*=\s*'([A-Z_]+)'/g)].map(groups => groups[1]),
    );

    expect(owners.size).toBeGreaterThan(10);

    const invented = sources
      .flatMap(([target, source]) => (source!.mediaOwners ?? []).map(owner => ({ target, owner })))
      .filter(({ owner }) => !owners.has(owner))
      .map(({ target, owner }) => `${target} → ${owner}`);

    expect(invented).toEqual([]);
  });

  it('gives the targets that can hold images a way to find them', () => {
    const withImages = sources.filter(
      ([, source]) => source!.mediaOwners?.length || source!.ownKey,
    );

    // Eleven of the eighteen content kinds, plus `MEDIA`, which *is* an image. The seven without
    // are a response, two kinds of reply, a Connect profile (its photos are its posts), a
    // service, a review and the written part of a profile — none of which takes a photo of its
    // own.
    expect(withImages).toHaveLength(12);
  });
});
