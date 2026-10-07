export type AppConfig = {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  nodeEnv: string;
};

export const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const str = (value: string | undefined, fallback: string): string => {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  return value;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => ({
  port: num(env.PORT, 3002),
  databaseUrl: str(env.DATABASE_URL, ''),
  redisUrl: str(env.REDIS_URL, 'redis://localhost:6379'),
  nodeEnv: str(env.NODE_ENV, 'development'),
});

export const config: AppConfig = loadConfig();
