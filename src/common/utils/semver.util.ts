/**
 * App versions, compared numerically and validated as what the stores actually accept.
 *
 * Here rather than in the one service that first needed it: §5.21 compares versions in three
 * places — the policy's own ordering check, the public version-policy endpoint, and the
 * force-update interceptor that runs on every member request — and three copies of "is 2.10.0
 * newer than 2.9.0" is three chances to get the string comparison that gets it backwards.
 */

/** `1.2.3`, with an optional build suffix (`1.2.3-rc.1`, `1.2.3+42`). */
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export const isSemver = (value: unknown): value is string =>
  typeof value === 'string' && SEMVER.test(value);

/**
 * Negative when `left` is older, positive when newer, zero when the same release.
 *
 * Numeric part by numeric part, because `2.10.0` sorts *before* `2.9.0` as a string — and a
 * release list in the wrong order is read as the wrong release. A missing part counts as zero, so
 * `1.2` and `1.2.0` are the same version.
 *
 * A build suffix is ignored for ordering: `1.2.3-rc.1` and `1.2.3` are the same release as far as
 * a minimum version is concerned, and treating a release candidate as *older* than the release
 * would force-update a tester who is ahead of everybody.
 */
export const compareVersions = (left: string, right: string): number => {
  const parts = (value: string) =>
    value
      .split(/[-+]/)[0]
      .split('.')
      .map(part => Number.parseInt(part, 10));
  const a = parts(left);
  const b = parts(right);

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = Number.isFinite(a[index]) ? a[index] : 0;
    const two = Number.isFinite(b[index]) ? b[index] : 0;

    if (one !== two) return one - two;
  }

  return 0;
};

/** Whether `version` is at or above `floor`. An unparseable version is never above anything. */
export const atLeast = (version: string | null | undefined, floor: string): boolean =>
  isSemver(version) && compareVersions(version, floor) >= 0;
