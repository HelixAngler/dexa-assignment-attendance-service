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
import { SummaryResult, SummaryService } from './summary.service';

/** One bound as it may arrive on the query string. */
type RawBound = string | string[] | undefined;

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True only for a `YYYY-MM-DD` string naming a day that exists. The round trip
 * through `Date.UTC` rejects impossible calendar days such as `2026-02-30`,
 * which the pattern alone would happily accept.
 */
const isDateKey = (value: string): boolean => {
  const match = DATE_KEY_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
};

/**
 * Reads one range bound: absent (or empty) means "use the default", a single
 * well-formed calendar day is taken as given, and anything else — a repeated
 * bound, a malformed string, an impossible date — is refused rather than
 * guessed at.
 */
const readBound = (raw: RawBound, fallback: string): string => {
  if (raw === undefined) {
    return fallback;
  }
  if (Array.isArray(raw)) {
    throw new AppException(400, 'DATE_INVALID');
  }
  const value = raw.trim();
  if (value === '') {
    return fallback;
  }
  if (!isDateKey(value)) {
    throw new AppException(400, 'DATE_INVALID');
  }
  return value;
};

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
  const from = readBound(rawFrom, `${today.slice(0, 8)}01`);
  const to = readBound(rawTo, today);
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
