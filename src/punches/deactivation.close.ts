import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  HttpCode,
  Inject,
  Injectable,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AppException } from '../common/app.exception';
import { PRISMA_CLIENT, ManagedPrismaClient } from '../common/prisma.client';
import type { PrismaClient } from '../generated/prisma';

/** What a successful call answers: how many rows this call stamped shut. */
export type CloseOpenResult = {
  closed: number;
};

/** Wire shape of an employee id: a plain UUID, nothing else. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lower-cased header name carrying the shared service-to-service token. */
const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/**
 * Reads the single field this endpoint acts on. Anything the service could
 * never turn into a row lookup — no body at all, a non-object body, a missing
 * or blank value, a value that is not a UUID — is refused before the database
 * is touched, so no request shape can provoke a malformed query.
 */
const readEmployeeId = (body: unknown): string => {
  if (typeof body === 'object' && body !== null) {
    const candidate = (body as { employeeId?: unknown }).employeeId;
    if (typeof candidate === 'string') {
      const value = candidate.trim();
      if (UUID_PATTERN.test(value)) {
        return value;
      }
    }
  }
  throw new AppException(400, 'INVALID_BODY');
};

/**
 * Service-to-service authentication, deliberately separate from the session
 * guard: no browser ever calls this route, so there is no session cookie to
 * read and no role to authorize. The one credential is a shared secret that
 * the neighbouring service sends in the `X-Internal-Token` header; a missing
 * header, a wrong value, or a deployment where the secret was never
 * configured are all the same answer — 403 `INTERNAL_FORBIDDEN`, with the
 * request never reaching the route handler.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const provided = request.headers?.[INTERNAL_TOKEN_HEADER];
    const expected = process.env.INTERNAL_API_TOKEN;

    if (
      typeof expected === 'string' &&
      expected !== '' &&
      typeof provided === 'string' &&
      provided === expected
    ) {
      return true;
    }
    throw new AppException(403, 'INTERNAL_FORBIDDEN');
  }
}

/**
 * Closes the one session an employee may still have open, stamping it as a
 * system action rather than an employee clock-out.
 *
 * The write runs in a transaction with the same shape the punch service uses:
 * the open row is located, then updated behind the still-open predicate, so a
 * clock-out landing at the same moment cannot be overwritten — the loser of
 * that race simply updates nothing. An employee with no open session is not
 * an error: nothing is written and the caller is told zero rows closed, which
 * makes repeating the call harmless.
 */
@Injectable()
export class DeactivationCloseService {
  private readonly prisma: PrismaClient;

  constructor(@Inject(PRISMA_CLIENT) managed: ManagedPrismaClient) {
    this.prisma = managed.client;
  }

  async closeOpen(employeeId: string): Promise<CloseOpenResult> {
    const now = new Date();
    const closed = await this.prisma.$transaction(async (tx) => {
      const open = await tx.attendanceSession.findFirst({
        where: { employeeId, clockOutAt: null },
        select: { id: true },
      });
      if (open === null) {
        return 0;
      }
      const updated = await tx.attendanceSession.updateMany({
        where: { id: open.id, clockOutAt: null },
        data: { clockOutAt: now, closedBySystem: true },
      });
      return updated.count;
    });
    return { closed };
  }
}

/**
 * Internal endpoint another backend calls right after it deactivates an
 * account, so a session the employee left open does not stay open forever.
 *
 * The route carries only the internal token guard — never the session guard —
 * and answers 200 for both outcomes, one row closed or none: a repeat call
 * for an employee already handled is a success reporting zero, not a failure.
 */
@Controller('internal/sessions')
@UseGuards(InternalTokenGuard)
export class DeactivationCloseController {
  constructor(private readonly closers: DeactivationCloseService) {}

  @Post('close-open')
  @HttpCode(200)
  closeOpen(@Body() body: unknown): Promise<CloseOpenResult> {
    return this.closers.closeOpen(readEmployeeId(body));
  }
}
