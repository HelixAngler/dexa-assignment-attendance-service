import {
  Controller,
  Get,
  HttpCode,
  Query,
  UseGuards,
} from '@nestjs/common';

import { AppException } from '../common/app.exception';
import { RequirePermission } from '../common/auth/decorators';
import { SessionGuard } from '../common/auth/session.guard';
import { companyDateKey } from '../common/company-time';
import { RawDateParam, readDateKey } from '../common/date-key';
import { AttendanceResult, AttendanceViewService } from './attendance-view.service';

/** One name search term as it may arrive on the query string. */
type RawNameQuery = string | string[] | undefined;

/**
 * Reads the name filter: absent, or present but blank, means "no filter" and
 * the whole list is returned. A term repeated on the query string carries no
 * single meaning, so it is refused rather than resolved by picking one of the
 * values.
 */
const readNameQuery = (raw: RawNameQuery): string | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  if (Array.isArray(raw)) {
    throw new AppException(400, 'BAD_REQUEST');
  }
  const value = raw.trim();
  return value === '' ? undefined : value;
};

/**
 * The HRD day view: one row per employee for a chosen date, read-only.
 *
 * Only `GET` is declared on this resource — there is no create, update or
 * delete handler to reach, so any other verb on the path is an unknown route
 * rather than an action somebody forgot to guard. The session guard runs
 * first and the `attendance:read_all` permission is checked against the
 * caller's current role, so an ordinary employee session is turned away with
 * 403 and a caller with no session at all with 401.
 *
 * The date defaults to today in the company's zone when it is not supplied,
 * and anything that is not one real calendar day is refused instead of being
 * guessed at. The name term only narrows the finished list — it never changes
 * who belongs on it.
 */
@Controller('attendance')
@UseGuards(SessionGuard)
export class AttendanceViewController {
  constructor(private readonly attendanceView: AttendanceViewService) {}

  @Get()
  @HttpCode(200)
  @RequirePermission('attendance:read_all')
  rows(
    @Query('date') rawDate?: RawDateParam,
    @Query('q') rawQuery?: RawNameQuery
  ): Promise<AttendanceResult> {
    const date = readDateKey(rawDate, companyDateKey());
    return this.attendanceView.rows(date, readNameQuery(rawQuery));
  }
}
