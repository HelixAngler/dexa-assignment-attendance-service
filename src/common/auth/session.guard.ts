import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppException } from '../app.exception';
import { PERMISSION_KEY, PUBLIC_KEY } from './decorators';
import {
  EMPLOYEE_STATUS_READER,
  EmployeeStatusReader,
} from './employee-status.reader';
import { hasPermission, PermissionCode } from './permissions';
import {
  SESSION_COOKIE,
  SESSION_STORE,
  SessionData,
  SessionStore,
} from './session.reader';

/**
 * The session as attached to a request. Every field mirrors the stored
 * payload except `role`, which is replaced with the value read from the
 * employees table on this very request.
 */
export type AuthenticatedSession = SessionData;

export interface AuthRequest {
  cookies?: Record<string, string | undefined>;
  session?: AuthenticatedSession;
}

export type AuthenticatedRequest = AuthRequest & {
  session: AuthenticatedSession;
};

/**
 * Default-deny authentication + authorization guard.
 *
 * Outcomes (machine codes rendered by the global error filter):
 * - `@Public()` route → allowed without touching the store.
 * - missing cookie, unknown token or a token past its lifetime → 401
 *   `AUTH_REQUIRED`.
 * - session valid but the employee row is missing, deactivated, or the role
 *   stored in the database lacks the route's `@RequirePermission` code →
 *   403 `FORBIDDEN`. Denying with 403 keeps "authenticated but not allowed"
 *   distinct from "not authenticated" for clients.
 * - session valid and no permission code declared → allowed (any live session
 *   may call the route).
 *
 * The permission check always uses the role freshly read from the employees
 * table — never the role carried in the session payload — so promotions,
 * demotions and deactivations apply on the next request instead of when the
 * session expires.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
    @Inject(EMPLOYEE_STATUS_READER)
    private readonly employees: EmployeeStatusReader
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) {
      throw new AppException(401, 'AUTH_REQUIRED');
    }

    const session = await this.sessions.read(token);
    if (!session) {
      throw new AppException(401, 'AUTH_REQUIRED');
    }

    const employee = await this.employees.getCurrent(session.employeeId);
    if (!employee || employee.status !== 'active') {
      throw new AppException(403, 'FORBIDDEN');
    }

    const required = this.reflector.getAllAndOverride<
      PermissionCode | undefined
    >(PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (required !== undefined && !hasPermission(employee.role, required)) {
      throw new AppException(403, 'FORBIDDEN');
    }

    request.session = { ...session, role: employee.role };
    return true;
  }
}
