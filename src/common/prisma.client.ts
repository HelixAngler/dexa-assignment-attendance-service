import { Provider } from '@nestjs/common';

import { PrismaClient } from '../generated/prisma';

/** Injection token for the process-wide database client. */
export const PRISMA_CLIENT = 'PRISMA_CLIENT';

/**
 * Owns the single database client of the process.
 *
 * One client means one connection pool shared by request handling and
 * background work, and one place that returns that pool when the application
 * shuts down — a process that merely started and stopped never keeps a live
 * connection behind it.
 *
 * The connection string is taken from the variable the generated client was
 * built against, falling back to the deployment variable that carries the same
 * URL, so either naming works without editing generated code.
 */
export class ManagedPrismaClient {
  readonly client: PrismaClient;

  constructor() {
    const url = process.env.DATABASE_URL_MAIN || process.env.DATABASE_URL;
    this.client =
      url === undefined || url === ''
        ? new PrismaClient()
        : new PrismaClient({ datasourceUrl: url });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.$disconnect();
  }
}

export const prismaClientProvider: Provider = {
  provide: PRISMA_CLIENT,
  useFactory: (): ManagedPrismaClient => new ManagedPrismaClient(),
};
