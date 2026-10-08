import { Inject, Injectable } from '@nestjs/common';

import { PRISMA_CLIENT, ManagedPrismaClient } from '../common/prisma.client';
import type { AttendanceSession, PrismaClient } from '../generated/prisma';

/**
 * One summary line: a work date with the punch pair recorded on it.
 *
 * Wire formatting decisions, held in one place so every consumer reads the
 * same shapes:
 * - `date` is the stored work date as the calendar day `YYYY-MM-DD`. The
 *   column is a plain date, so no zone conversion applies — it already is the
 *   company day the clock-in fell on.
 * - `masuk` / `pulang` are the stored instants rendered as full ISO-8601 with
 *   an offset designator. A `timestamptz` is an instant, not a local time, so
 *   it is serialized in UTC (`...Z`), the same rendering the punch endpoints
 *   use; the offset is therefore explicit and unambiguous.
 * - `pulang` is `null` while the session is still open, which is exactly when
 *   `open` is `true`.
 * - `systemClosed` reports whether the close came from an automatic sweep
 *   rather than from the employee's own clock-out.
 */
export type SummaryRow = {
  date: string;
  masuk: string;
  pulang: string | null;
  open: boolean;
  systemClosed: boolean;
};

export type SummaryResult = {
  rows: SummaryRow[];
};

/** `YYYY-MM-DD` → the UTC midnight that stands for that calendar day. */
const dayStart = (key: string): Date => new Date(`${key}T00:00:00.000Z`);

const toRow = (session: AttendanceSession): SummaryRow => ({
  date: session.workDate.toISOString().slice(0, 10),
  masuk: session.clockInAt.toISOString(),
  pulang:
    session.clockOutAt === null ? null : session.clockOutAt.toISOString(),
  open: session.clockOutAt === null,
  systemClosed: session.closedBySystem,
});

/**
 * Read side of the attendance summary.
 *
 * Rows are computed on read — nothing is pre-aggregated or stored for this
 * view — so the answer always reflects the sessions as they stand. The query
 * is scoped to a single employee by construction: the caller's identity is a
 * required argument, and no parameter of this method can widen it to anybody
 * else's history. Both range bounds are inclusive, matching a plain
 * "from … to …" date filter.
 */
@Injectable()
export class SummaryService {
  private readonly prisma: PrismaClient;

  constructor(@Inject(PRISMA_CLIENT) managed: ManagedPrismaClient) {
    this.prisma = managed.client;
  }

  async rows(
    employeeId: string,
    from: string,
    to: string
  ): Promise<SummaryResult> {
    const sessions = await this.prisma.attendanceSession.findMany({
      where: {
        employeeId,
        workDate: { gte: dayStart(from), lte: dayStart(to) },
      },
      orderBy: [{ workDate: 'asc' }, { clockInAt: 'asc' }],
    });

    return { rows: sessions.map(toRow) };
  }
}
