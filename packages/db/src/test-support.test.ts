import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDatabaseUrl } from './index.ts';

describe('testDatabaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the configured URL', () => {
    vi.stubEnv('ENDO_TEST_DATABASE_URL', 'postgres://x');
    expect(testDatabaseUrl()).toBe('postgres://x');
  });

  it('allows skipping locally', () => {
    vi.stubEnv('ENDO_TEST_DATABASE_URL', '');
    vi.stubEnv('CI', '');
    expect(testDatabaseUrl()).toBeUndefined();
  });

  it('never allows skipping integration tests in CI', () => {
    vi.stubEnv('ENDO_TEST_DATABASE_URL', '');
    vi.stubEnv('CI', 'true');
    expect(() => testDatabaseUrl()).toThrow(/must be set in CI/);
  });
});
