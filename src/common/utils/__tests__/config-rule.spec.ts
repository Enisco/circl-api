import { SYSTEM_CONFIG_DEFAULTS, SYSTEM_CONFIG_META } from '../../constants/system-config.constant';
import { checkConfigValue } from '../config-rule.util';
import { atLeast, compareVersions, isSemver } from '../semver.util';

/**
 * Every key's own default must satisfy its own rule.
 *
 * This is the assertion that earns the registry: a rule written slightly tighter than the value it
 * describes makes a settings screen that refuses to save what is already stored, and nobody finds
 * that out until somebody opens the screen and presses save.
 */
describe('every config default satisfies its own rule', () => {
  it.each(Object.keys(SYSTEM_CONFIG_META))('%s', key => {
    const rule = SYSTEM_CONFIG_META[key].rule;
    const value = (SYSTEM_CONFIG_DEFAULTS as Record<string, unknown>)[key];

    expect(checkConfigValue(rule, value)).toEqual([]);
  });

  it('describes every key that has a default, except the ones with their own endpoint', () => {
    const described = new Set(Object.keys(SYSTEM_CONFIG_META));
    const missing = Object.keys(SYSTEM_CONFIG_DEFAULTS).filter(key => !described.has(key));

    // `appVersions` is deliberately absent: semver, ordering and a store host per platform are
    // not an "edit this JSON" box, and §5.21 gives it `PUT admin/config/app-versions`.
    expect(missing).toEqual(['appVersions']);
  });
});

describe('what a refusal says', () => {
  it('names the field, the limit and the value', () => {
    const problems = checkConfigValue(SYSTEM_CONFIG_META['limits.maxInterests'].rule, 300);

    expect(problems).toEqual(['must be between 1 and 30 (got 300)']);
  });

  it('refuses a tier order that leaves a band nothing can land in', () => {
    const problems = checkConfigValue(SYSTEM_CONFIG_META['safety.tierThresholds'].rule, {
      low: 1,
      medium: 80,
      high: 55,
      critical: 90,
    });

    expect(problems).toEqual(['high (55) must be above medium (80)']);
  });

  it('names a key nobody meant to send, rather than ignoring it', () => {
    const problems = checkConfigValue(SYSTEM_CONFIG_META['safety.tierThresholds'].rule, {
      low: 1,
      medium: 30,
      high: 55,
      critical: 90,
      criticall: 95,
    });

    expect(problems).toEqual(['“criticall” is not a setting on this key']);
  });

  it('says which required field is missing', () => {
    expect(
      checkConfigValue(SYSTEM_CONFIG_META['reports.slaMinutes'].rule, { URGENT: 60, HIGH: 240 }),
    ).toEqual(['“NORMAL” is required']);
  });

  it('checks the working-hours clock format', () => {
    expect(
      checkConfigValue(SYSTEM_CONFIG_META['moderation.workingHours'].rule, {
        tz: 'Europe/London',
        days: [1, 2, 3, 4, 5],
        start: '9am',
        end: '18:00',
      }),
    ).toEqual(['start: is not in the expected form']);
  });

  /**
   * The three ways `moderation.workingHours` could be saved wrong and only break something else.
   *
   * Every one of them was storable: the zone was checked by length and then threw inside the
   * deadline calculation on the write path of an anonymous post; the days were accepted as text
   * and compared as numbers, so a Saturday configured that way made every day a non-working day;
   * and a window could close before it opened, which silently turns every working-hours deadline
   * into a wall-clock one.
   */
  const workingHours = (over: Record<string, unknown>) =>
    checkConfigValue(SYSTEM_CONFIG_META['moderation.workingHours'].rule, {
      tz: 'Europe/London',
      days: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '18:00',
      ...over,
    });

  it('refuses a time zone the platform does not know', () => {
    expect(workingHours({ tz: 'Europe/Londn' })).toEqual([
      'tz: “Europe/Londn” is not a time zone — use an IANA name such as Europe/London',
    ]);
    // An alias a hand-written list would have missed, which is why the zone database is asked.
    expect(workingHours({ tz: 'Europe/Kyiv' })).toEqual([]);
    expect(workingHours({ tz: 'UTC' })).toEqual([]);
  });

  it('refuses days sent as text, which is how a configured Saturday matched nothing', () => {
    expect(workingHours({ days: ['6'] })).toEqual([
      'days: “6” must be one of 1, 2, 3, 4, 5, 6, 7, as a number',
    ]);
    expect(workingHours({ days: [6] })).toEqual([]);
  });

  it('refuses a window that closes before it opens', () => {
    expect(workingHours({ start: '18:00', end: '09:00' })).toEqual([
      'end (09:00) must be after start (18:00)',
    ]);
    expect(workingHours({ start: '09:00', end: '09:00' })).toEqual([
      'end (09:00) must be after start (09:00)',
    ]);
  });
});

describe('app versions compare numerically', () => {
  it('knows 2.10.0 is newer than 2.9.0, which string order gets backwards', () => {
    expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
    expect('2.10.0' > '2.9.0').toBe(false);
  });

  it('treats a missing part as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  it('ignores a build suffix, so a tester ahead of the release is not forced back', () => {
    expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBe(0);
    expect(atLeast('1.2.3-rc.1', '1.2.3')).toBe(true);
  });

  it('never reads an unparseable version as current', () => {
    expect(atLeast(undefined, '1.0.0')).toBe(false);
    expect(atLeast('', '1.0.0')).toBe(false);
    expect(atLeast('nightly', '1.0.0')).toBe(false);
    expect(isSemver('1.0')).toBe(false);
  });
});
