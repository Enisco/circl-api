import { ConfigService } from '@nestjs/config';
import { getLoggerConfig } from '../logger.config';

/**
 * S7.4 and S14.3: what a request log line is allowed to contain.
 *
 * Worth a test rather than a reading because the failure is invisible in use. Nothing breaks when
 * a log carries an email address or a token — it works exactly as well as the redacted version,
 * right up until the log drain is the thing that leaked, and by then the lines are shipped and
 * nobody can unship them.
 */
const serialiseRequest = (request: Record<string, unknown>) => {
  const config = getLoggerConfig({ get: () => 'test' } as unknown as ConfigService);
  const serializer = (
    config as unknown as {
      pinoHttp: { serializers: { req: (req: unknown) => Record<string, unknown> } };
    }
  ).pinoHttp.serializers.req;

  return serializer({ headers: {}, query: {}, ...request });
};

describe('request log redaction', () => {
  it('keeps the path and drops the query string from the url', () => {
    const line = serialiseRequest({
      method: 'GET',
      url: '/api/v1/admin/members?q=ada@example.com&page=2',
      query: { q: 'ada@example.com', page: '2' },
    });

    expect(line.url).toBe('/api/v1/admin/members?…');
    expect(JSON.stringify(line)).not.toContain('ada@example.com');
  });

  it('leaves a url with no parameters exactly as it was', () => {
    expect(serialiseRequest({ url: '/api/v1/admin/dashboard/attention' }).url).toBe(
      '/api/v1/admin/dashboard/attention',
    );
  });

  it('redacts the member search term, which is how the admin surface searches by email', () => {
    const line = serialiseRequest({ query: { q: 'ada@example.com' } });

    expect(line.query).toEqual({ q: '[redacted]' });
  });

  it('redacts credentials that should never have been in a query string', () => {
    const line = serialiseRequest({
      query: { token: 'inv_abc', code: '111222', mfaToken: 'x', password: 'y', secret: 'z' },
    });

    expect(Object.values(line.query as Record<string, unknown>)).toEqual([
      '[redacted]',
      '[redacted]',
      '[redacted]',
      '[redacted]',
      '[redacted]',
    ]);
  });

  it('is case-insensitive about the parameter name', () => {
    expect(serialiseRequest({ query: { Email: 'ada@example.com', TOKEN: 'abc' } }).query).toEqual({
      Email: '[redacted]',
      TOKEN: '[redacted]',
    });
  });

  it('keeps the parameters that are useful and are nobody’s data', () => {
    const line = serialiseRequest({
      query: { page: '2', perPage: '25', sort: 'waitingSince', state: 'NEW,OPEN' },
    });

    expect(line.query).toEqual({
      page: '2',
      perPage: '25',
      sort: 'waitingSince',
      state: 'NEW,OPEN',
    });
  });

  it('masks every credential header, the two admin ones included', () => {
    const line = serialiseRequest({
      headers: {
        authorization: 'Bearer abc',
        cookie: 'session=abc',
        'x-refresh-token': 'abc',
        'x-circl-admin-client': 'the-bff-secret',
        'x-thread-access-grant': 'grant-id',
        'user-agent': 'circl-admin/1.0',
      },
    });

    const headers = line.headers as Record<string, unknown>;

    expect(headers.authorization).toBe('****');
    expect(headers.cookie).toBe('****');
    expect(headers['x-refresh-token']).toBe('****');
    expect(headers['x-circl-admin-client']).toBe('****');
    expect(headers['x-thread-access-grant']).toBe('****');
    // Not everything: the user agent is how a broken client build gets identified.
    expect(headers['user-agent']).toBe('circl-admin/1.0');
    expect(JSON.stringify(line)).not.toContain('the-bff-secret');
  });

  it('leaves a header that was not sent undefined rather than masking nothing', () => {
    const headers = serialiseRequest({ headers: { 'user-agent': 'curl' } }).headers as Record<
      string,
      unknown
    >;

    expect(headers.authorization).toBeUndefined();
    expect(headers['x-circl-admin-client']).toBeUndefined();
  });

  it('survives a request with no query at all', () => {
    expect(serialiseRequest({ url: '/health', query: undefined }).query).toEqual({});
  });
});
