import {
  RedisSessionStore,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SessionRedisClient,
} from '../src/common/auth/session.reader';

const TOKEN = 'tok-abc';
const KEY = `sess:${TOKEN}`;
const NOW = 1_760_000_000_000;

class FakeRedis implements SessionRedisClient {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  readonly deleted: string[] = [];
  readonly sets: Array<{ key: string; value: string; time: number }> = [];

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    expiryMode: 'PX',
    time: number
  ): Promise<unknown> {
    expect(expiryMode).toBe('PX');
    this.values.set(key, value);
    this.ttls.set(key, time);
    this.sets.push({ key, value, time });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.deleted.push(key);
    return this.values.delete(key) ? 1 : 0;
  }
}

const storedSession = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    employeeId: 'emp-1',
    role: 'employee',
    mustChangePassword: false,
    lastSeen: NOW - 60_000,
    issuedAt: NOW - 60_000,
    ...overrides,
  });

const store = (
  redis: FakeRedis,
  now: number = NOW
): RedisSessionStore => new RedisSessionStore(redis, () => now);

describe('RedisSessionStore', () => {
  it('returns null for an empty token without touching Redis', async () => {
    const redis = new FakeRedis();

    await expect(store(redis).read('')).resolves.toBeNull();
    expect(redis.sets).toHaveLength(0);
    expect(redis.deleted).toHaveLength(0);
  });

  it('returns null when the key does not exist', async () => {
    const redis = new FakeRedis();

    await expect(store(redis).read(TOKEN)).resolves.toBeNull();
    expect(redis.deleted).toHaveLength(0);
    expect(redis.sets).toHaveLength(0);
  });

  it('refreshes lastSeen and slides the idle TTL to the 30-minute cap', async () => {
    const redis = new FakeRedis();
    redis.values.set(KEY, storedSession());

    const result = await store(redis).read(TOKEN);

    expect(result).toEqual({
      employeeId: 'emp-1',
      role: 'employee',
      mustChangePassword: false,
      lastSeen: NOW,
      issuedAt: NOW - 60_000,
    });
    expect(redis.sets).toHaveLength(1);
    expect(redis.sets[0].key).toBe(KEY);
    expect(redis.ttls.get(KEY)).toBe(SESSION_IDLE_MS);

    const rewritten = JSON.parse(redis.values.get(KEY) as string);
    expect(rewritten.lastSeen).toBe(NOW);
    expect(rewritten.issuedAt).toBe(NOW - 60_000);
  });

  it('caps the TTL by the remaining absolute lifetime near the 12-hour ceiling', async () => {
    const redis = new FakeRedis();
    const issuedAt = NOW - (SESSION_ABSOLUTE_MS - 10 * 60 * 1000);
    redis.values.set(KEY, storedSession({ issuedAt, lastSeen: issuedAt }));

    await store(redis).read(TOKEN);

    expect(redis.ttls.get(KEY)).toBe(10 * 60 * 1000);
  });

  it('uses the idle window when it is tighter than the absolute lifetime', async () => {
    const redis = new FakeRedis();
    const issuedAt = NOW - 2 * 60 * 60 * 1000;
    redis.values.set(KEY, storedSession({ issuedAt, lastSeen: issuedAt }));

    await store(redis).read(TOKEN);

    expect(redis.ttls.get(KEY)).toBe(SESSION_IDLE_MS);
  });

  it('deletes and rejects a session exactly at the absolute lifetime', async () => {
    const redis = new FakeRedis();
    const issuedAt = NOW - SESSION_ABSOLUTE_MS;
    redis.values.set(KEY, storedSession({ issuedAt, lastSeen: issuedAt }));

    await expect(store(redis).read(TOKEN)).resolves.toBeNull();
    expect(redis.deleted).toEqual([KEY]);
    expect(redis.values.has(KEY)).toBe(false);
    expect(redis.sets).toHaveLength(0);
  });

  it('deletes and rejects a session past the absolute lifetime', async () => {
    const redis = new FakeRedis();
    const issuedAt = NOW - SESSION_ABSOLUTE_MS - 1;
    redis.values.set(KEY, storedSession({ issuedAt, lastSeen: issuedAt }));

    await expect(store(redis).read(TOKEN)).resolves.toBeNull();
    expect(redis.deleted).toEqual([KEY]);
  });

  it('deletes and rejects an unparseable payload', async () => {
    const redis = new FakeRedis();
    redis.values.set(KEY, 'not-json{');

    await expect(store(redis).read(TOKEN)).resolves.toBeNull();
    expect(redis.deleted).toEqual([KEY]);
  });

  it('deletes and rejects a payload without an employee id', async () => {
    const redis = new FakeRedis();
    redis.values.set(KEY, storedSession({ employeeId: '' }));

    await expect(store(redis).read(TOKEN)).resolves.toBeNull();
    expect(redis.deleted).toEqual([KEY]);
  });

  it('deletes and rejects a payload with an unknown role', async () => {
    const redis = new FakeRedis();
    redis.values.set(KEY, storedSession({ role: 'admin' }));

    await expect(store(redis).read(TOKEN)).resolves.toBeNull();
    expect(redis.deleted).toEqual([KEY]);
  });

  it('deletes and rejects a payload with a non-numeric issuedAt', async () => {
    const redis = new FakeRedis();
    redis.values.set(KEY, storedSession({ issuedAt: 'yesterday' }));

    await expect(store(redis).read(TOKEN)).resolves.toBeNull();
    expect(redis.deleted).toEqual([KEY]);
  });

  it('keeps hrd role and mustChangePassword intact', async () => {
    const redis = new FakeRedis();
    redis.values.set(
      KEY,
      storedSession({ role: 'hrd', mustChangePassword: true })
    );

    await expect(store(redis).read(TOKEN)).resolves.toMatchObject({
      role: 'hrd',
      mustChangePassword: true,
      lastSeen: NOW,
    });
  });

  it('accepts a payload whose lastSeen is missing and rewrites it from the clock', async () => {
    const redis = new FakeRedis();
    const payload = JSON.parse(storedSession()) as Record<string, unknown>;
    delete payload.lastSeen;
    redis.values.set(KEY, JSON.stringify(payload));

    const result = await store(redis).read(TOKEN);

    expect(result).toMatchObject({ lastSeen: NOW });
    const rewritten = JSON.parse(redis.values.get(KEY) as string);
    expect(rewritten.lastSeen).toBe(NOW);
  });

  it('tolerates a clock skewed into the future without shortening the idle window', async () => {
    const redis = new FakeRedis();
    redis.values.set(KEY, storedSession({ issuedAt: NOW + 60_000 }));

    await expect(store(redis).read(TOKEN)).resolves.toMatchObject({
      lastSeen: NOW,
    });
    expect(redis.ttls.get(KEY)).toBe(SESSION_IDLE_MS);
  });
});
