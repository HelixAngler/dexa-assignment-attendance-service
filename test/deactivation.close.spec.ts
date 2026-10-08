import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/app';
import { companyWorkDate } from '../src/common/company-time';
import { ERROR_MESSAGES } from '../src/common/http-exception.filter';
import { PrismaClient } from '../src/generated/prisma';

const BASE = '/api/attendance';
const CLOSE_OPEN_PATH = `${BASE}/internal/sessions/close-open`;
const TOKEN_HEADER = 'X-Internal-Token';
const INTERNAL_TOKEN = 'close-open-test-token';
/** Tolerance when comparing a system-written clock-out against the test clock. */
const CLOCK_WINDOW_MS = 2000;

let app: INestApplication;
let prisma: PrismaClient;

const employeeIds: string[] = [];
const sessionIds: string[] = [];

const previousInternalToken = process.env.INTERNAL_API_TOKEN;

const createEmployee = async (): Promise<string> => {
  const employee = await prisma.employee.create({
    data: {
      name: 'Close Test',
      email: `close-${randomUUID()}@example.test`,
      position: 'Tester',
      phone: '+62-812-0000-0000',
      passwordHash: '$argon2id$never-used-by-these-tests',
      role: 'employee',
      status: 'active',
    },
  });
  employeeIds.push(employee.id);
  return employee.id;
};

const createOpenSession = async (employeeId: string): Promise<string> => {
  const row = await prisma.attendanceSession.create({
    data: {
      employeeId,
      workDate: companyWorkDate(),
      clockInAt: new Date(Date.now() - 60 * 60 * 1000),
      clockInKey: randomUUID(),
    },
  });
  sessionIds.push(row.id);
  return row.id;
};

const createClosedSession = async (
  employeeId: string,
  clockOutAt: Date
): Promise<string> => {
  const row = await prisma.attendanceSession.create({
    data: {
      employeeId,
      workDate: companyWorkDate(),
      clockInAt: new Date(clockOutAt.getTime() - 60 * 60 * 1000),
      clockInKey: randomUUID(),
      clockOutAt,
      clockOutKey: randomUUID(),
    },
  });
  sessionIds.push(row.id);
  return row.id;
};

const closeOpenRequest = (
  body: Record<string, unknown> | undefined,
  token: string | null
) => {
  let req = request(app.getHttpServer()).post(CLOSE_OPEN_PATH);
  if (token !== null) {
    req = req.set(TOKEN_HEADER, token);
  }
  return body === undefined ? req : req.send(body);
};

const sessionById = (id: string) =>
  prisma.attendanceSession.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  process.env.INTERNAL_API_TOKEN = INTERNAL_TOKEN;
  app = await createApp();
  prisma = new PrismaClient();
});

afterAll(async () => {
  await prisma.attendanceSession.deleteMany({
    where: { id: { in: sessionIds } },
  });
  await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
  if (previousInternalToken === undefined) {
    delete process.env.INTERNAL_API_TOKEN;
  } else {
    process.env.INTERNAL_API_TOKEN = previousInternalToken;
  }
  await prisma.$disconnect();
  await app.close();
});

describe('internal token guard', () => {
  it('rejects a caller without the token with 403 INTERNAL_FORBIDDEN', async () => {
    const employeeId = await createEmployee();
    const sessionId = await createOpenSession(employeeId);

    const response = await closeOpenRequest({ employeeId }, null);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      statusCode: 403,
      code: 'INTERNAL_FORBIDDEN',
    });
    expect((await sessionById(sessionId)).clockOutAt).toBeNull();
  });

  it('rejects a wrong token with 403 INTERNAL_FORBIDDEN', async () => {
    const employeeId = await createEmployee();
    const sessionId = await createOpenSession(employeeId);

    const response = await closeOpenRequest(
      { employeeId },
      `${INTERNAL_TOKEN}-wrong`
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      statusCode: 403,
      code: 'INTERNAL_FORBIDDEN',
    });
    expect((await sessionById(sessionId)).clockOutAt).toBeNull();
  });
});

describe('close-open request validation', () => {
  it('rejects a body without employeeId with 400 INVALID_BODY', async () => {
    const response = await closeOpenRequest({}, INTERNAL_TOKEN);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'INVALID_BODY',
    });
  });

  it('rejects a blank employeeId with 400 INVALID_BODY', async () => {
    const response = await closeOpenRequest(
      { employeeId: '   ' },
      INTERNAL_TOKEN
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'INVALID_BODY',
    });
  });

  it('rejects a request without any body with 400 INVALID_BODY', async () => {
    const response = await closeOpenRequest(undefined, INTERNAL_TOKEN);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'INVALID_BODY',
    });
  });
});

describe('closing open sessions', () => {
  it('closes the open session with closed_by_system and a fresh clock_out_at', async () => {
    const employeeId = await createEmployee();
    const openId = await createOpenSession(employeeId);
    const alreadyOutAt = new Date(Date.now() - 30 * 60 * 1000);
    const closedId = await createClosedSession(employeeId, alreadyOutAt);

    const startedAt = Date.now();
    const response = await closeOpenRequest({ employeeId }, INTERNAL_TOKEN);
    const finishedAt = Date.now();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ closed: 1 });

    const closedRow = await sessionById(openId);
    expect(closedRow.clockOutAt).not.toBeNull();
    const closedAt = closedRow.clockOutAt!.getTime();
    expect(closedAt).toBeGreaterThanOrEqual(startedAt - CLOCK_WINDOW_MS);
    expect(closedAt).toBeLessThanOrEqual(finishedAt + CLOCK_WINDOW_MS);
    expect(closedRow.closedBySystem).toBe(true);

    const untouched = await sessionById(closedId);
    expect(untouched.clockOutAt?.getTime()).toBe(alreadyOutAt.getTime());
    expect(untouched.closedBySystem).toBe(false);
  });

  it('leaves another employee’s open session alone', async () => {
    const employeeId = await createEmployee();
    const otherId = await createEmployee();
    await createOpenSession(employeeId);
    const otherOpenId = await createOpenSession(otherId);

    const response = await closeOpenRequest({ employeeId }, INTERNAL_TOKEN);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ closed: 1 });
    expect((await sessionById(otherOpenId)).clockOutAt).toBeNull();
  });

  it('answers {closed: 0} when the employee has no open session', async () => {
    const employeeId = await createEmployee();

    const response = await closeOpenRequest({ employeeId }, INTERNAL_TOKEN);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ closed: 0 });
  });

  it('answers {closed: 0} for an employee id that has no rows at all', async () => {
    const response = await closeOpenRequest(
      { employeeId: randomUUID() },
      INTERNAL_TOKEN
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ closed: 0 });
  });

  it('is idempotent: the second call closes nothing and keeps the first stamp', async () => {
    const employeeId = await createEmployee();
    const openId = await createOpenSession(employeeId);

    const first = await closeOpenRequest({ employeeId }, INTERNAL_TOKEN);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ closed: 1 });
    const firstStamp = (await sessionById(openId)).clockOutAt;

    const second = await closeOpenRequest({ employeeId }, INTERNAL_TOKEN);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ closed: 0 });
    const afterSecond = await sessionById(openId);
    expect(afterSecond.clockOutAt?.getTime()).toBe(firstStamp!.getTime());
    expect(afterSecond.closedBySystem).toBe(true);
  });
});

describe('error message table additions', () => {
  it.each(['INVALID_BODY', 'INTERNAL_FORBIDDEN'])(
    'defines %s in both Indonesian and English',
    (code) => {
      const entry = ERROR_MESSAGES[code];
      expect(entry).toBeDefined();
      expect(entry.id.trim().length).toBeGreaterThan(0);
      expect(entry.en.trim().length).toBeGreaterThan(0);
      expect(entry.id).not.toBe(entry.en);
    }
  );
});
