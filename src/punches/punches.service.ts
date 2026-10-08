import { Inject, Injectable } from '@nestjs/common';

import { AppException } from '../common/app.exception';
import { companyWorkDate } from '../common/company-time';
import { PRISMA_CLIENT, ManagedPrismaClient } from '../common/prisma.client';
import type { AttendanceSession, PrismaClient } from '../generated/prisma';

export type PunchDirection = 'masuk' | 'pulang';

export type PunchResult = {
  sessionId: string;
  direction: PunchDirection;
  at: string;
};

export type PunchState = {
  status: 'belum_masuk' | 'bekerja';
  clockInAt?: string;
  lastPunch?: string;
};

/** Wire shape of an idempotency key: a plain UUID, nothing else. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isIdempotencyKey = (value: string): boolean =>
  UUID_PATTERN.test(value);

/**
 * Prisma reports every violated uniqueness rule — the two key columns and the
 * partial "one open session per employee" index — as the same P2002 code, so
 * the caller decides what the collision means by looking the key up again.
 */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'P2002';

/**
 * Single writer for attendance rows: the only place that assigns punch
 * timestamps and the only place that interprets idempotency keys.
 *
 * Invariants held here:
 * - every timestamp comes from this process's clock; a request body can never
 *   supply or shift one;
 * - the work date is the calendar day of that timestamp in the company zone;
 * - at most one open session per employee, guaranteed by a partial unique
 *   index — a loser of the race writes nothing and is told which conflict it
 *   hit;
 * - a key that already produced a row replays that row's original answer
 *   instead of writing again, and a key reused with the other direction is a
 *   conflict rather than a second write.
 */
@Injectable()
export class PunchesService {
  private readonly prisma: PrismaClient;

  constructor(@Inject(PRISMA_CLIENT) managed: ManagedPrismaClient) {
    this.prisma = managed.client;
  }

  async punch(
    employeeId: string,
    direction: PunchDirection,
    key: string
  ): Promise<PunchResult> {
    const claimed = await this.findByKey(key);
    if (claimed !== null) {
      return this.replay(claimed, key, direction, employeeId);
    }
    return direction === 'masuk'
      ? this.clockIn(employeeId, key)
      : this.clockOut(employeeId, key);
  }

  /**
   * The employee's standing for the current company day: whether a session
   * opened today is still running, when it opened, and the most recent punch
   * recorded today (clock-in or clock-out).
   */
  async state(employeeId: string): Promise<PunchState> {
    const rows = await this.prisma.attendanceSession.findMany({
      where: { employeeId, workDate: companyWorkDate() },
    });

    let latestMs = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      latestMs = Math.max(latestMs, row.clockInAt.getTime());
      if (row.clockOutAt !== null) {
        latestMs = Math.max(latestMs, row.clockOutAt.getTime());
      }
    }

    const open = rows.find((row) => row.clockOutAt === null);
    const lastPunch =
      latestMs === Number.NEGATIVE_INFINITY
        ? undefined
        : new Date(latestMs).toISOString();

    if (open !== undefined) {
      return {
        status: 'bekerja',
        clockInAt: open.clockInAt.toISOString(),
        lastPunch,
      };
    }
    return lastPunch === undefined
      ? { status: 'belum_masuk' }
      : { status: 'belum_masuk', lastPunch };
  }

  private findByKey(key: string): Promise<AttendanceSession | null> {
    return this.prisma.attendanceSession.findFirst({
      where: { OR: [{ clockInKey: key }, { clockOutKey: key }] },
    });
  }

  /**
   * Turns an already-claimed key into the answer that key produced the first
   * time. A key owned by somebody else, or pointed at the other direction, is
   * a mismatch: two different requests cannot share one key.
   */
  private replay(
    row: AttendanceSession,
    key: string,
    direction: PunchDirection,
    employeeId: string
  ): PunchResult {
    if (row.employeeId !== employeeId) {
      throw new AppException(422, 'IDEMPOTENCY_CONFLICT');
    }
    if (direction === 'masuk') {
      if (row.clockInKey !== key) {
        throw new AppException(422, 'IDEMPOTENCY_CONFLICT');
      }
      return {
        sessionId: row.id,
        direction: 'masuk',
        at: row.clockInAt.toISOString(),
      };
    }
    if (row.clockOutKey !== key || row.clockOutAt === null) {
      throw new AppException(422, 'IDEMPOTENCY_CONFLICT');
    }
    return {
      sessionId: row.id,
      direction: 'pulang',
      at: row.clockOutAt.toISOString(),
    };
  }

  private async clockIn(
    employeeId: string,
    key: string
  ): Promise<PunchResult> {
    const open = await this.prisma.attendanceSession.findFirst({
      where: { employeeId, clockOutAt: null },
      select: { id: true },
    });
    if (open !== null) {
      throw new AppException(409, 'SESSION_ALREADY_OPEN');
    }

    const now = new Date();
    try {
      const row = await this.prisma.attendanceSession.create({
        data: {
          employeeId,
          workDate: companyWorkDate(now),
          clockInAt: now,
          clockInKey: key,
        },
      });
      return {
        sessionId: row.id,
        direction: 'masuk',
        at: row.clockInAt.toISOString(),
      };
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // The insert lost: either another request opened a session first, or a
      // concurrent retry arrived with this very key. Only the second case has
      // a row to replay; anything else is a refusal that wrote nothing.
      const concurrent = await this.findByKey(key);
      if (concurrent !== null) {
        return this.replay(concurrent, key, 'masuk', employeeId);
      }
      throw new AppException(409, 'SESSION_ALREADY_OPEN');
    }
  }

  private async clockOut(
    employeeId: string,
    key: string
  ): Promise<PunchResult> {
    const now = new Date();
    let closedSessionId: string | null = null;

    try {
      closedSessionId = await this.prisma.$transaction(async (tx) => {
        const open = await tx.attendanceSession.findFirst({
          where: { employeeId, clockOutAt: null },
          select: { id: true },
        });
        if (open === null) {
          return null;
        }
        // The null predicate carries the race protection: a row another
        // request already closed stops matching, so this close can never
        // overwrite somebody else's clock-out time.
        const updated = await tx.attendanceSession.updateMany({
          where: { id: open.id, clockOutAt: null },
          data: { clockOutAt: now, clockOutKey: key },
        });
        return updated.count === 1 ? open.id : null;
      });
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      return this.resolveMissingClose(key, employeeId);
    }

    if (closedSessionId !== null) {
      return {
        sessionId: closedSessionId,
        direction: 'pulang',
        at: now.toISOString(),
      };
    }
    return this.resolveMissingClose(key, employeeId);
  }

  /**
   * Reached when no open session was available to close: either there was
   * none to begin with, or it vanished while this request ran. A row holding
   * this key means a concurrent attempt with the same key won and its original
   * answer is replayed; otherwise the punch is refused and nothing was written.
   */
  private async resolveMissingClose(
    key: string,
    employeeId: string
  ): Promise<PunchResult> {
    const concurrent = await this.findByKey(key);
    if (concurrent !== null) {
      return this.replay(concurrent, key, 'pulang', employeeId);
    }
    throw new AppException(409, 'NO_OPEN_SESSION');
  }
}
