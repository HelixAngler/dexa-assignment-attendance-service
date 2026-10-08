import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';

import { isAppException } from './app.exception';

export type ErrorLanguage = 'id' | 'en';

export type LocalizedMessage = Record<ErrorLanguage, string>;

/**
 * Human messages for every machine code this service can emit. Both languages
 * are always present so a response is never half-translated: the request's
 * `Accept-Language` picks the dictionary, Indonesian when it is absent or
 * unrecognized.
 */
export const ERROR_MESSAGES: Record<string, LocalizedMessage> = {
  AUTH_REQUIRED: {
    id: 'Sesi Anda belum terautentikasi. Silakan masuk terlebih dahulu.',
    en: 'You are not signed in. Please sign in first.',
  },
  FORBIDDEN: {
    id: 'Anda tidak memiliki akses untuk melakukan aksi ini.',
    en: 'You do not have permission to perform this action.',
  },
  INTERNAL: {
    id: 'Terjadi kesalahan di server. Silakan coba lagi nanti.',
    en: 'Something went wrong on the server. Please try again later.',
  },
  AUTH_INVALID: {
    id: 'Email atau kata sandi salah.',
    en: 'Email or password is incorrect.',
  },
  AUTH_LOCKED: {
    id: 'Akun terkunci karena terlalu banyak percobaan gagal. Coba lagi nanti.',
    en: 'Account locked after too many failed attempts. Please try again later.',
  },
  PASSWORD_WEAK: {
    id: 'Kata sandi tidak memenuhi persyaratan keamanan.',
    en: 'Password does not meet the security requirements.',
  },
  PHONE_INVALID: {
    id: 'Nomor telepon tidak valid.',
    en: 'Phone number is invalid.',
  },
  PHOTO_TOO_LARGE: {
    id: 'Ukuran foto terlalu besar, maksimal 2 MB.',
    en: 'Photo is too large, maximum 2 MB.',
  },
  PHOTO_TYPE: {
    id: 'Format foto harus JPG atau PNG.',
    en: 'Photo must be a JPG or PNG file.',
  },
  EMAIL_TAKEN: {
    id: 'Email sudah terdaftar.',
    en: 'Email is already registered.',
  },
  SESSION_ALREADY_OPEN: {
    id: 'Anda sudah absen masuk dan sesi masih berbuka. Silakan absen pulang terlebih dahulu.',
    en: 'You already have an open attendance session. Please clock out first.',
  },
  NO_OPEN_SESSION: {
    id: 'Tidak ada sesi absensi yang terbuka. Silakan absen masuk terlebih dahulu.',
    en: 'There is no open attendance session. Please clock in first.',
  },
  IDEMPOTENCY_CONFLICT: {
    id: 'Permintaan dengan kunci idempotensi yang sama berisi data yang berbeda.',
    en: 'A request with the same idempotency key carried a different payload.',
  },
  MISSING_IDEMPOTENCY_KEY: {
    id: 'Header Idempotency-Key wajib diisi pada setiap permintaan absen.',
    en: 'The Idempotency-Key header is required on every punch request.',
  },
  IDEMPOTENCY_KEY_INVALID: {
    id: 'Header Idempotency-Key harus berupa UUID yang valid.',
    en: 'The Idempotency-Key header must be a valid UUID.',
  },
  DIRECTION_INVALID: {
    id: 'Arah absen harus bernilai masuk atau pulang.',
    en: 'Punch direction must be either masuk or pulang.',
  },
  RANGE_INVALID: {
    id: 'Rentang tanggal tidak valid. Tanggal mulai tidak boleh setelah tanggal akhir.',
    en: 'Invalid date range. The start date cannot be after the end date.',
  },
  NOT_FOUND: {
    id: 'Data yang diminta tidak ditemukan.',
    en: 'The requested data was not found.',
  },
  BAD_REQUEST: {
    id: 'Permintaan tidak valid.',
    en: 'The request is invalid.',
  },
  METHOD_NOT_ALLOWED: {
    id: 'Metode HTTP tersebut tidak diizinkan.',
    en: 'That HTTP method is not allowed.',
  },
  NOT_ACCEPTABLE: {
    id: 'Format respons yang diminta tidak tersedia.',
    en: 'The requested response format is not available.',
  },
  CONFLICT: {
    id: 'Permintaan bertentangan dengan kondisi data saat ini.',
    en: 'The request conflicts with the current data state.',
  },
  PAYLOAD_TOO_LARGE: {
    id: 'Ukuran permintaan terlalu besar.',
    en: 'The request payload is too large.',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    id: 'Tipe konten permintaan tidak didukung.',
    en: 'The request content type is not supported.',
  },
  UNPROCESSABLE: {
    id: 'Data permintaan tidak dapat diproses.',
    en: 'The request data cannot be processed.',
  },
  TOO_MANY_REQUESTS: {
    id: 'Terlalu banyak permintaan. Silakan coba lagi nanti.',
    en: 'Too many requests. Please try again later.',
  },
  NOT_IMPLEMENTED: {
    id: 'Fungsi ini belum tersedia.',
    en: 'This functionality is not available yet.',
  },
  BAD_GATEWAY: {
    id: 'Layanan sedang bermasalah. Silakan coba lagi nanti.',
    en: 'An upstream service failed. Please try again later.',
  },
  SERVICE_UNAVAILABLE: {
    id: 'Layanan sedang tidak tersedia. Silakan coba lagi nanti.',
    en: 'The service is temporarily unavailable. Please try again later.',
  },
  GATEWAY_TIMEOUT: {
    id: 'Layanan merespons terlalu lama. Silakan coba lagi.',
    en: 'The service took too long to respond. Please try again.',
  },
};

const STATUS_FALLBACK_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'AUTH_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL',
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

const GENERIC_MESSAGES: Record<ErrorLanguage, { client: string; server: string }> = {
  id: {
    client: 'Permintaan tidak dapat diproses.',
    server: 'Terjadi kesalahan di server. Silakan coba lagi nanti.',
  },
  en: {
    client: 'The request could not be processed.',
    server: 'Something went wrong on the server. Please try again later.',
  },
};

/**
 * Loose `Accept-Language` parse: only Indonesian and English are supported.
 * The first language tag wins (`en-GB,en;q=0.9` → `en`), `*` and anything
 * else — including a missing header — falls back to Indonesian, the default.
 */
export const resolveErrorLanguage = (
  acceptLanguage: string | string[] | undefined
): ErrorLanguage => {
  const header = Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage;
  if (!header) {
    return 'id';
  }
  const firstTag = header.split(',')[0].split(';')[0].trim().toLowerCase();
  if (firstTag.startsWith('en')) {
    return 'en';
  }
  return 'id';
};

const codeForStatus = (statusCode: number): string => {
  const known = STATUS_FALLBACK_CODES[statusCode];
  if (known !== undefined) {
    return known;
  }
  return statusCode >= 500 ? 'INTERNAL' : `HTTP_${statusCode}`;
};

const RESERVED_RESPONSE_FIELDS = new Set([
  'statusCode',
  'code',
  'message',
  'error',
]);

type NormalizedError = {
  statusCode: number;
  code: string;
  details?: Record<string, unknown>;
};

/** Minimal view of the HTTP response the filter needs. */
type ErrorResponder = {
  status(code: number): ErrorResponder;
  json(body: unknown): unknown;
};

/**
 * Maps anything thrown in the request path onto `{statusCode, code, details}`.
 * Unknown throwables collapse to 500 `INTERNAL` so their internals never
 * reach a client.
 */
const normalizeException = (exception: unknown): NormalizedError => {
  if (isAppException(exception)) {
    return {
      statusCode: exception.statusCode,
      code: exception.code,
      details: exception.details,
    };
  }

  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    const payload: unknown = exception.getResponse();
    if (typeof payload === 'object' && payload !== null) {
      const record = payload as Record<string, unknown>;
      const code =
        typeof record.code === 'string' && record.code !== ''
          ? record.code
          : codeForStatus(statusCode);
      const details: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (!RESERVED_RESPONSE_FIELDS.has(key)) {
          details[key] = value;
        }
      }
      return {
        statusCode,
        code,
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    }
    return { statusCode, code: codeForStatus(statusCode) };
  }

  return { statusCode: 500, code: 'INTERNAL' };
};

/**
 * Renders every failure as `{statusCode, code, message}` — never more, never
 * less (plus explicitly merged detail fields from `AppException`). `message`
 * is taken from the bilingual table above using `Accept-Language`; unhandled
 * throwables become a generic 500 `INTERNAL` with no leaked internals.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const { statusCode, code, details } = normalizeException(exception);
    const request = host
      .switchToHttp()
      .getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const language = resolveErrorLanguage(request?.headers?.['accept-language']);

    const localized = ERROR_MESSAGES[code]?.[language];
    const generic = statusCode >= 500 ? 'server' : 'client';
    const message = localized ?? GENERIC_MESSAGES[language][generic];

    if (statusCode >= 500) {
      console.error(
        `[http] ${statusCode} ${code}`,
        exception instanceof Error ? (exception.stack ?? exception.message) : exception
      );
    }

    const response = host
      .switchToHttp()
      .getResponse<ErrorResponder>();
    response.status(statusCode).json({
      ...(details ?? {}),
      statusCode,
      code,
      message,
    });
  }
}
