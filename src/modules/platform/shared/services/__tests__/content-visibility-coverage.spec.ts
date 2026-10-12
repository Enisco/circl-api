import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every query against a content table says what it does about visibility.
 *
 * §6.5 asks for "a shared `publicVisibility()` Prisma fragment and a lint test that greps list
 * queries for it", and the reason is the shape of the mistake: a held post is removed from eleven
 * surfaces and left on the twelfth, and nothing fails. There is no test for the twelfth surface,
 * because nobody wrote one — that is what being forgotten means.
 *
 * So this is a coverage test rather than a behaviour test. Every read of a content table must
 * either apply one of the fragments, or carry a `visibility:` comment saying why it does not —
 * because plenty of them legitimately do not: an ownership check before a write, the author's own
 * drafts, a staff read, a re-read of the row a mutation just wrote. The comment is the point. It
 * turns "did somebody think about this one?" into something the file answers.
 *
 * A query that passes a `where` built elsewhere in the same file is resolved one hop: the rule
 * belongs with the builder, not copied to every call site that uses it.
 */

/** The tables that carry `visibilityState` (§4.5), as Prisma's client names them. */
const MODELS = [
  'communityRequest',
  'requestResponse',
  'communityOffer',
  'communityUpdate',
  'updateReply',
  'guide',
  'group',
  'groupPost',
  'groupPostReply',
  'connectProfile',
  'connectPost',
  'connectStory',
  'professionalListing',
  'professionalService',
  'store',
  'storeItem',
  'review',
];

const OPERATIONS = [
  'findMany',
  'findFirst',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
];

/** Any of these in the call, or in the `where` it was handed, settles the question. */
const APPLIED = ['PUBLIC_VISIBILITY', 'DIRECT_VISIBILITY', 'visibilityState'];

/** The comment that says "read, considered, and deliberately not filtered". */
const EXEMPTION = 'visibility:';

/**
 * The single-item form of the rule, which cannot be a `where` clause.
 *
 * A detail read has to tell a held item from a missing one — the author still sees theirs — so it
 * loads the row and then decides. Those decisions are these two helpers and nothing else, so
 * finding one just below the query is as good as a filter inside it.
 */
const GUARDS = ['isReachable(', 'isPublic('];

/**
 * How far below a query the guard may sit and still be about that query.
 *
 * Twenty-four lines, because a detail read usually counts a view and loads its media between the
 * query and the check. Only `isReachable`/`isPublic` count, and they exist for nothing else, so a
 * wide window cannot accept an unrelated query by accident.
 */
const GUARD_WINDOW = 24;

const CALL = new RegExp(`\\.(${MODELS.join('|')})\\.(${OPERATIONS.join('|')})\\(`, 'g');

const PLATFORM = join(__dirname, '../../../..', 'platform');

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);

    return path.endsWith('.ts') ? [path] : [];
  });

/** The text between the call's parentheses, by counting them. */
const argumentsOf = (text: string, openIndex: number): string => {
  let depth = 0;

  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') {
      depth -= 1;

      if (depth === 0) return text.slice(openIndex, index + 1);
    }
  }

  return text.slice(openIndex);
};

/** The `where` identifiers a call was handed, rather than an inline object. */
const whereIdentifiers = (args: string): string[] => {
  const names = new Set<string>();

  for (const match of args.matchAll(/where:\s*([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of args.matchAll(/where:\s*\{\s*\.\.\.([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  // The shorthand `{ where }`.
  if (/\{\s*where\s*[,}]/.test(args)) names.add('where');

  return [...names];
};

/**
 * Whether the thing that built this `where` applies the rule.
 *
 * Two hops at most: `where` is assigned from an object literal, from a method in the same file,
 * or from a narrowing of another `where` (`{ ...where, cityId }`), which is how the professionals
 * directory pages one city at a time. Chasing further would be writing a type checker, and a rule
 * three hops from its call site is already too far from it to be read.
 */
const builderApplies = (text: string, name: string, hops = 0): boolean => {
  if (hops > 2) return false;

  const assignment = new RegExp(
    `(?:const|let)\\s+${name}(?:\\s*:[^=]+)?=\\s*(await\\s+this\\.(\\w+)\\(|[\\s\\S]{0,4000}?)`,
  ).exec(text);

  if (!assignment) return false;

  const method = assignment[2];

  if (method) {
    const body = new RegExp(`(?:async\\s+)?${method}\\s*\\([\\s\\S]{0,6000}`).exec(text);

    return !!body && APPLIED.some(token => body[0].slice(0, 4000).includes(token));
  }

  // An object literal: look at the statement it starts, which ends at the first `};` that closes it.
  const from = text.indexOf(assignment[0]);
  const window = text.slice(from, from + 4000);
  const end = window.indexOf('\n    };');
  const literal = window.slice(0, end === -1 ? 2000 : end);

  if (APPLIED.some(token => literal.includes(token))) return true;

  // `{ ...other, … }`: the rule may be on what it narrows.
  return [...literal.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)].some(
    match => match[1] !== name && builderApplies(text, match[1], hops + 1),
  );
};

describe('content visibility coverage (§6.5)', () => {
  const unexplained: string[] = [];
  let examined = 0;

  for (const file of sourceFiles(PLATFORM)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');

    for (const match of text.matchAll(CALL)) {
      examined += 1;

      const open = match.index! + match[0].length - 1;
      const args = argumentsOf(text, open);
      const lineNumber = text.slice(0, match.index!).split('\n').length;
      const preceding = lines.slice(Math.max(0, lineNumber - 9), lineNumber).join('\n');

      const following = lines.slice(lineNumber, lineNumber + GUARD_WINDOW).join('\n');

      if (APPLIED.some(token => args.includes(token))) continue;
      if (preceding.includes(EXEMPTION)) continue;
      if (GUARDS.some(guard => following.includes(guard))) continue;
      if (whereIdentifiers(args).some(name => builderApplies(text, name))) continue;

      unexplained.push(`${file.replace(/.*\/src\//, 'src/')}:${lineNumber}`);
    }
  }

  /**
   * The sentinel. A test that scans source for a pattern can pass because the pattern stopped
   * matching, which is the one failure it cannot report — so the count is asserted. If a rename
   * or a refactor takes this below the floor, it is this line that says so rather than a green
   * run over nothing. (`sql-literals.spec.ts` was caught by its own version of this.)
   */
  it('actually finds the queries it is meant to be checking', () => {
    expect(examined).toBeGreaterThan(150);
  });

  it('has an answer for every content query', () => {
    expect(unexplained).toEqual([]);
  });
});
