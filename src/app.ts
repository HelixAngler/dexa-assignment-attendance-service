import 'reflect-metadata';

import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';

import { HealthController } from './health.controller';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { employeeStatusReaderProvider } from './common/auth/prisma-employee-status.reader';
import { sessionStoreProvider } from './common/auth/session.reader';
import { prismaClientProvider } from './common/prisma.client';
import { MidnightCloseJob } from './jobs/midnight-close.job';
import { PunchesController } from './punches/punches.controller';
import { PunchesService } from './punches/punches.service';
import { SummaryController } from './summary/summary.controller';
import { SummaryService } from './summary/summary.service';

@Module({
  controllers: [HealthController, PunchesController, SummaryController],
  providers: [
    prismaClientProvider,
    sessionStoreProvider,
    employeeStatusReaderProvider,
    PunchesService,
    SummaryService,
    MidnightCloseJob,
  ],
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
