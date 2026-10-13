import { ulid } from 'ulid';
import { ConfigService } from '@nestjs/config';

/**
 * Query parameters whose **values** never reach the log stream (S7.4, S14.3).
 *
 * Two kinds, and both matter. The credentials — a token, a code, a password that somebody put in a
 * query string by mistake — because a log drain is a second place they live and nobody rotates
 * them when a log is shipped. And the personal data: the member search is `?q=<email address>`,
 * and the admin surface runs it all day, so without this the log of a staff member doing their job
 * is a list of members' email addresses in request order.
 *
 * The parameter *names* are kept. "Somebody filtered by email" is useful and "somebody filtered by
 * ada@example.com" is a disclosure, and the difference between them is this list.
 */
const REDACTED_PARAMS = new Set([
  'token',
  'mfatoken',
  'mfasetuptoken',
  'refreshtoken',
  'password',
  'code',
  'secret',
  'email',
  'phone',
  'phonenumber',
  'q',
  'search',
  'reason',
]);

const REDACTED = '[redacted]';

const redactQuery = (query: unknown): Record<string, unknown> => {
  if (!query || typeof query !== 'object') return {};

  return Object.fromEntries(
    Object.entries(query as Record<string, unknown>).map(([key, value]) => [
      key,
      REDACTED_PARAMS.has(key.toLowerCase()) ? REDACTED : value,
    ]),
  );
};

/**
 * The path, without the query string.
 *
 * The parameters are logged separately and redacted; keeping them on the url as well would be a
 * second, unredacted copy of the same string — which is how the first version of this leaked. A
 * trailing `?` marker is kept so a reader can tell "no parameters" from "parameters, logged over
 * there".
 */
const redactUrl = (url: unknown): string => {
  if (typeof url !== 'string') return String(url ?? '');

  const [path, query] = url.split('?');

  return query ? `${path}?…` : path;
};

export const getLoggerConfig = (configService: ConfigService) => {
  const isDevelopment =
    configService.get('APP_ENV') === 'local' || configService.get('APP_ENV') === 'development';

  return {
    pinoHttp: {
      genReqId: request => request.headers['x-correlation-id'] || ulid(),
      customProps: req => ({
        context: 'HTTP',
        correlationId: req.headers['x-correlation-id'] || ulid(),
      }),
      serializers: {
        req: req => {
          return {
            method: req.method,
            url: redactUrl(req.url),
            query: redactQuery(req.query),
            headers: {
              ...req.headers,
              // Credentials must never reach the platform log stream
              authorization: req.headers.authorization ? '****' : undefined,
              cookie: req.headers.cookie ? '****' : undefined,
              'x-refresh-token': req.headers['x-refresh-token'] ? '****' : undefined,
              // The admin surface's two (S14.3). The BFF secret is a shared credential — one log
              // line carrying it is a way into every admin route — and a thread access grant names
              // the member whose private conversation somebody opened.
              'x-circl-admin-client': req.headers['x-circl-admin-client'] ? '****' : undefined,
              'x-thread-access-grant': req.headers['x-thread-access-grant'] ? '****' : undefined,
            },
            remoteAddress: req.remoteAddress,
            remotePort: req.remotePort,
          };
        },
        res: res => {
          return {
            statusCode: res.statusCode,
          };
        },
        err: err => ({
          type: err.name,
          message: err.message,
          stack: err.stack,
          // Prisma/HTTP errors carry these; they are the useful bits when reading deployed logs
          status: err.status,
          code: err.code,
        }),
      },
      transport: isDevelopment
        ? {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
    },
  };
};
