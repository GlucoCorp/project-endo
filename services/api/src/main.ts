import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  AuditEventInput,
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
import {
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  PostgresIdempotentInvitationStore,
  PostgresMembershipStore,
  relayAuditOutbox,
  type ClinicalDatabase,
  type IdempotentInvitationStore,
  type MembershipStore,
} from '@endo/clinical-store';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import { createDb, createPool } from '@endo/db';
import { ServiceTokenVerifier } from '@endo/service-kit';
import { buildApi } from './app.ts';

const Config = z.object({
  ENDO_ENV: Environment,
  ENDO_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  ENDO_CLINICAL_RULESET_PATH: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65535),
  // Loopback by default; containers set 0.0.0.0 and rely on NetworkPolicy (ADR-0016).
  API_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(1200),
  // Durable audit store (spec 2.6, 11.1). Required in staging and production.
  API_AUDIT_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  // Clinical store as a member of endo_clinical_app (ADR-0017). Required in staging and production.
  API_CLINICAL_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
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

  // Clinical store: same fail-closed rule as the audit store.
  let invitations: IdempotentInvitationStore;
  let memberships: MembershipStore;
  let relayOutbox: () => Promise<void>;
  const auditWriter = new AuditWriter(auditStore);
  // Queued events carry their outbox id; the audit store assigns its own.
  const publish = (queued: unknown): Promise<void> => {
    const input: Record<string, unknown> = { ...(queued as Record<string, unknown>) };
    delete input['id'];
    return auditWriter.write(AuditEventInput.parse(input)).then(() => undefined);
  };
  let closeClinical = (): Promise<void> => Promise.resolve();
  if (config.API_CLINICAL_DATABASE_URL) {
    const pool = createPool(config.API_CLINICAL_DATABASE_URL, {
      applicationName: 'endo-api-clinical',
    });
    const db = createDb<ClinicalDatabase>(pool);
    invitations = new PostgresIdempotentInvitationStore(db);
    memberships = new PostgresMembershipStore(db);
    relayOutbox = () => relayAuditOutbox(db, publish).then(() => undefined);
    closeClinical = async () => {
      await db.destroy();
    };
  } else if (isDeployedEnvironment(config.ENDO_ENV)) {
    throw new Error('API_CLINICAL_DATABASE_URL is required in staging and production.');
  } else {
    const store = new InMemoryIdempotentInvitationStore();
    invitations = store;
    memberships = new InMemoryMembershipStore();
    relayOutbox = async () => {
      for (const event of store.outbox.splice(0)) await publish(event);
    };
  }

  const app = await buildApi({
    logLevel: config.ENDO_LOG_LEVEL,
    verifier: new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: config.API_SERVICE_TOKEN_PUBLIC_KEY_JWK, roles: ['patient'] },
    }),
    audit: auditWriter,
    invitations,
    memberships,
    // DevKeyManager refuses staging and production: deployed environments need the OpenBao
    // KeyManager (infra slice) before the API can start. Fail closed.
    sealer: new EnvelopeSealer(new DevKeyManager(config.ENDO_ENV), 'kms/clinical'),
    relayOutbox,
    now: () => new Date(),
    loadConsents: () => Promise.resolve(new Set()),
    rateLimitPerMinute: config.API_RATE_LIMIT_PER_MINUTE,
  });

  // Periodic relay for events whose immediate relay failed or was interrupted.
  const relayTimer = setInterval(() => {
    relayOutbox().catch(() => process.stderr.write('audit outbox relay failed\n'));
  }, 5_000);
  relayTimer.unref();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close().then(closeAudit).then(closeClinical));
  }
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
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
