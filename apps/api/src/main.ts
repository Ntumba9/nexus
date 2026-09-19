import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiEnvSchema, loadDotEnv, loadEnv } from '@nexus/config';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  loadDotEnv();
  // Validate configuration before anything else so misconfiguration fails fast with a clear message.
  const env = loadEnv(apiEnvSchema);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true, // webhook signatures are computed over the exact bytes received
  });
  configureApp(app, env);
  app.enableShutdownHooks();

  if (env.SWAGGER_ENABLED) {
    const config = new DocumentBuilder()
      .setTitle('NEXUS API')
      .setDescription('Developer operations and incident intelligence platform')
      .setVersion('0.2.0')
      .addCookieAuth('nexus_session')
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
