import { z } from 'zod';

/** Deployment environments (spec 17.1). `test` is for automated test runs only. */
export const Environment = z.enum(['dev', 'test', 'staging', 'production']);
export type EnvironmentName = z.infer<typeof Environment>;

/** Staging and production run with production-like controls; dev and test may use local stand-ins. */
export function isDeployedEnvironment(env: EnvironmentName): boolean {
  return env === 'staging' || env === 'production';
}

/**
 * Thrown when configuration is invalid. The message lists only the offending variable names and
 * the kind of problem, never the values, so secrets cannot leak into logs (spec 2.3, 12.5).
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Parse process environment variables against a Zod object schema.
 *
 * Unknown variables are ignored (the process environment always contains unrelated entries), but
 * every variable the schema names is validated. Fails closed: any problem throws `ConfigError`.
 */
export function loadConfig<S extends z.ZodObject>(
  schema: S,
  env: Readonly<Record<string, string | undefined>>,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => {
    const key = issue.path.map(String).join('.') || '(root)';
    return `${key}: ${issue.code}`;
  });
  throw new ConfigError(issues);
}
