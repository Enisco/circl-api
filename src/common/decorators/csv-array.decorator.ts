import { Transform } from 'class-transformer';

/**
 * A query-string array: `cityIds=LONDON,LEEDS`, or `cityIds=LONDON&cityIds=LEEDS`, or a JSON array
 * in a POST body.
 *
 * All three reach the same shape, because the same DTO serves all three. The portal sends the
 * member filters as a query string on the list endpoint and as a body on the search endpoint
 * (names and emails must not appear in a URL), and Express gives a repeated key as an array
 * already — so a transform that only split strings would hand back a nested array from one of the
 * three.
 *
 * Empty entries are dropped rather than passed through: `cityIds=LONDON,` is somebody's trailing
 * comma, and an empty string validated against a vocabulary is a 400 about a value nobody typed.
 */
export const CsvArray = () =>
  Transform(({ value }) => {
    if (typeof value === 'string') {
      return value
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean);
    }

    if (Array.isArray(value)) {
      return value
        .flatMap(entry => (typeof entry === 'string' ? entry.split(',') : entry))
        .map(entry => (typeof entry === 'string' ? entry.trim() : entry))
        .filter(entry => entry !== '' && entry !== null && entry !== undefined);
    }

    return value;
  });
