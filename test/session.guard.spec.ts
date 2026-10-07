import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppException } from '../src/common/app.exception';
import { Public, RequirePermission } from '../src/common/auth/decorators';
import {
  EmployeeStatusSnapshot,
} from '../src/common/auth/employee-status.reader';
import { SessionGuard } from '../src/common/auth/session.guard';
import { SessionData } from '../src/common/auth/session.reader';

const TOKEN = 'opaque-session-token';
const EMPLOYEE_ID = '4b1a2f0e-1111-2222-3333-444455556666';

type TestRequest = {
  cookies?: Record<string, string>;
  session?: SessionData;
};

const session = (overrides: Partial<SessionData> = {}): SessionData => ({
  employeeId: EMPLOYEE_ID,
  role: 'employee',
  mustChangePassword: false,
  lastSeen: 1_760_000_000_000,
  issuedAt: 1_760_000_000_000,
  ...overrides,
});

const snapshot = (
  overrides: Partial<EmployeeStatusSnapshot> = {}
): EmployeeStatusSnapshot => ({
  status: 'active',
  role: 'employee',
  ...overrides,
});

const fakeStore = (result: SessionData | null) => ({
  read: jest.fn<Promise<SessionData | null>, [string]>().mockResolvedValue(result),
});

const fakeReader = (result: EmployeeStatusSnapshot | null) => ({
  getCurrent: jest
    .fn<Promise<EmployeeStatusSnapshot | null>, [string]>()
    .mockResolvedValue(result),
});

const context = (request: unknown, handler: object, controller: object) =>
  ({
    getHandler: () => handler,
    getClass: () => controller,
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  }) as unknown as ExecutionContext;

class GuardedController {
  @RequirePermission('employee:read')
  hrdOnly(): void {}

  anySession(): void {}

  @Public()
  publicRoute(): void {}
}

class OtherController {}

const handler = {
  hrdOnly: GuardedController.prototype.hrdOnly,
  anySession: GuardedController.prototype.anySession,
  publicRoute: GuardedController.prototype.publicRoute,
};

const guardWith = (
  store: ReturnType<typeof fakeStore>,
  reader: ReturnType<typeof fakeReader>
) => new SessionGuard(new Reflector(), store, reader);

describe('SessionGuard', () => {
  it('rejects a request without the session cookie with 401 AUTH_REQUIRED', async () => {
    const store = fakeStore(session());
    const reader = fakeReader(snapshot());
    const guard = guardWith(store, reader);
    const req: TestRequest = { cookies: {} };

    await expect(
      guard.canActivate(context(req, handler.anySession, OtherController))
    ).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_REQUIRED' });
    expect(store.read).not.toHaveBeenCalled();
    expect(reader.getCurrent).not.toHaveBeenCalled();
  });

  it('rejects an absent/expired token with 401 AUTH_REQUIRED', async () => {
    const store = fakeStore(null);
    const reader = fakeReader(snapshot());
    const guard = guardWith(store, reader);
    const req: TestRequest = { cookies: { sid: TOKEN } };

    await expect(
      guard.canActivate(context(req, handler.anySession, OtherController))
    ).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_REQUIRED' });
    expect(store.read).toHaveBeenCalledWith(TOKEN);
    expect(reader.getCurrent).not.toHaveBeenCalled();
  });

  it('passes a valid session with an active employee and attaches the session', async () => {
    const stored = session({ role: 'hrd' });
    const store = fakeStore(stored);
    const reader = fakeReader(snapshot({ status: 'active', role: 'hrd' }));
    const guard = guardWith(store, reader);
    const req: TestRequest = { cookies: { sid: TOKEN } };

    await expect(
      guard.canActivate(context(req, handler.anySession, OtherController))
    ).resolves.toBe(true);
    expect(store.read).toHaveBeenCalledWith(TOKEN);
    expect(reader.getCurrent).toHaveBeenCalledWith(EMPLOYEE_ID);
    expect(req.session).toEqual(stored);
  });

  it('rejects a deactivated employee with 403 FORBIDDEN', async () => {
    const store = fakeStore(session());
    const reader = fakeReader(snapshot({ status: 'deactivated' }));
    const guard = guardWith(store, reader);
    const req: TestRequest = { cookies: { sid: TOKEN } };

    await expect(
      guard.canActivate(context(req, handler.anySession, OtherController))
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(req.session).toBeUndefined();
  });

  it('rejects with 403 FORBIDDEN when the employee row no longer exists', async () => {
    const store = fakeStore(session());
    const reader = fakeReader(null);
    const guard = guardWith(store, reader);
    const req: TestRequest = { cookies: { sid: TOKEN } };

    await expect(
      guard.canActivate(context(req, handler.anySession, OtherController))
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('uses the database role for the permission check when it was downgraded', async () => {
    const store = fakeStore(session({ role: 'hrd' }));
    const reader = fakeReader(snapshot({ status: 'active', role: 'employee' }));
    const guard = guardWith(store, reader);
    const req: TestRequest = { cookies: { sid: TOKEN } };

    await expect(
      guard.canActivate(context(req, handler.hrdOnly, GuardedController))
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('grants an hrd-only route when the database role is hrd, even if the session said otherwise', async () => {
    const store = fakeStore(session({ role: 'employee' }));
    const reader = fakeReader(snapshot({ status: 'active', role: 'hrd' }));
    const guard = guardWith(store, reader);
    const req: TestRequest = { cookies: { sid: TOKEN } };

    await expect(
      guard.canActivate(context(req, handler.hrdOnly, GuardedController))
    ).resolves.toBe(true);
    expect(req.session?.role).toBe('hrd');
  });

  it('rejects an employee role for an hrd-only route with 403 FORBIDDEN', async () => {
    const store = fakeStore(session({ role: 'employee' }));
    const reader = fakeReader(snapshot({ status: 'active', role: 'employee' }));
    const guard = guardWith(store, reader);
    const req: TestRequest = { cookies: { sid: TOKEN } };

    await expect(
      guard.canActivate(context(req, handler.hrdOnly, GuardedController))
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('allows any live session on a route with no permission code', async () => {
    const store = fakeStore(session());
    const reader = fakeReader(snapshot({ status: 'active', role: 'employee' }));
    const guard = guardWith(store, reader);
    const req: TestRequest = { cookies: { sid: TOKEN } };

    await expect(
      guard.canActivate(context(req, handler.anySession, GuardedController))
    ).resolves.toBe(true);
    expect(req.session).toEqual({ ...session(), role: 'employee' });
  });

  it('bypasses everything on a @Public route', async () => {
    const store = fakeStore(null);
    const reader = fakeReader(null);
    const guard = guardWith(store, reader);

    await expect(
      guard.canActivate(context({}, handler.publicRoute, GuardedController))
    ).resolves.toBe(true);
    expect(store.read).not.toHaveBeenCalled();
    expect(reader.getCurrent).not.toHaveBeenCalled();
  });

  it('fails closed when the session store throws', async () => {
    const store = { read: jest.fn<Promise<SessionData | null>, [string]>().mockRejectedValue(new Error('redis down')) };
    const reader = fakeReader(snapshot());
    const guard = guardWith(store, reader);

    await expect(
      guard.canActivate(
        context({ cookies: { sid: TOKEN } }, handler.anySession, OtherController)
      )
    ).rejects.toThrow('redis down');
  });

  it('surfaces errors as AppException instances carrying status and code', async () => {
    const guard = guardWith(fakeStore(null), fakeReader(snapshot()));

    const error = await guard
      .canActivate(
        context({ cookies: { sid: TOKEN } }, handler.anySession, OtherController)
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppException);
  });
});
