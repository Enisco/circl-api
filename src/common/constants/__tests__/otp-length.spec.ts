import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FIXED_OTP, OTP_LENGTH, fixedOtp } from '../dev-otp.constant';
import { Util } from '../../util';

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

/** Every file under `src` that calls `generateOtp`, found the way a reviewer would. */
const generateOtpCallers = (): string[] =>
  execFileSync('grep', ['-rl', 'generateOtp', join(ROOT, 'src')], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map(path => path.replace(`${ROOT}/`, ''))
    // Not the tests, which quote the thing they forbid in order to explain it.
    .filter(path => !path.includes('__tests__'));

/** True for a line that is prose rather than code, so a comment can name `generateOtp(4)`. */
const isComment = (text: string) =>
  text.startsWith('//') || text.startsWith('*') || text.startsWith('/*');

/**
 * One code length across the whole API, and one development code.
 *
 * This exists because the invariant is spread across files that have no reason to know about each
 * other: the constant, the generator, four call sites, three DTOs that validate what arrives, and
 * the e2e harness that types it. Member sign-in was four digits while everything else was six, and
 * nothing anywhere would have told you — the mismatch only showed up as a mobile app that could
 * not sign in after the length changed on one side.
 */
describe('one-time codes', () => {
  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.APP_ENV;
    delete process.env.DEV_FIXED_OTP;
  });

  it('has a development code of exactly the length the API generates', () => {
    expect(FIXED_OTP).toHaveLength(OTP_LENGTH);
    expect(FIXED_OTP).toMatch(/^[0-9]+$/);
  });

  it('generates that many digits, fixed or random', () => {
    process.env.APP_ENV = 'local';
    expect(Util.generateOtp()).toBe(FIXED_OTP);

    // The real path, which must agree on length or the DTOs refuse what it produces.
    process.env.DEV_FIXED_OTP = 'false';
    const random = Util.generateOtp();

    expect(random).toHaveLength(OTP_LENGTH);
    expect(random).toMatch(/^[0-9]+$/);
  });

  /**
   * Refusing beats truncating.
   *
   * A short development code would be rejected by the DTO that validates it, which reads as a
   * broken endpoint rather than a mismatched constant. Falling through to a random code leaves the
   * flow working and the cause findable.
   */
  it('declines to supply a fixed code of any other length', () => {
    process.env.APP_ENV = 'local';
    expect(fixedOtp(OTP_LENGTH)).toBe(FIXED_OTP);
    expect(fixedOtp(4)).toBeNull();
    expect(fixedOtp(OTP_LENGTH + 2)).toBeNull();
  });

  /** Either signal, because they disagree in the one configuration that matters. */
  it.each(['NODE_ENV', 'APP_ENV'])('is never fixed when %s says production', variable => {
    process.env[variable] = 'production';
    expect(fixedOtp(OTP_LENGTH)).toBeNull();
    expect(Util.generateOtp()).not.toBe(FIXED_OTP);
  });

  it('is actually looking at the call sites', () => {
    // A sentinel: a scan that matches nothing reports success for ever.
    expect(generateOtpCallers().length).toBeGreaterThanOrEqual(5);
  });

  /**
   * No call site names its own length.
   *
   * This is the rule that keeps the six in one place. `generateOtp(4)` compiled, passed every
   * test, and gave member sign-in a hundredth of the keyspace of the code that confirms an email
   * change — the weaker factor guarding the larger thing.
   */
  it('has no call site passing a literal length', () => {
    const offenders = generateOtpCallers().flatMap(file =>
      read(file)
        .split('\n')
        .map((line, index) => ({ file, line: index + 1, text: line.trim() }))
        .filter(entry => !isComment(entry.text) && /generateOtp\(\s*\d/.test(entry.text)),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * And every DTO that validates an arriving code agrees with the constant.
   *
   * Checked as text because that is where the number actually lives: `class-validator` decorators
   * take literals, so a `Length(6, 6)` cannot be written in terms of `OTP_LENGTH` without a
   * computed decorator argument that is harder to read than the number it replaces.
   */
  it.each([
    'src/modules/core/auth/dtos/verify-email.dto.ts',
    'src/modules/platform/account/dtos/deletion.dto.ts',
    'src/modules/platform/account/dtos/account.dto.ts',
  ])('%s validates a code of OTP_LENGTH digits', relative => {
    const text = read(relative);

    // No closing paren: two of the three pass a `message` after the bounds.
    expect(text).toContain(`Length(${OTP_LENGTH}, ${OTP_LENGTH}`);

    // Only where the DTO also pins a pattern; two of the three rely on `Length` alone.
    if (text.includes('@Matches(/^[0-9]')) {
      expect(text).toContain(`@Matches(/^[0-9]{${OTP_LENGTH}}$/`);
    }
  });
});
