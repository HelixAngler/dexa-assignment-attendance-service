import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';

import { createApp } from '../src/app';
import { PrismaClient } from '../src/generated/prisma';

const BASE = '/api/attendance';
const SESSION_COOKIE = 'sid';
const COMPANY_TIME_ZONE = 'Asia/Jakarta';
/** Half of the tolerance used when comparing a punch against the test clock. */
const CLOCK_WINDOW_MS = 2000;

type Direction = 'masuk' | 'pulang';

type Subject = {
  employeeId: string;
  token: string;
};

type PunchBody = Record<string, unknown>;

let app: INestApplication;
let prisma: PrismaClient;
let redis: Redis;

const employeeIds: string[] = [];
const sessionTokens: string[] = [];
const retryBurstInKeys: string[] = [];

/**
 * The calendar day a moment falls on for the company: one fixed zone used for
 * day assignment, built from the individual date fields so the output shape
 * does not depend on locale formatting quirks.
 */
const companyDateKey = (date: Date): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: COMPANY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string): string =>
    parts.find((piece) => piece.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const createSubject = async (
  status: 'active' | 'deactivated' = 'active'
): Promise<Subject> => {
  const employee = await prisma.employee.create({
    data: {
      name: 'Punch Test',
      email: `punch-${randomUUID()}@example.test`,
      position: 'Tester',
      phone: '+62-811-0000-0000',
      passwordHash: '$argon2id$never-used-by-these-tests',
      role: 'employee',
      status,
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

const punchRequest = (
  subject: Subject | null,
  key: string | null,
  body: PunchBody
) => {
  let req = request(app.getHttpServer()).post(`${BASE}/punches`);
  if (subject !== null) {
    req = req.set('Cookie', `${SESSION_COOKIE}=${subject.token}`);
  }
  if (key !== null) {
    req = req.set('Idempotency-Key', key);
  }
  return req.send(body);
};

const punch = (
  subject: Subject,
  direction: Direction,
  key: string,
  extra: PunchBody = {}
) => punchRequest(subject, key, { direction, ...extra });

const stateRequest = (subject: Subject | null) => {
  let req = request(app.getHttpServer()).get(`${BASE}/punches/state`);
  if (subject !== null) {
    req = req.set('Cookie', `${SESSION_COOKIE}=${subject.token}`);
  }
  return req;
};

const sessionsOf = (subject: Subject) =>
  prisma.attendanceSession.findMany({
    where: { employeeId: subject.employeeId },
    orderBy: { clockInAt: 'asc' },
  });

const countOf = (subject: Subject) =>
  prisma.attendanceSession.count({ where: { employeeId: subject.employeeId } });

const expectWithinWindow = (value: number, start: number, end: number): void => {
  expect(value).toBeGreaterThanOrEqual(start - CLOCK_WINDOW_MS);
  expect(value).toBeLessThanOrEqual(end + CLOCK_WINDOW_MS);
};

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

describe('punch request validation', () => {
  it('rejects a caller without a session cookie with 401 AUTH_REQUIRED', async () => {
    const response = await punchRequest(null, randomUUID(), {
      direction: 'masuk',
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('rejects a deactivated employee with 403 FORBIDDEN', async () => {
    const subject = await createSubject('deactivated');

    const response = await punch(subject, 'masuk', randomUUID());

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(await countOf(subject)).toBe(0);
  });

  it('rejects a missing Idempotency-Key with 400 MISSING_IDEMPOTENCY_KEY', async () => {
    const subject = await createSubject();

    const response = await punchRequest(subject, null, { direction: 'masuk' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'MISSING_IDEMPOTENCY_KEY',
    });
    expect(await countOf(subject)).toBe(0);
  });

  it('rejects a non-uuid Idempotency-Key with 400 IDEMPOTENCY_KEY_INVALID', async () => {
    const subject = await createSubject();

    const response = await punchRequest(subject, 'not-a-uuid', {
      direction: 'masuk',
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'IDEMPOTENCY_KEY_INVALID',
    });
    expect(await countOf(subject)).toBe(0);
  });

  it('rejects a missing direction with 400 DIRECTION_INVALID', async () => {
    const subject = await createSubject();

    const response = await punchRequest(subject, randomUUID(), {});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'DIRECTION_INVALID',
    });
    expect(await countOf(subject)).toBe(0);
  });

  it('rejects an unknown direction with 400 DIRECTION_INVALID', async () => {
    const subject = await createSubject();

    const response = await punch(subject, 'sideways' as Direction, randomUUID());

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'DIRECTION_INVALID',
    });
    expect(await countOf(subject)).toBe(0);
  });
});

describe('one open session per employee', () => {
  it('refuses a second masuk with a different key and writes nothing', async () => {
    const subject = await createSubject();

    const first = await punch(subject, 'masuk', randomUUID());
    expect(first.status).toBe(200);

    const rowsAfterFirst = await countOf(subject);
    expect(rowsAfterFirst).toBe(1);

    const second = await punch(subject, 'masuk', randomUUID());

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      statusCode: 409,
      code: 'SESSION_ALREADY_OPEN',
    });
    expect(await countOf(subject)).toBe(rowsAfterFirst);
  });

  it('lets exactly one of two simultaneous masuk punches through', async () => {
    const subject = await createSubject();

    const [left, right] = await Promise.all([
      punch(subject, 'masuk', randomUUID()),
      punch(subject, 'masuk', randomUUID()),
    ]);

    const responses = [left, right];
    const winners = responses.filter((response) => response.status === 200);
    const losers = responses.filter((response) => response.status === 409);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0].body).toMatchObject({
      direction: 'masuk',
      sessionId: expect.any(String),
      at: expect.any(String),
    });
    expect(losers[0].body).toMatchObject({ code: 'SESSION_ALREADY_OPEN' });
    expect(await countOf(subject)).toBe(1);
  });

  it('refuses pulang when there is no open session and writes nothing', async () => {
    const subject = await createSubject();

    const response = await punch(subject, 'pulang', randomUUID());

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      statusCode: 409,
      code: 'NO_OPEN_SESSION',
    });
    expect(await countOf(subject)).toBe(0);
  });
});

describe('idempotent retries', () => {
  it('returns the original row for a repeated Idempotency-Key and keeps one row', async () => {
    const subject = await createSubject();
    const key = randomUUID();

    const first = await punch(subject, 'masuk', key);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      sessionId: expect.any(String),
      direction: 'masuk',
      at: expect.any(String),
    });

    const retry = await punch(subject, 'masuk', key);

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);

    const rows = await sessionsOf(subject);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.body.sessionId);
    expect(rows[0].clockInKey).toBe(key);
  });

  it('returns the original pulang row for a repeated Idempotency-Key', async () => {
    const subject = await createSubject();

    await punch(subject, 'masuk', randomUUID());
    const outKey = randomUUID();
    const first = await punch(subject, 'pulang', outKey);
    expect(first.status).toBe(200);

    const retry = await punch(subject, 'pulang', outKey);

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);

    const rows = await sessionsOf(subject);
    expect(rows).toHaveLength(1);
    expect(rows[0].clockOutKey).toBe(outKey);
    expect(rows[0].clockOutAt?.toISOString()).toBe(first.body.at);
  });

  it('answers 422 IDEMPOTENCY_CONFLICT when a masuk key is replayed as pulang', async () => {
    const subject = await createSubject();
    const key = randomUUID();

    await punch(subject, 'masuk', key);
    const response = await punch(subject, 'pulang', key);

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      statusCode: 422,
      code: 'IDEMPOTENCY_CONFLICT',
    });

    const rows = await sessionsOf(subject);
    expect(rows).toHaveLength(1);
    expect(rows[0].clockOutAt).toBeNull();
    expect(rows[0].clockOutKey).toBeNull();
  });

  it('answers 422 IDEMPOTENCY_CONFLICT when a pulang key is replayed as masuk', async () => {
    const subject = await createSubject();

    await punch(subject, 'masuk', randomUUID());
    const outKey = randomUUID();
    await punch(subject, 'pulang', outKey);

    const response = await punch(subject, 'masuk', outKey);

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      statusCode: 422,
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await countOf(subject)).toBe(1);
  });
});

describe('server-assigned punch times', () => {
  it('stores masuk and pulang from the server clock and ignores client timestamps', async () => {
    const subject = await createSubject();
    const clientSupplied = '2001-01-01T00:00:00.000Z';

    const inStart = Date.now();
    const inResponse = await punch(subject, 'masuk', randomUUID(), {
      at: clientSupplied,
      clockInAt: clientSupplied,
      clockOutAt: clientSupplied,
      workDate: '2001-01-01',
    });
    const inEnd = Date.now();

    expect(inResponse.status).toBe(200);
    const inAt = Date.parse(inResponse.body.at);
    expectWithinWindow(inAt, inStart, inEnd);
    expect(inResponse.body.at).not.toBe(clientSupplied);

    const outStart = Date.now();
    const outResponse = await punch(subject, 'pulang', randomUUID(), {
      at: clientSupplied,
      clockOutAt: clientSupplied,
    });
    const outEnd = Date.now();

    expect(outResponse.status).toBe(200);
    const outAt = Date.parse(outResponse.body.at);
    expectWithinWindow(outAt, outStart, outEnd);
    expect(outResponse.body.at).not.toBe(clientSupplied);

    const rows = await sessionsOf(subject);
    expect(rows).toHaveLength(1);
    expect(rows[0].clockInAt.getTime()).toBe(inAt);
    expect(rows[0].clockOutAt?.getTime()).toBe(outAt);
    expect(rows[0].workDate.toISOString().slice(0, 10)).toBe(
      companyDateKey(new Date(inAt))
    );
    expect(rows[0].closedBySystem).toBe(false);
  });

  it('reports the clock-out time it just wrote on a successful pulang', async () => {
    const subject = await createSubject();

    await punch(subject, 'masuk', randomUUID());
    const outStart = Date.now();
    const response = await punch(subject, 'pulang', randomUUID());
    const outEnd = Date.now();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ direction: 'pulang' });
    expectWithinWindow(Date.parse(response.body.at), outStart, outEnd);

    const rows = await sessionsOf(subject);
    expect(rows[0].clockOutAt!.getTime()).toBe(Date.parse(response.body.at));
    expect(rows[0].clockOutAt!.getTime()).toBeGreaterThan(
      rows[0].clockInAt.getTime()
    );
  });
});

describe('GET /punches/state', () => {
  it('requires a session with 401 AUTH_REQUIRED', async () => {
    const response = await stateRequest(null);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('reports belum_masuk with no punch today', async () => {
    const subject = await createSubject();

    const response = await stateRequest(subject);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'belum_masuk' });
  });

  it('reports bekerja with the clock-in and the latest punch after masuk', async () => {
    const subject = await createSubject();
    const punchResponse = await punch(subject, 'masuk', randomUUID());
    expect(punchResponse.status).toBe(200);

    const response = await stateRequest(subject);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'bekerja',
      clockInAt: punchResponse.body.at,
      lastPunch: punchResponse.body.at,
    });
  });

  it('reports belum_masuk again after pulang, keeping the latest punch', async () => {
    const subject = await createSubject();
    await punch(subject, 'masuk', randomUUID());
    const outResponse = await punch(subject, 'pulang', randomUUID());
    expect(outResponse.status).toBe(200);

    const response = await stateRequest(subject);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'belum_masuk',
      lastPunch: outResponse.body.at,
    });
  });
});

describe('sequential retry bursts', () => {
  it.each(Array.from({ length: 100 }, (_, index) => index))(
    'burst %i with one reused Idempotency-Key still yields exactly one row per key',
    async (index) => {
      const subject = await createSubject();
      const inKey = randomUUID();
      const outKey = randomUUID();
      retryBurstInKeys.push(inKey);

      const firstMasuk = await punch(subject, 'masuk', inKey);
      expect(firstMasuk.status).toBe(200);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const retry = await punch(subject, 'masuk', inKey);
        expect(retry.status).toBe(200);
        expect(retry.body).toEqual(firstMasuk.body);
      }

      const firstPulang = await punch(subject, 'pulang', outKey);
      expect(firstPulang.status).toBe(200);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const retry = await punch(subject, 'pulang', outKey);
        expect(retry.status).toBe(200);
        expect(retry.body).toEqual(firstPulang.body);
      }

      const rowsForInKey = await prisma.attendanceSession.findMany({
        where: { clockInKey: inKey },
      });
      expect(rowsForInKey).toHaveLength(1);
      expect(rowsForInKey[0].clockOutKey).toBe(outKey);
      expect(await countOf(subject)).toBe(1);

      const totalForBurstKeys = await prisma.attendanceSession.count({
        where: { clockInKey: { in: retryBurstInKeys } },
      });
      expect(totalForBurstKeys).toBe(index + 1);
    },
    20000
  );

  it('kept exactly one row for each of the 100 keys', async () => {
    expect(retryBurstInKeys).toHaveLength(100);

    const rows = await prisma.attendanceSession.findMany({
      where: { clockInKey: { in: retryBurstInKeys } },
    });
    expect(rows).toHaveLength(100);
    expect(new Set(rows.map((row) => row.clockInKey)).size).toBe(100);
  });
});
