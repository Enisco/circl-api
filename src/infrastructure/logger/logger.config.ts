import { ulid } from 'ulid';
import { ConfigService } from '@nestjs/config';

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
            url: req.url,
            query: req.query,
            headers: {
              ...req.headers,
              authorization: req.headers.authorization ? '****' : undefined,
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
          message: err.message,
          stack: err.stack,
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
