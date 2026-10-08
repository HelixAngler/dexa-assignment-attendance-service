import { AppException } from './app.exception';

/** One calendar-day query parameter as it arrives on the query string. */
export type RawDateParam = string | string[] | undefined;

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True only for a `YYYY-MM-DD` string naming a day that exists. The round trip
 * through `Date.UTC` rejects impossible calendar days such as `2026-02-30`,
 * which the pattern alone would happily accept.
 */
export const isDateKey = (value: string): boolean => {
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
 * Reads one `date`-style parameter: absent (or empty) means "use the default",
 * a single well-formed calendar day is taken as given, and anything else — a
 * repeated parameter, a malformed string, an impossible date — is refused
 * rather than guessed at.
 */
export const readDateKey = (
  raw: RawDateParam,
  fallback: string
): string => {
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
