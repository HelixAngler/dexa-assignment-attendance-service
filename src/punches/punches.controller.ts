import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AppException } from '../common/app.exception';
import { RequirePermission } from '../common/auth/decorators';
import {
  AuthenticatedRequest,
  SessionGuard,
} from '../common/auth/session.guard';
import {
  isIdempotencyKey,
  PunchDirection,
  PunchesService,
  PunchResult,
  PunchState,
} from './punches.service';

type IdempotencyHeader = string | string[] | undefined;

/**
 * Reads and validates the idempotency key a punch must carry. The key is what
 * makes a retried request answerable without writing twice, so a request that
 * has none — or one the database could never store — is rejected before any
 * lookup happens.
 */
const readIdempotencyKey = (header: IdempotencyHeader): string => {
  const raw = (Array.isArray(header) ? header[0] : header)?.trim();
  if (raw === undefined || raw === '') {
    throw new AppException(400, 'MISSING_IDEMPOTENCY_KEY');
  }
  if (!isIdempotencyKey(raw)) {
    throw new AppException(400, 'IDEMPOTENCY_KEY_INVALID');
  }
  return raw;
};

const readDirection = (body: unknown): PunchDirection => {
  if (typeof body === 'object' && body !== null) {
    const candidate = (body as { direction?: unknown }).direction;
    if (candidate === 'masuk' || candidate === 'pulang') {
      return candidate;
    }
  }
  throw new AppException(400, 'DIRECTION_INVALID');
};

/**
 * Employee-facing punch endpoints.
 *
 * Both routes sit behind the session guard and the `attendance:punch`
 * permission, so only a live session of an active holder of that permission
 * ever reaches the service; the scope is always the signed-in employee, never
 * anything supplied in the request.
 */
@Controller('punches')
@UseGuards(SessionGuard)
export class PunchesController {
  constructor(private readonly punches: PunchesService) {}

  // A punch is an idempotent command rather than a resource creation: every
  // successful attempt answers 200, whether it is the first or a replay.
  @Post()
  @HttpCode(200)
  @RequirePermission('attendance:punch')
  create(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: IdempotencyHeader,
    @Body() body: unknown
  ): Promise<PunchResult> {
    const key = readIdempotencyKey(idempotencyKey);
    const direction = readDirection(body);
    return this.punches.punch(request.session.employeeId, direction, key);
  }

  @Get('state')
  @RequirePermission('attendance:punch')
  state(@Req() request: AuthenticatedRequest): Promise<PunchState> {
    return this.punches.state(request.session.employeeId);
  }
}
