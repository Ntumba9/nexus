import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiEnvSchema, loadDotEnv, loadEnv } from '@nexus/config';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  loadDotEnv();
  // Validate configuration before anything else so misconfiguration fails fast with a clear message.
  const env = loadEnv(apiEnvSchema);

  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });
  app.enableShutdownHooks();

  if (env.SWAGGER_ENABLED) {
    const config = new DocumentBuilder()
      .setTitle('NEXUS API')
      .setDescription('Developer operations and incident intelligence platform')
      .setVersion('0.1.0')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  }

  await app.listen(env.API_PORT, env.API_HOST);
  new Logger('Bootstrap').log(`API listening on http://${env.API_HOST}:${env.API_PORT}`);
}

bootstrap().catch((error: unknown) => {
  // Logger may not be available if bootstrap failed early; stderr is the reliable channel.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
