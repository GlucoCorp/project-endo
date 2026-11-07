import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  AuditWriter,
  InMemoryAuditStore,
  PostgresAuditStore,
  type AuditDatabase,
  type AuditStore,
} from '@endo/audit';
import {
  Environment,
  assertClinicalReleaseReady,
  isDeployedEnvironment,
  loadConfig,
} from '@endo/config';
import { createDb, createPool } from '@endo/db';
import { ServiceTokenVerifier } from '@endo/service-kit';
import { buildApi } from './app.ts';

const Config = z.object({
  ENDO_ENV: Environment,
  ENDO_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  ENDO_CLINICAL_RULESET_PATH: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65535),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(1200),
  // Durable audit store (spec 2.6, 11.1). Required in staging and production.
  API_AUDIT_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  API_SERVICE_TOKEN_PUBLIC_KEY_JWK: z.string().transform((s, ctx) => {
    try {
      return z
        .object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string() })
        .parse(JSON.parse(s));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid' });
      return z.NEVER;
    }
  }),
});

async function main(): Promise<void> {
  const config = loadConfig(Config, process.env);

  // Spec 7.3: no TODO_CLINICAL in staging or production.
  // The path comes from operator-controlled configuration, never from a request.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const rulesetText = await readFile(config.ENDO_CLINICAL_RULESET_PATH, 'utf8');
  assertClinicalReleaseReady(config.ENDO_ENV, rulesetText);

  // Spec 2.6: deployed environments must use the durable Postgres audit store. Fail closed.
  let auditStore: AuditStore;
  let closeAudit = (): Promise<void> => Promise.resolve();
  if (config.API_AUDIT_DATABASE_URL) {
    const pool = createPool(config.API_AUDIT_DATABASE_URL, { applicationName: 'endo-api-audit' });
    const db = createDb<AuditDatabase>(pool);
    auditStore = new PostgresAuditStore(db);
    closeAudit = () => db.destroy();
  } else if (isDeployedEnvironment(config.ENDO_ENV)) {
    throw new Error('API_AUDIT_DATABASE_URL is required in staging and production.');
  } else {
    auditStore = new InMemoryAuditStore();
  }

  const app = await buildApi({
    logLevel: config.ENDO_LOG_LEVEL,
    verifier: new ServiceTokenVerifier(config.API_SERVICE_TOKEN_PUBLIC_KEY_JWK, 'api', [
      'bff-patient',
    ]),
    audit: new AuditWriter(auditStore),
    now: () => new Date(),
    loadConsents: () => Promise.resolve(new Set()),
    rateLimitPerMinute: config.API_RATE_LIMIT_PER_MINUTE,
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close().then(closeAudit));
  }
  await app.listen({ host: '127.0.0.1', port: config.API_PORT });
}

main().catch((error: unknown) => {
  // Only the error class name: messages can carry configuration details.
  process.stderr.write(`api failed to start: ${error instanceof Error ? error.name : 'unknown'}\n`);
  // These two messages are built to be safe: variable names and marker counts only.
  if (error instanceof Error && ['ConfigError', 'ClinicalNotReadyError'].includes(error.name)) {
    process.stderr.write(`${error.message}\n`);
  }
  process.exit(1);
});
