import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';

import { createApp } from '../src/app';
import { COMPANY_TIME_ZONE, companyDateKey } from '../src/common/company-time';
import { PRISMA_CLIENT, ManagedPrismaClient } from '../src/common/prisma.client';
import { MidnightCloseJob } from '../src/jobs/midnight-close.job';
import type { AttendanceSession, PrismaClient } from '../src/generated/prisma';

const dateKeyOf = (offsetDays: number): string =>
  companyDateKey(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000));

const clockInOn = (dayKey: string): Date =>
  new Date(`${dayKey}T08:00:00+07:00`);

const workDateOf = (dayKey: string): Date =>
  new Date(`${dayKey}T00:00:00.000Z`);

/** Renders a timestamp as `YYYY-MM-DD HH:mm:ss` in the company zone. */
const inCompanyZone = (value: Date): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: COMPANY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: string): string =>
    parts.find((piece) => piece.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part(
    'hour'
  )}:${part('minute')}:${part('second')}`;
};

const createOpenSession = async (
  prisma: PrismaClient,
  employeeIds: string[],
  dayKey: string
): Promise<AttendanceSession> => {
  const employee = await prisma.employee.create({
    data: {
      name: 'Midnight Close Test',
      email: `midnight-${randomUUID()}@example.test`,
      position: 'Tester',
      phone: '+62-811-0000-0000',
      passwordHash: '$argon2id$never-used-by-these-tests',
      role: 'employee',
      status: 'active',
    },
  });
  employeeIds.push(employee.id);

  return prisma.attendanceSession.create({
    data: {
      employeeId: employee.id,
      workDate: workDateOf(dayKey),
      clockInAt: clockInOn(dayKey),
      clockInKey: randomUUID(),
    },
  });
};

let app: INestApplication;
let job: MidnightCloseJob;
let prisma: PrismaClient;

const employeeIds: string[] = [];
const staleKey = dateKeyOf(-2);
const todayKey = dateKeyOf(0);

let staleRow: AttendanceSession;
let todayRow: AttendanceSession;
let firstPassCount = 0;

beforeAll(async () => {
  app = await createApp();
  job = app.get(MidnightCloseJob);
  prisma = app.get<ManagedPrismaClient>(PRISMA_CLIENT).client;

  staleRow = await createOpenSession(prisma, employeeIds, staleKey);
  todayRow = await createOpenSession(prisma, employeeIds, todayKey);
  firstPassCount = await job.closeStaleSessions();
});

afterAll(async () => {
  await prisma.attendanceSession.deleteMany({
    where: { employeeId: { in: employeeIds } },
  });
  await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
  await app.close();
});

describe('MidnightCloseJob', () => {
  it('closes a session left open by a finished day on its first run', () => {
    expect(firstPassCount).toBe(1);
  });

  it('stamps the closed session with the last second of its own work day', async () => {
    const row = await prisma.attendanceSession.findUniqueOrThrow({
      where: { id: staleRow.id },
    });

    expect(row.clockOutAt).not.toBeNull();
    expect(inCompanyZone(row.clockOutAt as Date)).toBe(`${staleKey} 23:59:59`);
    expect(row.clockOutAt!.getTime()).toBeGreaterThan(row.clockInAt.getTime());
    expect(row.closedBySystem).toBe(true);
  });

  it('leaves a session of the current company day untouched', async () => {
    const row = await prisma.attendanceSession.findUniqueOrThrow({
      where: { id: todayRow.id },
    });

    expect(row.clockOutAt).toBeNull();
    expect(row.closedBySystem).toBe(false);
  });

  it('closes zero rows when the sweep runs again', async () => {
    const before = await prisma.attendanceSession.findUniqueOrThrow({
      where: { id: staleRow.id },
    });

    await expect(job.closeStaleSessions()).resolves.toBe(0);

    const after = await prisma.attendanceSession.findUniqueOrThrow({
      where: { id: staleRow.id },
    });
    expect(after.clockOutAt).toEqual(before.clockOutAt);
    expect(after.closedBySystem).toBe(true);
  });

  it('does not arm its timer in the test environment', () => {
    expect(job.isRunning()).toBe(false);
  });
});
