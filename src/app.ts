import 'reflect-metadata';

import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';

import { HealthController } from './health.controller';
import { HttpExceptionFilter } from './common/http-exception.filter';

@Module({
  controllers: [HealthController],
})
class AppModule {}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/attendance');
  // Parse the HttpOnly session cookie before any route or guard runs.
  app.use(cookieParser());
  // One shape for every failure: {statusCode, code, message}, localized.
  app.useGlobalFilters(new HttpExceptionFilter());
  // Register middleware and routes now so callers can issue requests
  // immediately; the HTTP server is only bound when listen() is called.
  await app.init();
  return app;
}
