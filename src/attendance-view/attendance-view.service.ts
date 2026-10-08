import { Inject, Injectable } from '@nestjs/common';

import { PRISMA_CLIENT, ManagedPrismaClient } from '../common/prisma.client';
import type { PrismaClient } from '../generated/prisma';

/**
 * How one employee's day stands at the moment of the read:
 * - `done` — the day is finished, a clock-in and a clock-out are both known;
 * - `open` — a clock-in happened and nobody has clocked out of it yet;
 * - `-` — nothing was recorded for that employee on that date at all.
 */
export type AttendanceState = 'done' | 'open' | '-';

/** One employee as the day view renders it. */
export type AttendanceRow = {
  employeeId: string;
  name: string;
  masuk: string | null;
  pulang: string | null;
  state: AttendanceState;
};

export type AttendanceResult = {
  rows: AttendanceRow[];
};

/** `YYYY-MM-DD` → the UTC midnight that stands for that calendar day. */
const dayStart = (key: string): Date => new Date(`${key}T00:00:00.000Z`);

/** One employee's day after every session recorded on it has been folded together. */
type DayStanding = {
  /** Earliest clock-in of the day. */
  masuk: Date;
  /** Latest clock-out of the day, or `null` while the day is still running. */
  pulang: Date | null;
};

type SessionSlice = {
  employeeId: string;
  clockInAt: Date;
  clockOutAt: Date | null;
};

/**
 * Folds a day's sessions into the one row the view shows per employee.
 *
 * An employee who clocks out and back in on the same date leaves two rows in
 * the table, but the view has a single line for that person: the arrival is
 * the earliest clock-in, the departure is the latest clock-out, and any
 * session still running keeps the whole day open — `pulang` stays `null` and
 * the state reads `open`.
 */
const collapse = (sessions: SessionSlice[]): Map<string, DayStanding> => {
  const days = new Map<string, DayStanding>();
  for (const session of sessions) {
    const standing = days.get(session.employeeId);
    if (standing === undefined) {
      days.set(session.employeeId, {
        masuk: session.clockInAt,
        pulang: session.clockOutAt,
      });
      continue;
    }
    if (session.clockInAt < standing.masuk) {
      standing.masuk = session.clockInAt;
    }
    if (session.clockOutAt === null) {
      standing.pulang = null;
    } else if (standing.pulang !== null && session.clockOutAt > standing.pulang) {
      standing.pulang = session.clockOutAt;
    }
  }
  return days;
};

const toRow = (
  employee: { id: string; name: string },
  standing: DayStanding | undefined
): AttendanceRow => {
  if (standing === undefined) {
    return {
      employeeId: employee.id,
      name: employee.name,
      masuk: null,
      pulang: null,
      state: '-',
    };
  }
  const pulang = standing.pulang;
  return {
    employeeId: employee.id,
    name: employee.name,
    masuk: standing.masuk.toISOString(),
    pulang: pulang === null ? null : pulang.toISOString(),
    state: pulang === null ? 'open' : 'done',
  };
};

/**
 * Read side of the HRD day view.
 *
 * Everything here is computed at read time from the rows as they stand — no
 * projection is stored for this screen. Two independent pulls are made, one
 * for the people and one for that date's sessions, and they are matched up in
 * this process rather than in a single statement, so each side stays a plain
 * query of its own table.
 *
 * The people list is the whole table, deactivated holders included: a day the
 * company already lived through still has to show everybody who was on it, and
 * an employee without a session that date is a row of the answer, not an
 * absence from it. The name filter narrows that finished list; it never
 * decides who is eligible to appear.
 */
@Injectable()
export class AttendanceViewService {
  private readonly prisma: PrismaClient;

  constructor(@Inject(PRISMA_CLIENT) managed: ManagedPrismaClient) {
    this.prisma = managed.client;
  }

  async rows(date: string, nameQuery?: string): Promise<AttendanceResult> {
    const [employees, sessions] = await Promise.all([
      this.prisma.employee.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true },
      }),
      this.prisma.attendanceSession.findMany({
        where: { workDate: dayStart(date) },
        orderBy: { clockInAt: 'asc' },
        select: {
          employeeId: true,
          clockInAt: true,
          clockOutAt: true,
        },
      }),
    ]);

    const standing = collapse(sessions);
    const needle = nameQuery?.toLowerCase();

    const rows: AttendanceRow[] = [];
    for (const employee of employees) {
      if (
        needle !== undefined &&
        !employee.name.toLowerCase().includes(needle)
      ) {
        continue;
      }
      rows.push(toRow(employee, standing.get(employee.id)));
    }
    return { rows };
  }
}
