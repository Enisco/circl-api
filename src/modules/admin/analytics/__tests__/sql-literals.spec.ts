import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ANALYTICS = join(__dirname, '..');

const sources = readdirSync(ANALYTICS)
  .filter(name => name.endsWith('.ts'))
  .map(name => ({ name, text: readFileSync(join(ANALYTICS, name), 'utf8') }));

const names = sources.map(source => source.name);
const sourceFor = (name: string) => sources.find(entry => entry.name === name)!;

/** The lines of a file that are SQL comments, with the comment text. */
const sqlComments = (text: string): string[] =>
  text
    .split('\n')
    .map(line => line.match(/--\s?(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(match => match[1]);

describe('SQL in the analytics', () => {
  /**
   * A sentinel, because a scan that silently matches nothing is worse than no scan: it reports
   * success. The first version of this file matched two SQL blocks out of dozens — its regex could
   * not cope with `Array<{…}>>` in the type argument — and would have passed every file for ever.
   */
  it('is actually looking at SQL', () => {
    expect(sqlComments(sources.map(source => source.text).join('\n')).length).toBeGreaterThan(30);
    expect(names.length).toBeGreaterThan(8);
  });

  /**
   * A backtick inside a `Prisma.sql` template literal ends the string.
   *
   * Three debugging sessions in one milestone, every one of them somebody quoting a column or a
   * function name in a SQL comment — which is the natural way to write prose about SQL and the one
   * way that breaks it. In `growth.analytics.ts` the remainder happened to parse as TypeScript, so
   * it compiled and threw at runtime reading as "deleted_at is not defined"; in the other two it
   * was a parse error, which is the lucky case.
   *
   * The habit this enforces: inside SQL, name things in CAPITALS or in plain words, never in
   * backticks. Checked here rather than left to a grep because a grep only runs when somebody
   * remembers it, and the failure mode is invisible — the literal simply ends early.
   */
  it.each(names)('%s has no backtick in a SQL comment', name => {
    const offenders = sqlComments(sourceFor(name).text).filter(comment => comment.includes('`'));

    expect(offenders).toEqual([]);
  });

  /**
   * A `UNION ALL` takes its column names from whichever arm comes first, so an arm that does not
   * alias its columns is fine until somebody reorders the arms — at which point a filter on the
   * missing name fails with "column does not exist". That is exactly how `?targetType=GUIDE` broke
   * the member content tab.
   */
  it.each(names)('%s aliases the columns of every UNION arm', name => {
    const { text } = sourceFor(name);
    const unaliased: string[] = [];

    for (const match of text.matchAll(/UNION\s+ALL/gi)) {
      const at = match.index!;
      // The arm before the keyword, and the arm after it. Taking a window either side rather than
      // parsing the statement: the point is to look at the two SELECTs the keyword joins.
      const before = [
        ...text.slice(Math.max(0, at - 1200), at).matchAll(/SELECT\s+([\s\S]*?)\sFROM\s/gi),
      ].at(-1);
      const after = text.slice(at, at + 1200).match(/SELECT\s+([\s\S]*?)\sFROM\s/i);

      for (const arm of [before, after]) {
        if (!arm) continue;

        const columns = arm[1]
          // A CASE or a function call holds commas of its own, so collapse anything bracketed
          // before splitting at the top level.
          .replace(/\([^()]*\)/g, '()')
          .replace(/\([^()]*\)/g, '()')
          .split(',')
          .map(column => column.replace(/--[^\n]*/g, '').trim())
          .filter(column => column.length > 0);

        for (const column of columns) {
          if (column === '*' || /\sAS\s+"?\w+"?$/i.test(column)) continue;

          unaliased.push(`${column.slice(0, 70)}`);
        }
      }
    }

    expect(unaliased).toEqual([]);
  });
});
