import {
  ERROR_MESSAGES,
  resolveErrorLanguage,
} from '../src/common/http-exception.filter';

/**
 * Every machine code the HTTP contracts can return, plus the codes the guard
 * and the filter emit themselves. All of them must exist in both languages.
 */
const CONTRACT_CODES = [
  'SESSION_ALREADY_OPEN',
  'NO_OPEN_SESSION',
  'IDEMPOTENCY_CONFLICT',
  'MISSING_IDEMPOTENCY_KEY',
  'IDEMPOTENCY_KEY_INVALID',
  'DIRECTION_INVALID',
  'RANGE_INVALID',
  'AUTH_INVALID',
  'AUTH_LOCKED',
  'PASSWORD_WEAK',
  'PHONE_INVALID',
  'PHOTO_TOO_LARGE',
  'PHOTO_TYPE',
  'EMAIL_TAKEN',
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'INTERNAL',
];

describe('error message table', () => {
  it.each(CONTRACT_CODES)('defines %s in both Indonesian and English', (code) => {
    const entry = ERROR_MESSAGES[code];
    expect(entry).toBeDefined();
    expect(entry.id.trim().length).toBeGreaterThan(0);
    expect(entry.en.trim().length).toBeGreaterThan(0);
  });

  it('defines both languages for every entry, with no one-sided codes', () => {
    const incomplete = Object.entries(ERROR_MESSAGES)
      .filter(([, entry]) => {
        expect(typeof entry.id).toBe('string');
        expect(typeof entry.en).toBe('string');
        return !entry.id.trim() || !entry.en.trim();
      })
      .map(([code]) => code);
    expect(incomplete).toEqual([]);
  });

  it('never reuses the English text as the Indonesian text', () => {
    const untranslated = Object.entries(ERROR_MESSAGES)
      .filter(([, entry]) => entry.id === entry.en)
      .map(([code]) => code);
    expect(untranslated).toEqual([]);
  });

  it('has a message for every status-code fallback code', () => {
    const fallbackCodes = [
      'BAD_REQUEST',
      'NOT_FOUND',
      'METHOD_NOT_ALLOWED',
      'NOT_ACCEPTABLE',
      'CONFLICT',
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'UNPROCESSABLE',
      'TOO_MANY_REQUESTS',
      'NOT_IMPLEMENTED',
      'BAD_GATEWAY',
      'SERVICE_UNAVAILABLE',
      'GATEWAY_TIMEOUT',
    ];
    for (const code of fallbackCodes) {
      expect(ERROR_MESSAGES[code]).toBeDefined();
    }
  });
});

describe('resolveErrorLanguage', () => {
  it.each([
    [undefined, 'id'],
    ['', 'id'],
    ['*', 'id'],
    ['id', 'id'],
    ['id-ID,id;q=0.9', 'id'],
    ['fr-FR,fr;q=0.9', 'id'],
    ['de', 'id'],
    ['en', 'en'],
    ['EN', 'en'],
    ['en-GB,en;q=0.9', 'en'],
    ['id, en;q=0.5', 'id'],
    [' en;q=0.8 , id ', 'en'],
    ['en-US,en;q=0.9,id;q=0.8', 'en'],
  ])('parses %p as %p', (header, expected) => {
    expect(resolveErrorLanguage(header)).toBe(expected);
  });

  it('uses the first value when the header arrives as an array', () => {
    expect(resolveErrorLanguage(['en', 'id'])).toBe('en');
  });
});
