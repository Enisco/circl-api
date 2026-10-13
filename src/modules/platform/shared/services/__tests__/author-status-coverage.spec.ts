import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every reader-facing content query says what it does about a **suspended author** (§13.2).
 *
 * The companion to `content-visibility-coverage.spec.ts`, and the same shape of problem one layer
 * along. That test asks "does this query think about whether the *item* is visible"; this one asks
 * "does it think about whether the *person who wrote it* is suspended".
 *
 * It exists because the answer across the platform was no. A suspension stopped somebody signing
 * in and left every post, guide, review, listing and shop of theirs exactly where it was — so a
 * suspension issued *for* harmful content left the content up. One hundred and seven call sites
 * apply a visibility fragment, and adding the author filter to a hundred and six of them is the
 * failure mode this guards: the surface nobody remembers is the one that keeps serving it.
 *
 * ## Scope: distribution reads only
 *
 * Only queries that already apply `PUBLIC_VISIBILITY` or `DIRECT_VISIBILITY` are in scope, because
 * those are the reads that serve content to somebody other than its author. An ownership check, a
 * re-read after a write, the author's own drafts and every staff query are out of scope by
 * construction — they do not carry a visibility fragment either.
 *
 * ## Exemptions are written down
 *
 * `author-status:` in the nine lines above the query means read, considered and deliberately not
 * filtered. §13.2 itself names the legitimate ones: a group stays visible and keeps its owner, and
 * a booking or an order stays readable by the counterpart. Those comments are the point — they
 * turn "did anybody think about this one?" into something the file answers.
 */

/** Reader-facing: the query is serving content to somebody who did not write it. */
const DISTRIBUTION = ['PUBLIC_VISIBILITY', 'DIRECT_VISIBILITY'];

/** Any of these settles the question. */
const APPLIED = ['ACTIVE_AUTHOR', 'activeAuthorSql', 'ACTIVE_OR_NO_AUTHOR'];

/** "Read, considered, and deliberately not filtered on the author." */
const EXEMPTION = 'author-status:';

const MODELS = [
  'communityRequest',
  'requestResponse',
  'communityOffer',
  'communityUpdate',
  'updateReply',
  'guide',
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
  if (/\{\s*where\s*[,}]/.test(args)) names.add('where');

  return [...names];
};

/**
 * Whether the thing that built this `where` applies the rule — or is itself a distribution read.
 *
 * Two hops, like its sibling. A `where` assembled in one place and used in five is the pattern
 * this has to resolve, because the rule belongs with the builder.
 */
const builderMentions = (text: string, name: string, tokens: string[], hops = 0): boolean => {
  if (hops > 2) return false;

  const assignment = new RegExp(
    `(?:const|let)\\s+${name}(?:\\s*:[^=]+)?=\\s*(await\\s+this\\.(\\w+)\\(|[\\s\\S]{0,4000}?)`,
  ).exec(text);

  if (!assignment) return false;

  const method = assignment[2];

  if (method) {
    const body = new RegExp(`(?:async\\s+)?${method}\\s*\\([\\s\\S]{0,6000}`).exec(text);

    return !!body && tokens.some(token => body[0].slice(0, 4000).includes(token));
  }

  const from = text.indexOf(assignment[0]);
  const window = text.slice(from, from + 4000);
  const end = window.indexOf('\n    };');
  const literal = window.slice(0, end === -1 ? 2000 : end);

  if (tokens.some(token => literal.includes(token))) return true;

  return [...literal.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)].some(
    match => match[1] !== name && builderMentions(text, match[1], tokens, hops + 1),
  );
};

describe('suspended-author coverage (§13.2)', () => {
  const unexplained: string[] = [];
  let distribution = 0;

  for (const file of sourceFiles(PLATFORM)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');

    for (const match of text.matchAll(CALL)) {
      const open = match.index! + match[0].length - 1;
      const args = argumentsOf(text, open);
      const lineNumber = text.slice(0, match.index!).split('\n').length;
      const preceding = lines.slice(Math.max(0, lineNumber - 9), lineNumber).join('\n');
      const names = whereIdentifiers(args);

      // In scope only if this read serves content to somebody other than its author.
      const isDistribution =
        DISTRIBUTION.some(token => args.includes(token)) ||
        names.some(name => builderMentions(text, name, DISTRIBUTION));

      if (!isDistribution) continue;

      distribution += 1;

      if (APPLIED.some(token => args.includes(token))) continue;
      if (preceding.includes(EXEMPTION)) continue;
      if (names.some(name => builderMentions(text, name, APPLIED))) continue;

      unexplained.push(`${file.replace(/.*\/src\//, 'src/')}:${lineNumber}`);
    }
  }

  /**
   * The sentinel, for the same reason its sibling has one: a source-scanning test can pass because
   * the pattern stopped matching, and that is the one failure it cannot report itself.
   */
  it('actually finds the distribution reads it is meant to be checking', () => {
    expect(distribution).toBeGreaterThan(60);
  });

  it('has an answer for every one of them', () => {
    expect(unexplained).toEqual([]);
  });
});
