import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';

import { createApp } from '../src/app';
import { companyDateKey } from '../src/common/company-time';
import { PrismaClient } from '../src/generated/prisma';

const BASE = '/api/attendance';
/** The day view resource: the global prefix plus the controller's own path. */
const RESOURCE = `${BASE}/attendance`;
const SESSION_COOKIE = 'sid';

type Subject = {
  employeeId: string;
  token: string;
};

/** One employee row as the day view renders it. */
type AttendanceRow = {
  employeeId: string;
  name: string;
  masuk: string | null;
  pulang: string | null;
  state: 'done' | 'open' | '-';
};

type EmployeeOptions = {
  role?: 'employee' | 'hrd';
  status?: 'active' | 'deactivated';
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
};

let app: INestApplication;
let prisma: PrismaClient;
let redis: Redis;

const employeeIds: string[] = [];
const sessionTokens: string[] = [];

/**
 * Every fixture name and address carries one of these, so a response that also
 * holds rows written by anybody else can be narrowed down to this test's own
 * employees before any assertion runs.
 */
const newMarker = (): string => randomUUID();

/** Shifts a `YYYY-MM-DD` key by whole calendar days. */
const addDays = (key: string, days: number): string => {
  const date = new Date(`${key}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const createEmployee = async (
  marker: string,
  tag: string,
  options: EmployeeOptions = {}
): Promise<string> => {
  const employee = await prisma.employee.create({
    data: {
      name: `Zvw ${marker} ${tag}`,
      email: `zvw-${marker}-${tag.toLowerCase()}@example.test`,
      position: 'Tester',
      phone: '+62-811-0000-0000',
      passwordHash: '$argon2id$never-used-by-these-tests',
      role: options.role ?? 'employee',
      status: options.status ?? 'active',
    },
  });
  employeeIds.push(employee.id);
  return employee.id;
};

/** A live session cookie for one of the fixture employees. */
const createSession = async (
  employeeId: string,
  role: 'employee' | 'hrd'
): Promise<Subject> => {
  const token = randomUUID();
  sessionTokens.push(token);
  const now = Date.now();
  await redis.set(
    `sess:${token}`,
    JSON.stringify({
      employeeId,
      role,
      mustChangePassword: false,
      lastSeen: now,
      issuedAt: now,
    }),
    'PX',
    30 * 60 * 1000
  );
  return { employeeId, token };
};

/** The HRD caller every request in these tests signs in as. */
const createHrdCaller = async (marker: string): Promise<Subject> => {
  const employeeId = await createEmployee(marker, 'Caller', { role: 'hrd' });
  return createSession(employeeId, 'hrd');
};

/** An ordinary employee session, used to prove the route is HRD-only. */
const createEmployeeCaller = async (marker: string): Promise<Subject> => {
  const employeeId = await createEmployee(marker, 'Plain', {
    role: 'employee',
  });
  return createSession(employeeId, 'employee');
};

const addSession = async (
  employeeId: string,
  fixture: SessionFixture
): Promise<void> => {
  const clockOutAt = fixture.clockOutAt ?? null;
  await prisma.attendanceSession.create({
    data: {
      employeeId,
      workDate: new Date(`${fixture.workDate}T00:00:00.000Z`),
      clockInAt: new Date(fixture.clockInAt),
      clockOutAt: clockOutAt === null ? null : new Date(clockOutAt),
      clockInKey: randomUUID(),
      clockOutKey: clockOutAt === null ? null : randomUUID(),
      closedBySystem: false,
    },
  });
};

const closedOn = (workDate: string): SessionFixture => ({
  workDate,
  clockInAt: `${workDate}T01:00:00.000Z`,
  clockOutAt: `${workDate}T08:00:00.000Z`,
});

const viewRequest = (subject: Subject | null, query = '') => {
  let req = request(app.getHttpServer()).get(`${RESOURCE}${query}`);
  if (subject !== null) {
    req = req.set('Cookie', `${SESSION_COOKIE}=${subject.token}`);
  }
  return req;
};

/** Narrows a response to this test's own employees, in the order it came back. */
const fixtureRows = (
  body: { rows: AttendanceRow[] },
  ids: string[]
): AttendanceRow[] => body.rows.filter((row) => ids.includes(row.employeeId));

const rowFor = (
  body: { rows: AttendanceRow[] },
  employeeId: string
): AttendanceRow | undefined =>
  body.rows.find((row) => row.employeeId === employeeId);

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

describe('GET /attendance rows for a date', () => {
  it('returns this date state for closed, open and unpunched employees alike', async () => {
    const marker = newMarker();
    const hrd = await createHrdCaller(marker);
    const doneId = await createEmployee(marker, 'Done');
    const openId = await createEmployee(marker, 'Open');
    const noneId = await createEmployee(marker, 'None');
    const today = companyDateKey();

    await addSession(doneId, {
      workDate: today,
      clockInAt: `${today}T01:00:00.000Z`,
      clockOutAt: `${today}T08:00:00.000Z`,
    });
    await addSession(openId, {
      workDate: today,
      clockInAt: `${today}T02:00:00.000Z`,
      clockOutAt: null,
    });

    const response = await viewRequest(hrd, `?date=${today}`);

    expect(response.status).toBe(200);
    const rows = fixtureRows(response.body, [doneId, openId, noneId]);
    expect(rows).toHaveLength(3);
    // Name order: Done < None < Open once the shared marker prefix is consumed.
    expect(rows.map((row) => row.employeeId)).toEqual([
      doneId,
      noneId,
      openId,
    ]);
    expect(rows[0]).toEqual({
      employeeId: doneId,
      name: `Zvw ${marker} Done`,
      masuk: `${today}T01:00:00.000Z`,
      pulang: `${today}T08:00:00.000Z`,
      state: 'done',
    });
    expect(rows[1]).toEqual({
      employeeId: noneId,
      name: `Zvw ${marker} None`,
      masuk: null,
      pulang: null,
      state: '-',
    });
    expect(rows[2]).toEqual({
      employeeId: openId,
      name: `Zvw ${marker} Open`,
      masuk: `${today}T02:00:00.000Z`,
      pulang: null,
      state: 'open',
    });
    // The frozen row shape — nothing more and nothing less per employee.
    expect(Object.keys(rows[0]).sort()).toEqual([
      'employeeId',
      'masuk',
      'name',
      'pulang',
      'state',
    ]);
  });

  it('keeps deactivated employees in the list, history included', async () => {
    const marker = newMarker();
    const hrd = await createHrdCaller(marker);
    const offId = await createEmployee(marker, 'Offline', {
      status: 'deactivated',
    });
    const today = companyDateKey();
    await addSession(offId, closedOn(today));

    const response = await viewRequest(hrd, `?date=${today}`);

    expect(response.status).toBe(200);
    expect(rowFor(response.body, offId)).toEqual({
      employeeId: offId,
      name: `Zvw ${marker} Offline`,
      masuk: `${today}T01:00:00.000Z`,
      pulang: `${today}T08:00:00.000Z`,
      state: 'done',
    });
  });
});

describe('GET /attendance name search', () => {
  it('keeps case-insensitive substring matches, punched or not, and drops the rest', async () => {
    const token = newMarker().toUpperCase();
    const otherToken = newMarker().toUpperCase();
    // The caller carries a marker of its own, so its name can never match the
    // needle below and sneak an extra row into the expectation.
    const hrd = await createHrdCaller(otherToken);
    const punchedId = await createEmployee(token, 'Alpha');
    const unpunchedId = await createEmployee(token, 'Beta');
    const missId = await createEmployee(otherToken, 'Gamma');
    const today = companyDateKey();

    await addSession(punchedId, closedOn(today));
    await addSession(missId, closedOn(today));

    // The needle is written upper-case in the names and searched lower-case.
    const needle = token.toLowerCase();
    const response = await viewRequest(
      hrd,
      `?date=${today}&q=${needle}`
    );

    expect(response.status).toBe(200);
    const rows = response.body.rows as AttendanceRow[];
    expect(rows.map((row) => row.employeeId)).toEqual([
      punchedId,
      unpunchedId,
    ]);
    expect(rowFor(response.body, unpunchedId)?.state).toBe('-');
    expect(rowFor(response.body, punchedId)?.state).toBe('done');
    expect(rowFor(response.body, missId)).toBeUndefined();
    // Nothing outside this marker's employees survives the filter.
    expect(
      rows.every((row) => row.name.toLowerCase().includes(needle))
    ).toBe(true);
  });
});

describe('GET /attendance date boundaries', () => {
  it("shows another day's session only when that day is asked for", async () => {
    const marker = newMarker();
    const hrd = await createHrdCaller(marker);
    const subjectId = await createEmployee(marker, 'Yester');
    const today = companyDateKey();
    const yesterday = addDays(today, -1);
    await addSession(subjectId, closedOn(yesterday));

    const todayView = await viewRequest(hrd, `?date=${today}`);
    expect(todayView.status).toBe(200);
    expect(rowFor(todayView.body, subjectId)).toEqual({
      employeeId: subjectId,
      name: `Zvw ${marker} Yester`,
      masuk: null,
      pulang: null,
      state: '-',
    });

    const yesterdayView = await viewRequest(hrd, `?date=${yesterday}`);
    expect(yesterdayView.status).toBe(200);
    expect(rowFor(yesterdayView.body, subjectId)).toEqual({
      employeeId: subjectId,
      name: `Zvw ${marker} Yester`,
      masuk: `${yesterday}T01:00:00.000Z`,
      pulang: `${yesterday}T08:00:00.000Z`,
      state: 'done',
    });
  });
});

describe('GET /attendance permissions', () => {
  it('answers 401 AUTH_REQUIRED to an anonymous caller', async () => {
    const response = await viewRequest(null, `?date=${companyDateKey()}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('answers 403 FORBIDDEN to an ordinary employee session', async () => {
    const marker = newMarker();
    const employee = await createEmployeeCaller(marker);

    const response = await viewRequest(employee, `?date=${companyDateKey()}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });

  it('answers 200 to an HRD session', async () => {
    const marker = newMarker();
    const hrd = await createHrdCaller(marker);

    const response = await viewRequest(hrd, `?date=${companyDateKey()}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.rows)).toBe(true);
  });
});

describe('attendance resource has no mutating verbs', () => {
  it.each(['post', 'put', 'patch', 'delete'] as const)(
    'answers 404 to %s on the resource',
    async (method) => {
      const marker = newMarker();
      const hrd = await createHrdCaller(marker);

      const response = await request(app.getHttpServer())[method](RESOURCE)
        .set('Cookie', `${SESSION_COOKIE}=${hrd.token}`)
        .send({ date: companyDateKey() });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    }
  );

  it('answers 404 to a mutating verb on a sub-path of the resource', async () => {
    const marker = newMarker();
    const hrd = await createHrdCaller(marker);

    const response = await request(app.getHttpServer())
      .post(`${RESOURCE}/${marker}`)
      .set('Cookie', `${SESSION_COOKIE}=${hrd.token}`)
      .send({});

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('GET /attendance date parameter', () => {
  it('defaults to the current company day when the parameter is absent', async () => {
    const marker = newMarker();
    const hrd = await createHrdCaller(marker);
    const todayId = await createEmployee(marker, 'Today');
    const yesterdayId = await createEmployee(marker, 'Yday');
    const today = companyDateKey();
    const yesterday = addDays(today, -1);
    await addSession(todayId, closedOn(today));
    await addSession(yesterdayId, closedOn(yesterday));

    const implicit = await viewRequest(hrd);
    const explicit = await viewRequest(hrd, `?date=${today}`);

    expect(implicit.status).toBe(200);
    expect(explicit.status).toBe(200);
    expect(fixtureRows(implicit.body, [todayId, yesterdayId])).toEqual(
      fixtureRows(explicit.body, [todayId, yesterdayId])
    );
    expect(rowFor(implicit.body, todayId)?.state).toBe('done');
    expect(rowFor(implicit.body, yesterdayId)?.state).toBe('-');
  });

  it.each([
    ['a non-date string', '?date=not-a-date'],
    ['a slash-separated day', `?date=${companyDateKey().replace(/-/g, '/')}`],
    ['an impossible day of the month', `?date=${companyDateKey().slice(0, 8)}32`],
    ['an impossible month', `?date=${companyDateKey().slice(0, 4)}-13-01`],
    ['a repeated parameter', `?date=${companyDateKey()}&date=${companyDateKey()}`],
  ])('answers 400 DATE_INVALID for %s', async (_label, query) => {
    const marker = newMarker();
    const hrd = await createHrdCaller(marker);

    const response = await viewRequest(hrd, query);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'DATE_INVALID',
    });
    expect(typeof response.body.message).toBe('string');
    expect(response.body.message.length).toBeGreaterThan(0);
  });
});
