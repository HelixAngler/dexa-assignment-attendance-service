import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';

import { createApp } from '../src/app';
import { companyDateKey } from '../src/common/company-time';
import { PrismaClient } from '../src/generated/prisma';

const BASE = '/api/attendance';
const SESSION_COOKIE = 'sid';

type Subject = {
  employeeId: string;
  token: string;
};

/** A row as the summary endpoint renders it. */
type SummaryRow = {
  date: string;
  masuk: string;
  pulang: string | null;
  open: boolean;
  systemClosed: boolean;
};

/**
 * Everything needed to drop one attendance row straight into the table: the
 * endpoint reads stored sessions, so the fixtures write sessions instead of
 * punching their way to a state.
 */
type SessionFixture = {
  workDate: string;
  clockInAt: string;
  clockOutAt?: string | null;
  closedBySystem?: boolean;
};

let app: INestApplication;
let prisma: PrismaClient;
let redis: Redis;

const employeeIds: string[] = [];
const sessionTokens: string[] = [];

/** Shifts a `YYYY-MM-DD` key by whole calendar days. */
const addDays = (key: string, days: number): string => {
  const date = new Date(`${key}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** The first calendar day of the month the given key falls in. */
const monthStartOf = (key: string): string => `${key.slice(0, 8)}01`;

/**
 * A finished session on `workDate`: clock-in and clock-out moments that both
 * land on that same company day, optionally flagged as closed by the system
 * rather than by the employee.
 */
const closedOn = (workDate: string, closedBySystem = false): SessionFixture => ({
  workDate,
  clockInAt: `${workDate}T01:00:00.000Z`,
  clockOutAt: `${workDate}T08:00:00.000Z`,
  closedBySystem,
});

const createSubject = async (): Promise<Subject> => {
  const employee = await prisma.employee.create({
    data: {
      name: 'Summary Test',
      email: `summary-${randomUUID()}@example.test`,
      position: 'Tester',
      phone: '+62-811-0000-0000',
      passwordHash: '$argon2id$never-used-by-these-tests',
      role: 'employee',
      status: 'active',
    },
  });
  employeeIds.push(employee.id);

  const token = randomUUID();
  sessionTokens.push(token);
  const now = Date.now();
  await redis.set(
    `sess:${token}`,
    JSON.stringify({
      employeeId: employee.id,
      role: 'employee',
      mustChangePassword: false,
      lastSeen: now,
      issuedAt: now,
    }),
    'PX',
    30 * 60 * 1000
  );
  return { employeeId: employee.id, token };
};

const addSession = async (
  subject: Subject,
  fixture: SessionFixture
): Promise<void> => {
  const clockOutAt = fixture.clockOutAt ?? null;
  await prisma.attendanceSession.create({
    data: {
      employeeId: subject.employeeId,
      workDate: new Date(`${fixture.workDate}T00:00:00.000Z`),
      clockInAt: new Date(fixture.clockInAt),
      clockOutAt: clockOutAt === null ? null : new Date(clockOutAt),
      clockInKey: randomUUID(),
      clockOutKey: clockOutAt === null ? null : randomUUID(),
      closedBySystem: fixture.closedBySystem ?? false,
    },
  });
};

const summaryRequest = (subject: Subject | null, query = '') => {
  let req = request(app.getHttpServer()).get(`${BASE}/summary${query}`);
  if (subject !== null) {
    req = req.set('Cookie', `${SESSION_COOKIE}=${subject.token}`);
  }
  return req;
};

const datesOf = (body: { rows: SummaryRow[] }): string[] =>
  body.rows.map((row) => row.date);

beforeAll(async () => {
  app = await createApp();
  prisma = new PrismaClient();
  redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: false,
  });
});

afterAll(async () => {
  await prisma.attendanceSession.deleteMany({
    where: { employeeId: { in: employeeIds } },
  });
  await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
  for (const token of sessionTokens) {
    await redis.del(`sess:${token}`);
  }
  await prisma.$disconnect();
  await app.close();
  await redis.quit();
});

describe('GET /summary access', () => {
  it('requires a session with 401 AUTH_REQUIRED', async () => {
    const response = await summaryRequest(null);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });
});

describe('GET /summary default range', () => {
  it('defaults to the first of the current month through today, inclusive at both ends', async () => {
    const subject = await createSubject();
    const today = companyDateKey();
    const from = monthStartOf(today);
    const to = today;
    const inside = addDays(from, 2);

    // Days that must appear: both bounds themselves plus any day strictly
    // between them. Days that must not: the day before the lower bound and
    // the day after the upper bound.
    const wanted = new Set<string>([from, to]);
    if (inside > from && inside < to) {
      wanted.add(inside);
    }
    const unwanted = [addDays(from, -1), addDays(to, 1)];
    for (const day of [...wanted, ...unwanted]) {
      await addSession(subject, closedOn(day));
    }

    const response = await summaryRequest(subject);

    expect(response.status).toBe(200);
    expect(datesOf(response.body)).toEqual([...wanted].sort());
    // The bound days themselves are never clipped away.
    expect(datesOf(response.body)).toContain(from);
    expect(datesOf(response.body)).toContain(to);
  });
});

describe('GET /summary explicit range', () => {
  it('filters inclusively by from/to and orders rows by date ascending', async () => {
    const subject = await createSubject();
    const today = companyDateKey();
    const first = addDays(today, -9);
    const second = addDays(today, -7);
    const third = addDays(today, -5);
    const fourth = addDays(today, -2);
    const belowRange = addDays(today, -20);
    const aboveRange = addDays(today, 3);

    // Inserted deliberately out of order so the response can only be sorted
    // if the query itself orders by date.
    await addSession(subject, closedOn(third));
    await addSession(subject, closedOn(belowRange));
    await addSession(subject, closedOn(fourth));
    await addSession(subject, closedOn(first));
    await addSession(subject, closedOn(aboveRange));
    await addSession(subject, closedOn(second));

    const response = await summaryRequest(
      subject,
      `?from=${first}&to=${fourth}`
    );

    expect(response.status).toBe(200);
    expect(datesOf(response.body)).toEqual([first, second, third, fourth]);
  });
});

describe('GET /summary session states', () => {
  it('reports an open session with pulang null and open true', async () => {
    const subject = await createSubject();
    const today = companyDateKey();
    await addSession(subject, {
      workDate: today,
      clockInAt: `${today}T01:00:00.000Z`,
      clockOutAt: null,
    });

    const response = await summaryRequest(subject, `?from=${today}&to=${today}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      rows: [
        {
          date: today,
          masuk: `${today}T01:00:00.000Z`,
          pulang: null,
          open: true,
          systemClosed: false,
        },
      ],
    });
  });

  it('distinguishes a system-closed session from a normal close', async () => {
    const subject = await createSubject();
    const today = companyDateKey();
    const normalDay = addDays(today, -3);
    const systemDay = addDays(today, -2);

    await addSession(subject, closedOn(normalDay, false));
    await addSession(subject, closedOn(systemDay, true));

    const response = await summaryRequest(
      subject,
      `?from=${normalDay}&to=${systemDay}`
    );

    expect(response.status).toBe(200);
    const rows = response.body.rows as SummaryRow[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      date: normalDay,
      pulang: expect.any(String),
      open: false,
      systemClosed: false,
    });
    expect(rows[1]).toMatchObject({
      date: systemDay,
      pulang: expect.any(String),
      open: false,
      systemClosed: true,
    });
    expect(rows[0].systemClosed).not.toBe(rows[1].systemClosed);
  });

  it('renders work dates as YYYY-MM-DD and timestamps as full ISO-8601', async () => {
    const subject = await createSubject();
    const today = companyDateKey();
    await addSession(subject, closedOn(today));

    const response = await summaryRequest(subject, `?from=${today}&to=${today}`);

    expect(response.status).toBe(200);
    const row = response.body.rows[0] as SummaryRow;
    expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.masuk).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row.pulang).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('GET /summary range validation', () => {
  it('answers 400 RANGE_INVALID when from is after to', async () => {
    const subject = await createSubject();
    const today = companyDateKey();

    const response = await summaryRequest(
      subject,
      `?from=${today}&to=${addDays(today, -1)}`
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      statusCode: 400,
      code: 'RANGE_INVALID',
      message: expect.any(String),
    });
    expect(response.body.message.length).toBeGreaterThan(0);
  });

  it('answers 400 when a bound is not a real calendar date', async () => {
    const subject = await createSubject();
    const today = companyDateKey();

    const impossible = await summaryRequest(
      subject,
      `?from=${today.slice(0, 8)}32&to=${today}`
    );
    expect(impossible.status).toBe(400);
    expect(impossible.body).toMatchObject({
      statusCode: 400,
      code: 'DATE_INVALID',
    });

    const malformed = await summaryRequest(
      subject,
      `?from=not-a-date&to=${today}`
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      statusCode: 400,
      code: 'DATE_INVALID',
    });
  });
});

describe('GET /summary own scope', () => {
  it('returns only the caller rows and ignores any supplied employee id', async () => {
    const owner = await createSubject();
    const other = await createSubject();
    const today = companyDateKey();
    const from = addDays(today, -6);
    const to = addDays(today, -1);

    const ownerDays = [addDays(today, -4), addDays(today, -1)];
    const otherDays = [addDays(today, -6), addDays(today, -3)];

    for (const day of ownerDays) {
      await addSession(owner, closedOn(day));
    }
    for (const day of otherDays) {
      await addSession(other, closedOn(day));
    }

    const baseline = await summaryRequest(owner, `?from=${from}&to=${to}`);
    expect(baseline.status).toBe(200);
    expect(datesOf(baseline.body)).toEqual(ownerDays);

    // Client-supplied ids for a self resource are ignored, never honored.
    const withEmployeeId = await summaryRequest(
      owner,
      `?from=${from}&to=${to}&employeeId=${other.employeeId}`
    );
    expect(withEmployeeId.status).toBe(200);
    expect(withEmployeeId.body).toEqual(baseline.body);

    const withLookalikes = await summaryRequest(
      owner,
      `?from=${from}&to=${to}&employee_id=${other.employeeId}&id=${other.employeeId}`
    );
    expect(withLookalikes.status).toBe(200);
    expect(withLookalikes.body).toEqual(baseline.body);

    // The other employee's own call still sees the other employee's rows.
    const asOther = await summaryRequest(other, `?from=${from}&to=${to}`);
    expect(asOther.status).toBe(200);
    expect(datesOf(asOther.body)).toEqual(otherDays);
  });
});

describe('GET /summary empty range', () => {
  it('answers {rows: []} when the range holds no session', async () => {
    const subject = await createSubject();
    const today = companyDateKey();
    await addSession(subject, closedOn(addDays(today, -5)));

    const response = await summaryRequest(
      subject,
      `?from=${addDays(today, 10)}&to=${addDays(today, 12)}`
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rows: [] });
  });

  it('answers {rows: []} for an employee with no session at all', async () => {
    const subject = await createSubject();

    const response = await summaryRequest(subject);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rows: [] });
  });
});
