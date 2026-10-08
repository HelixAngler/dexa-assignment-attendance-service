import {
  Inject,
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';

import { config } from '../config';
import { COMPANY_TIME_ZONE, companyDateKey } from '../common/company-time';
import { PRISMA_CLIENT, ManagedPrismaClient } from '../common/prisma.client';
import type { PrismaClient } from '../generated/prisma';

/** How often the sweep looks for sessions left open by a day that has ended. */
const SWEEP_INTERVAL_MS = 60_000;

type ClosedRow = { id: string };

/**
 * Closes every session whose work day is already behind the current company
 * day, stamping it with the last second of its own work day and marking it as
 * closed by the system rather than by the employee.
 *
 * The sweep runs on a repeating timer that is deliberately unref'd: it never
 * holds a process open by itself, and it never starts under the test
 * environment so a test that drives the method directly cannot race the
 * scheduler. Running the sweep twice in a row is safe by construction — the
 * second pass finds nothing left open and closes zero rows.
 */
@Injectable()
export class MidnightCloseJob implements OnModuleInit, OnApplicationShutdown {
  private readonly prisma: PrismaClient;
  private timer?: NodeJS.Timeout;

  constructor(@Inject(PRISMA_CLIENT) managed: ManagedPrismaClient) {
    this.prisma = managed.client;
  }

  onModuleInit(): void {
    this.start();
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  start(): void {
    if (this.timer !== undefined || config.nodeEnv === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.closeStaleSessions().catch((error: unknown) => {
        console.error('[midnight-close] sweep failed', error);
      });
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === undefined) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Whether the repeating sweep is armed right now. */
  isRunning(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Closes each still-open session belonging to a finished work day.
   *
   * The row candidates are picked with `FOR UPDATE SKIP LOCKED` so concurrent
   * sweeps — or a clock-out landing at the same moment — never block each
   * other: a row another sweep already claimed is simply skipped, and the
   * still-open predicate on the pick makes a rerun a no-op.
   *
   * @returns how many sessions this pass closed.
   */
  async closeStaleSessions(): Promise<number> {
    const today = companyDateKey();
    const closed = await this.prisma.$queryRaw<ClosedRow[]>`
      UPDATE attendance_sessions
      SET clock_out_at = (work_date + time '23:59:59') AT TIME ZONE ${COMPANY_TIME_ZONE},
          closed_by_system = true
      WHERE id IN (
        SELECT id
        FROM attendance_sessions
        WHERE work_date < ${today}::date
          AND clock_out_at IS NULL
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;
    return closed.length;
  }
}
