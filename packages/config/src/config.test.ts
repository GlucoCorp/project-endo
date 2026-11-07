import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assertClinicalReleaseReady,
  ClinicalNotReadyError,
  ConfigError,
  isDeployedEnvironment,
  loadConfig,
  Environment,
} from './index.ts';

describe('loadConfig', () => {
  const schema = z.object({
    ENDO_ENV: Environment,
    API_PORT: z.coerce.number().int().min(1).max(65535),
    SECRET_THING: z.string().min(10),
  });

  it('parses valid configuration and ignores unrelated variables', () => {
    const config = loadConfig(schema, {
      ENDO_ENV: 'dev',
      API_PORT: '8080',
      SECRET_THING: 'abcdefghijkl',
      PATH: '/usr/bin',
    });
    expect(config).toEqual({ ENDO_ENV: 'dev', API_PORT: 8080, SECRET_THING: 'abcdefghijkl' });
  });

  it('fails closed and never echoes values in the error (spec 2.3, 12.5)', () => {
    const secretValue = 'short';
    let caught: unknown;
    try {
      loadConfig(schema, { ENDO_ENV: 'prod', API_PORT: 'x', SECRET_THING: secretValue });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const err = caught as ConfigError;
    expect(err.issues.map((i) => i.split(':')[0])).toEqual([
      'ENDO_ENV',
      'API_PORT',
      'SECRET_THING',
    ]);
    expect(err.message).not.toContain(secretValue);
    expect(err.message).not.toContain('prod');
  });
});

describe('isDeployedEnvironment', () => {
  it.each([
    ['dev', false],
    ['test', false],
    ['staging', true],
    ['production', true],
  ] as const)('%s -> %s', (env, expected) => {
    expect(isDeployedEnvironment(env)).toBe(expected);
  });
});

describe('REQ-004 RISK-C01 clinical release gate', () => {
  const unfinished = 'thresholds:\n  min_checkins: TODO_CLINICAL\n  adherence: TODO_CLINICAL\n';
  const finished = 'thresholds:\n  min_checkins: 8\n';

  it.each(['staging', 'production'] as const)(
    'refuses to start in %s with TODO_CLINICAL',
    (env) => {
      expect(() => {
        assertClinicalReleaseReady(env, unfinished);
      }).toThrow(ClinicalNotReadyError);
    },
  );

  it('reports the number of unfinished markers', () => {
    try {
      assertClinicalReleaseReady('production', unfinished);
      expect.unreachable();
    } catch (error) {
      expect((error as ClinicalNotReadyError).occurrences).toBe(2);
    }
  });

  it.each(['dev', 'test'] as const)('allows placeholders in %s', (env) => {
    expect(() => {
      assertClinicalReleaseReady(env, unfinished);
    }).not.toThrow();
  });

  it('allows a signed-off rule set in production', () => {
    expect(() => {
      assertClinicalReleaseReady('production', finished);
    }).not.toThrow();
  });

  it('blocks markers appearing in comments too', () => {
    expect(() => {
      assertClinicalReleaseReady('staging', 'x: 1 # TODO_CLINICAL confirm');
    }).toThrow(ClinicalNotReadyError);
  });
});
