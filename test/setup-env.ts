/**
 * Environment defaults for the test run. Jest loads this module before any
 * test file is evaluated, so modules that read configuration at import time
 * already see these values.
 *
 * Existing values in the environment always win; only absent ones get a
 * fallback pointing at the local database and cache instances.
 */
process.env.DATABASE_URL_MAIN ??= 'postgres://wfh:wfh@localhost:5432/wfh_main';
process.env.REDIS_URL ??= 'redis://localhost:6379';
