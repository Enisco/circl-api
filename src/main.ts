import { AppModule } from '@/app.module';
import { HttpExceptionsFilter } from '@/common/filters';
import { TransformResponseInterceptor } from '@/common/interceptors';
import { SWAGGER_CUSTOM_CSS, SWAGGER_OPTIONS } from '@/config/swagger.config';
import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { useContainer } from 'class-validator';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger, LoggerErrorInterceptor, PinoLogger } from 'nestjs-pino';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
    bodyParser: true,
  });

  const config = app.get(ConfigService);
  const logger = await app.resolve(PinoLogger);
  const appEnv = config.getOrThrow<string>('APP_ENV');
  const isProxyEnvironment = ['staging', 'production'].includes(appEnv);
  const httpAdapter = app.getHttpAdapter().getInstance();

  let origin: string[] | boolean = true;

  if (isProxyEnvironment) {
    origin = [
      config.getOrThrow<string>('CLIENT_URL'),
      config.getOrThrow<string>('ADMIN_CLIENT_URL'),
    ];
  }

  if (isProxyEnvironment) {
    httpAdapter.set('trust proxy', 1);
  }

  httpAdapter.disable('x-powered-by');

  const customHeaders = [
    'x-client-platform', // allowed values are "mobile" and "desktop", this is to control the response formats
    'x-device-id', // the client generates a device id (uuid most preferably) and passes it as a header
    'x-session-id', // the backend will generate a session id and pass it to the client, the client will then pass it back to the backend in the request header
    'x-app-version', // e.g. The version of the duerents mobile app the user is using
    'x-device-name', // e.g. "iPhone 13 Pro"
    'x-timezone', // e.g. "Africa/Lagos"
    'x-refresh-token', // the refresh token sent as a header for mobile
  ];

  // Enable CORS with more specific options
  app.enableCors({
    origin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', ...customHeaders],
    credentials: true,
  });

  app.useLogger(app.get(Logger));
  app.use(compression());
  app.use(cookieParser());
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      validateCustomDecorators: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      validationError: { target: false },
    }),
  );
  app.useGlobalInterceptors(
    new LoggerErrorInterceptor(),
    new TransformResponseInterceptor(),
    new ClassSerializerInterceptor(app.get(Reflector)),
  );
  app.useGlobalFilters(new HttpExceptionsFilter());

  useContainer(app.select(AppModule), { fallbackOnErrors: true });

  // The chat gateway (spec 5.2).
  app.useWebSocketAdapter(new IoAdapter(app));

  app.enableShutdownHooks();

  // Enable swagger in local, development and staging environments
  if (['local', 'development', 'staging'].includes(appEnv)) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Circl API')
      .setDescription('Circl API — backend for the Circl platform.')
      .setVersion('1.0')
      .addServer('/', `current host (${appEnv})`)
      .addServer('http://localhost:4000', 'local')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);

    SwaggerModule.setup('docs', app, document, {
      customSiteTitle: 'Circl API',
      customCss: SWAGGER_CUSTOM_CSS,
      swaggerOptions: SWAGGER_OPTIONS,
    });
  }

  const port = config.get<number>('PORT') || config.get<number>('APP_PORT') || 4000;

  await app.listen(port, '0.0.0.0', () => {
    logger.info(`Circl API is running on port ${port}`);
  });
}
// Nest's buffered logs are discarded when bootstrap throws, so these write straight to the platform log stream.
process.on('unhandledRejection', reason => {
  console.error('[fatal] Unhandled promise rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', error => {
  console.error('[fatal] Uncaught exception:', error);
  process.exit(1);
});

bootstrap().catch(error => {
  console.error('[fatal] Circl API failed to start:', error);
  process.exit(1);
});
