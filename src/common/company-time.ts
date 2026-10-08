/**
 * The one fixed zone the company's calendar is measured in. Every day boundary
 * in this service — the work date stamped onto a punch and the sweep that
 * closes yesterday's sessions — is derived from here, so the host's own zone
 * setting never changes what counts as "today".
 */
export const COMPANY_TIME_ZONE = 'Asia/Jakarta';

const DATE_PART_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: COMPANY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const valueOf = (parts: Intl.DateTimeFormatPart[], type: string): string =>
  parts.find((piece) => piece.type === type)?.value ?? '';

/**
 * The company calendar day a moment falls on, as `YYYY-MM-DD`.
 *
 * The fields are read individually instead of trusting a locale's string
 * layout, so the shape of the result cannot drift with ICU data.
 */
export const companyDateKey = (date: Date = new Date()): string => {
  const parts = DATE_PART_FORMAT.formatToParts(date);
  return `${valueOf(parts, 'year')}-${valueOf(parts, 'month')}-${valueOf(
    parts,
    'day'
  )}`;
};

/**
 * The value stored in the date column for a punch thrown at `date`: midnight
 * of that moment's company day, held as UTC midnight of the same calendar date
 * so a round trip through the database returns the identical calendar day.
 */
export const companyWorkDate = (date: Date = new Date()): Date =>
  new Date(`${companyDateKey(date)}T00:00:00.000Z`);
