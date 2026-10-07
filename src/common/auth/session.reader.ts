import { Provider } from '@nestjs/common';
import Redis from 'ioredis';

import { config } from '../../config';
import type { Role } from './permissions';

/** HttpOnly cookie that carries the opaque session token on every request. */
export const SESSION_COOKIE = 'sid';

/** Redis key template; the opaque token is appended verbatim. */
export const SESSION_KEY_PREFIX = 'sess:';

/** Sliding idle window: a session dies this long after the last activity. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/** Absolute cap: a session dies this long after it was issued, no matter what. */
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

/**
 * Payload stored as a JSON string at `sess:{token}`.
 * `issuedAt` and `lastSeen` are millisecond epoch timestamps from the writer's clock.
 */
export type SessionData = {
  employeeId: string;
  role: Role;
  mustChangePassword: boolean;
  lastSeen: number;
  issuedAt: number;
};

/** Read side of the shared session store. Returns null for absent/invalid/expired tokens. */
export interface SessionStore {
  read(token: string): Promise<SessionData | null>;
}

export const SESSION_STORE = 'SESSION_STORE';

/**
 * The slice of a Redis client this reader needs. Kept minimal so the reader can
 * be exercised against an in-memory fake without a running Redis.
 */
export interface SessionRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: 'PX', time: number): Promise<unknown>;
  del(key: string): Promise<number>;
}

/**
 * Shared session reader.
 *
 * Read contract (identical in every service that shares the store):
 * 1. `GET sess:{token}` — missing key means no session.
 * 2. If `now - issuedAt >= 12h` the session is past its absolute lifetime:
 *    the key is deleted and the read reports no session.
 * 3. Otherwise the payload is returned with `lastSeen` refreshed to `now`,
 *    rewritten to Redis with TTL `min(30min, 12h - age)` so the idle window
 *    slides forward while the 12h ceiling never moves.
 *
 * A payload that cannot be parsed, or that lacks the identity fields required
 * to authorize a request, is treated as no session and removed.
 */
export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly redis: SessionRedisClient,
    private readonly now: () => number = Date.now
  ) {}

  async read(token: string): Promise<SessionData | null> {
    if (!token) {
      return null;
    }

    const key = SESSION_KEY_PREFIX + token;
    const raw = await this.redis.get(key);
    if (raw === null) {
      return null;
    }

    const parsed = this.parse(raw);
    const now = this.now();
    const age = parsed === null ? Number.POSITIVE_INFINITY : now - parsed.issuedAt;

    if (parsed === null || age >= SESSION_ABSOLUTE_MS) {
      await this.redis.del(key);
      return null;
    }

    const refreshed: SessionData = { ...parsed, lastSeen: now };
    const ttlMs = Math.max(
      1,
      Math.min(SESSION_IDLE_MS, SESSION_ABSOLUTE_MS - age)
    );
    await this.redis.set(key, JSON.stringify(refreshed), 'PX', ttlMs);
    return refreshed;
  }

  private parse(raw: string): SessionData | null {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof value !== 'object' || value === null) {
      return null;
    }

    const candidate = value as Partial<SessionData>;
    if (
      typeof candidate.employeeId !== 'string' ||
      candidate.employeeId === '' ||
      (candidate.role !== 'employee' && candidate.role !== 'hrd') ||
      typeof candidate.issuedAt !== 'number' ||
      !Number.isFinite(candidate.issuedAt)
    ) {
      return null;
    }

    const lastSeen =
      typeof candidate.lastSeen === 'number' && Number.isFinite(candidate.lastSeen)
        ? candidate.lastSeen
        : candidate.issuedAt;

    return {
      employeeId: candidate.employeeId,
      role: candidate.role,
      mustChangePassword: candidate.mustChangePassword === true,
      lastSeen,
      issuedAt: candidate.issuedAt,
    };
  }
}

class IoredisSessionClient implements SessionRedisClient {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  set(key: string, value: string, expiryMode: 'PX', time: number): Promise<unknown> {
    return this.redis.set(key, value, expiryMode, time);
  }

  del(key: string): Promise<number> {
    return this.redis.del(key);
  }
}

/**
 * Builds the shared store. The connection is lazy (the first command dials
 * Redis) so constructing the store never blocks or fails application startup.
 */
export const createSessionStore = (
  redisUrl: string = config.redisUrl,
  now: () => number = Date.now
): SessionStore => {
  const client = new Redis(redisUrl, { lazyConnect: true });
  client.on('error', (error: Error) => {
    // Keep the process alive when Redis is unreachable; reads then reject and
    // the caller sees an ordinary failure instead of an unhandled crash.
    console.error(`session store redis error: ${error.message}`);
  });
  return new RedisSessionStore(new IoredisSessionClient(client), now);
};

/** Provider for the `SESSION_STORE` token; wire it into the module that owns guarded routes. */
export const sessionStoreProvider: Provider = {
  provide: SESSION_STORE,
  useFactory: () => createSessionStore(),
};
