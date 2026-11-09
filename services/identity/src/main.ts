import { z } from 'zod';
import {
  AuditWriter,
  InMemoryAuditStore,
  PostgresAuditStore,
  type AuditDatabase,
  type AuditStore,
} from '@endo/audit';
import { Environment, isDeployedEnvironment, loadConfig } from '@endo/config';
import { DevKeyManager, FieldCipher, InMemoryPatientKeyStore } from '@endo/crypto';
import { createDb, createPool } from '@endo/db';
import type { IdentityDatabase } from '@endo/identity-store';
import { WorkloadTokenVerifier, type TrustedWorkload } from '@endo/service-kit';
import { buildIdentity } from './app.ts';
import { InMemoryPersonStore, PostgresPersonStore, type PersonStore } from './persons.ts';

const Jwk = z.string().transform((s, ctx) => {
  try {
    return z
      .object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string() })
      .parse(JSON.parse(s));
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid' });
    return z.NEVER;
  }
});

const Config = z.object({
  ENDO_ENV: Environment,
  ENDO_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  IDENTITY_PORT: z.coerce.number().int().min(1).max(65535),
  IDENTITY_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  // Identity vault as a member of endo_identity_app. Required in staging and production.
  IDENTITY_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  // Audit store (spec 2.6). Required in staging and production.
  IDENTITY_AUDIT_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  // Workload keys of the services allowed to call (ADR-0018); each gets fixed scopes below.
  IDENTITY_TRUSTED_API_PUBLIC_KEY_JWK: Jwk.optional(),
  IDENTITY_TRUSTED_JOBS_PUBLIC_KEY_JWK: Jwk.optional(),
});

async function main(): Promise<void> {
  const config = loadConfig(Config, process.env);
  const deployed = isDeployedEnvironment(config.ENDO_ENV);

  let auditStore: AuditStore;
  let closeAudit = (): Promise<void> => Promise.resolve();
  if (config.IDENTITY_AUDIT_DATABASE_URL) {
    const db = createDb<AuditDatabase>(
      createPool(config.IDENTITY_AUDIT_DATABASE_URL, { applicationName: 'endo-identity-audit' }),
    );
    auditStore = new PostgresAuditStore(db);
    closeAudit = () => db.destroy();
  } else if (deployed) {
    throw new Error('IDENTITY_AUDIT_DATABASE_URL is required in staging and production.');
  } else {
    auditStore = new InMemoryAuditStore();
  }

  // DevKeyManager refuses staging and production: deployed environments need the OpenBao
  // KeyManager (infra slice) before this service can start. Fail closed.
  const kms = new DevKeyManager(config.ENDO_ENV);
  let persons: PersonStore;
  let closeVault = (): Promise<void> => Promise.resolve();
  if (config.IDENTITY_DATABASE_URL) {
    const db = createDb<IdentityDatabase>(
      createPool(config.IDENTITY_DATABASE_URL, { applicationName: 'endo-identity' }),
    );
    persons = new PostgresPersonStore(db, kms);
    closeVault = () => db.destroy();
  } else if (deployed) {
    throw new Error('IDENTITY_DATABASE_URL is required in staging and production.');
  } else {
    persons = new InMemoryPersonStore(
      new FieldCipher(kms, new InMemoryPatientKeyStore(), 'kms/identity'),
    );
  }

  // Least privilege per caller: the API may create people; only the jobs service may erase.
  const trusted: Record<string, TrustedWorkload> = {};
  if (config.IDENTITY_TRUSTED_API_PUBLIC_KEY_JWK) {
    trusted['api'] = {
      publicJwk: config.IDENTITY_TRUSTED_API_PUBLIC_KEY_JWK,
      scopes: ['identity.person.create'],
    };
  }
  if (config.IDENTITY_TRUSTED_JOBS_PUBLIC_KEY_JWK) {
    trusted['jobs'] = {
      publicJwk: config.IDENTITY_TRUSTED_JOBS_PUBLIC_KEY_JWK,
      scopes: ['identity.person.erase'],
    };
  }

  const app = await buildIdentity({
    logLevel: config.ENDO_LOG_LEVEL,
    verifier: new WorkloadTokenVerifier('identity', trusted),
    audit: new AuditWriter(auditStore),
    persons,
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close().then(closeVault).then(closeAudit));
  }
  await app.listen({ host: config.IDENTITY_HOST, port: config.IDENTITY_PORT });
}

main().catch((error: unknown) => {
  // Only the error class name: messages can carry configuration details.
  process.stderr.write(
    `identity failed to start: ${error instanceof Error ? error.name : 'unknown'}\n`,
  );
  if (error instanceof Error && error.name === 'ConfigError') {
    process.stderr.write(`${error.message}\n`);
  }
  process.exit(1);
});
