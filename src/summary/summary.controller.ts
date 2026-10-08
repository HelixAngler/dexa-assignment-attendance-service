import {
  Controller,
  Get,
  HttpCode,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { AppException } from '../common/app.exception';
import { RequirePermission } from '../common/auth/decorators';
import {
  AuthenticatedRequest,
  SessionGuard,
} from '../common/auth/session.guard';
import { companyDateKey } from '../common/company-time';
import { RawDateParam, readDateKey } from '../common/date-key';
import { SummaryResult, SummaryService } from './summary.service';

/** One bound as it may arrive on the query string. */
type RawBound = RawDateParam;

/**
 * The range this request covers.
 *
 * With no query at all the window is the first day of the current company
 * month through today; each bound falls back independently, so supplying only
 * one still leaves the other at its default. The bounds are compared as plain
 * `YYYY-MM-DD` strings — zero-padded, so lexicographic order is calendar
 * order — and a start after the end is a contradiction, not a request.
 */
const resolveRange = (
  rawFrom: RawBound,
  rawTo: RawBound
): { from: string; to: string } => {
  const today = companyDateKey();
  const from = readDateKey(rawFrom, `${today.slice(0, 8)}01`);
  const to = readDateKey(rawTo, today);
  if (from > to) {
    throw new AppException(400, 'RANGE_INVALID');
  }
  return { from, to };
};

/**
 * Employee-facing summary endpoint.
 *
 * The route sits behind the session guard and the `summary:read_own`
 * permission, and every request is answered from the signed-in employee's own
 * sessions. No request input selects an employee: only the range is read, so
 * an id smuggled into the query string changes nothing about whose rows come
 * back.
 */
@Controller('summary')
@UseGuards(SessionGuard)
export class SummaryController {
  constructor(private readonly summary: SummaryService) {}

  @Get()
  @HttpCode(200)
  @RequirePermission('summary:read_own')
  rows(
    @Req() request: AuthenticatedRequest,
    @Query('from') rawFrom?: RawBound,
    @Query('to') rawTo?: RawBound
  ): Promise<SummaryResult> {
    const { from, to } = resolveRange(rawFrom, rawTo);
    return this.summary.rows(request.session.employeeId, from, to);
  }
}
