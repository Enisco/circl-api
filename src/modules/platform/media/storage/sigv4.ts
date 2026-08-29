import { createHash, createHmac } from 'crypto';

export interface PresignGetOptions {
  bucket: string;
  region: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Seconds the URL stays valid, counted from `signingDate`. */
  expiresIn: number;
  /** The instant the signature is anchored to. */
  signingDate: Date;
  /** A CDN origin in front of the bucket, without a trailing slash. */
}

/** AWS Signature Version 4, query-string form, for a GET. */
export const presignGetV4 = (options: PresignGetOptions): string => {
  const host = hostFor(options);
  const amzDate = toAmzDate(options.signingDate);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${options.region}/s3/aws4_request`;

  // Each path segment is encoded separately: a key contains slashes that are path separators and must not become %2F.
  const canonicalUri = `/${options.key.split('/').map(rfc3986).join('/')}`;

  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${options.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(options.expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ];

  if (options.sessionToken) {
    query.push(['X-Amz-Security-Token', options.sessionToken]);
  }

  // Sorted by encoded key, which is what the canonical form requires.
  const canonicalQuery = query
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    // The body is not signed for a presigned GET.
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signature = hmac(signingKey(options.secretAccessKey, dateStamp, options.region), stringToSign).toString('hex');

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
};

/** The virtual-hosted bucket endpoint, and deliberately not a CDN. */
const hostFor = (options: PresignGetOptions): string =>
  `${options.bucket}.s3.${options.region}.amazonaws.com`;

/** `YYYYMMDDTHHMMSSZ`, which is the only date format the algorithm accepts. */
const toAmzDate = (date: Date): string => `${date.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;

/** RFC 3986 unreserved-set encoding. */
const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const hmac = (key: Buffer | string, value: string): Buffer =>
  createHmac('sha256', key).update(value, 'utf8').digest();

const signingKey = (secret: string, dateStamp: string, region: string): Buffer =>
  hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), 's3'), 'aws4_request');
