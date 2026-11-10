import { z } from 'zod';
import {
  AuditEventInput,
  AuditWriter,
  InMemoryAuditStore,
  PostgresAuditStore,
  type AuditDatabase,
  type AuditStore,
} from '@endo/audit';
import { Environment, isDeployedEnvironment, loadConfig } from '@endo/config';
import { DevKeyManager, FieldCipher, InMemoryPatientKeyStore } from '@endo/crypto';
import {
  PermanentPublishError,
  createDb,
  createPool,
  outboxAlert,
  outboxHealth,
  relayAuditOutbox,
} from '@endo/db';
import type { IdentityDatabase } from '@endo/identity-store';
import {
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  type TrustedWorkload,
} from '@endo/service-kit';
import { buildIdentity } from './app.ts';
import { InMemoryPersonStore, PostgresPersonStore, type PersonStore } from './persons.ts';
import { HttpClinicalClient } from './enrolment/clinical.ts';
import { EnrolmentCodes } from './enrolment/code.ts';
import type { PatientRouteDeps } from './enrolment/routes.ts';
import { PostgresEnrolmentStore } from './enrolment/store.ts';

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

const PrivateJwk = z.string().transform((s, ctx) => {
  try {
    return z
      .object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string(), d: z.string() })
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
  IDENTITY_TRUSTED_BFF_CLINIC_PUBLIC_KEY_JWK: Jwk.optional(),
  // The one identity-provider issuer of this deployment (ADR-0019).
  IDENTITY_IDP_ISSUER: z.url({ protocol: /^https?$/ }),
  /** Relay role for the identity audit outbox (endo_identity_relay); required with the database. */
  IDENTITY_AUDIT_RELAY_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  /** Enrolment coordination (ADR-0021): the patient BFF calls in, this service calls the API. */
  IDENTITY_TRUSTED_BFF_PATIENT_PUBLIC_KEY_JWK: Jwk.optional(),
  IDENTITY_WORKLOAD_PRIVATE_KEY_JWK: PrivateJwk.optional(),
  IDENTITY_API_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
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
  let enrolment: PatientRouteDeps | undefined;
  let relayTimer: NodeJS.Timeout | undefined;
  let closeVault = (): Promise<void> => Promise.resolve();
  if (config.IDENTITY_DATABASE_URL) {
    const db = createDb<IdentityDatabase>(
      createPool(config.IDENTITY_DATABASE_URL, { applicationName: 'endo-identity' }),
    );
    persons = new PostgresPersonStore(db, kms);

    // Enrolment events are queued in the identity outbox; this relays them to the audit store
    // with the relay role, which alone may read and acknowledge them (ADR-0021 section 14).
    if (!config.IDENTITY_AUDIT_RELAY_DATABASE_URL) {
      throw new Error('IDENTITY_AUDIT_RELAY_DATABASE_URL is required with IDENTITY_DATABASE_URL.');
    }
    const relayDb = createDb<IdentityDatabase>(
      createPool(config.IDENTITY_AUDIT_RELAY_DATABASE_URL, {
        applicationName: 'endo-identity-relay',
        max: 2,
      }),
    );
    const writer = new AuditWriter(auditStore);
    const publish = (queued: unknown, occurredAt?: Date): Promise<void> => {
      const input: Record<string, unknown> = { ...(queued as Record<string, unknown>) };
      delete input['id'];
      // An event that fails the schema can never be published: only that counts an attempt.
      // A failing audit store is an outage, which the relay waits out (spec 2.6).
      const parsed = AuditEventInput.safeParse(input);
      if (!parsed.success) return Promise.reject(new PermanentPublishError());
      return writer.write(parsed.data, occurredAt).then(() => undefined);
    };
    relayTimer = setInterval(() => {
      relayAuditOutbox(relayDb, publish)
        // Counts only. Repeats every run while anything is set aside or the backlog is stale.
        .then(() => outboxHealth(relayDb))
        .then((h) => {
          const alert = outboxAlert('identity', h);
          if (alert) process.stderr.write(alert);
        })
        .catch(() => process.stderr.write('identity audit outbox relay failed\n'));
    }, 5_000);
    relayTimer.unref();

    if (
      config.IDENTITY_TRUSTED_BFF_PATIENT_PUBLIC_KEY_JWK &&
      config.IDENTITY_WORKLOAD_PRIVATE_KEY_JWK &&
      config.IDENTITY_API_BASE_URL
    ) {
      enrolment = {
        store: new PostgresEnrolmentStore(db),
        codes: new EnrolmentCodes(kms),
        clinical: new HttpClinicalClient({
          apiBaseUrl: config.IDENTITY_API_BASE_URL,
          signer: new WorkloadTokenSigner(config.IDENTITY_WORKLOAD_PRIVATE_KEY_JWK, 'identity'),
          fetch,
        }),
        now: () => new Date(),
      };
    }
    closeVault = async () => {
      clearInterval(relayTimer);
      await db.destroy();
      await relayDb.destroy();
    };
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

  if (config.IDENTITY_TRUSTED_BFF_PATIENT_PUBLIC_KEY_JWK) {
    trusted['bff-patient'] = {
      publicJwk: config.IDENTITY_TRUSTED_BFF_PATIENT_PUBLIC_KEY_JWK,
      scopes: ['identity.enrolment.patient'],
    };
  }
  if (config.IDENTITY_TRUSTED_BFF_CLINIC_PUBLIC_KEY_JWK) {
    trusted['bff-clinic'] = {
      publicJwk: config.IDENTITY_TRUSTED_BFF_CLINIC_PUBLIC_KEY_JWK,
      scopes: ['identity.subject.resolve'],
    };
  }

  const app = await buildIdentity({
    logLevel: config.ENDO_LOG_LEVEL,
    verifier: new WorkloadTokenVerifier('identity', trusted),
    audit: new AuditWriter(auditStore),
    persons,
    idpIssuer: config.IDENTITY_IDP_ISSUER,
    ...(enrolment ? { enrolment } : {}),
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
