import { ConfigRule } from '../constants/system-config.constant';

/**
 * Checks a value against its key's rule, and says what is wrong in words.
 *
 * The message is the whole reason this is not a JSON Schema validator. A schema library's output —
 * `/low: must be <= 100`, against a draft pointer — is a sentence for a developer; the person
 * reading it typed 300 into a box labelled "Low" and needs to be told the ceiling. So each refusal
 * names the field, the limit and the value.
 *
 * Returns the problems rather than throwing, so a caller can turn them into one 422 listing all of
 * them. An empty array means the value is storable.
 */
export const checkConfigValue = (rule: ConfigRule, value: unknown, path = ''): string[] => {
  const at = path ? `${path}: ` : '';

  switch (rule.type) {
    case 'integer':
      if (!Number.isInteger(value)) return [`${at}must be a whole number`];
      if ((value as number) < rule.min || (value as number) > rule.max) {
        return [`${at}must be between ${rule.min} and ${rule.max} (got ${value as number})`];
      }

      return [];

    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${at}must be a number`];
      if (value < rule.min || value > rule.max) {
        return [`${at}must be between ${rule.min} and ${rule.max} (got ${value})`];
      }

      return [];

    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at}must be true or false`];

    case 'string':
      if (typeof value !== 'string') return [`${at}must be text`];
      if (rule.maxLength && value.length > rule.maxLength) {
        return [`${at}must be ${rule.maxLength} characters or fewer`];
      }
      if (rule.pattern && !rule.pattern.test(value)) return [`${at}is not in the expected form`];

      return [];

    case 'stringList': {
      if (!Array.isArray(value)) return [`${at}must be a list`];
      if (rule.max && value.length > rule.max) return [`${at}must hold ${rule.max} or fewer`];

      return value.flatMap((item, index) =>
        typeof item === 'string' && (!rule.maxLength || item.length <= rule.maxLength)
          ? []
          : [`${at}[${index}] must be text of ${rule.maxLength ?? 'any'} characters or fewer`],
      );
    }

    case 'enumList': {
      if (!Array.isArray(value)) return [`${at}must be a list`];
      if (rule.min !== undefined && value.length < rule.min) {
        return [`${at}must hold at least ${rule.min}`];
      }
      if (rule.max !== undefined && value.length > rule.max) {
        return [`${at}must hold ${rule.max} or fewer`];
      }

      // Compared as strings, so a list of ISO weekday **numbers** and a list of codes can share
      // one rule: the alternative was a second rule type whose only difference was `String()`.
      return value.flatMap(item =>
        rule.of.includes(String(item))
          ? []
          : [`${at}“${String(item)}” is not one of the allowed values`],
      );
    }

    case 'record': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return [`${at}must be an object`];
      }

      return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
        checkConfigValue(rule.value, item, path ? `${path}.${key}` : key),
      );
    }

    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return [`${at}must be an object`];
      }

      const given = value as Record<string, unknown>;
      const unknownKeys = Object.keys(given).filter(key => !(key in rule.fields));

      const problems = [
        // Named rather than ignored: a typo in a key is a setting somebody believes they changed.
        ...unknownKeys.map(key => `${at}“${key}” is not a setting on this key`),
        ...Object.entries(rule.fields).flatMap(([key, field]) =>
          key in given
            ? checkConfigValue(field, given[key], path ? `${path}.${key}` : key)
            : [`${at}“${key}” is required`],
        ),
      ];

      // The ordering constraint, where a key has one: §5.21 asks for it on
      // `safety.tierThresholds`, because a MEDIUM floor above the HIGH floor is a band nothing can
      // ever land in — and the tiers would silently stop being reachable rather than fail.
      if (rule.increasing && !problems.length) {
        const values = rule.increasing.map(key => given[key] as number);

        for (let index = 1; index < values.length; index += 1) {
          if (values[index] <= values[index - 1]) {
            problems.push(
              `${at}${rule.increasing[index]} (${values[index]}) must be above ${rule.increasing[index - 1]} (${values[index - 1]})`,
            );
          }
        }
      }

      return problems;
    }
  }
};
