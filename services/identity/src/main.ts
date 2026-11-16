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
import {
  DevKeyManager,
  OpenBaoKeyManager,
  FieldCipher,
  InMemoryPatientKeyStore,
} from '@endo/crypto';
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
import { Activator } from './enrolment/activation.ts';
import { HttpKeycloakAdmin } from './enrolment/keycloak.ts';
import { Cleaner } from './enrolment/cleanup.ts';
import { EmailCodeStore } from './email/store.ts';
import type { EmailRouteDeps } from './email/routes.ts';
import { enrolmentAudit } from './enrolment/routes.ts';
import { uuidv7 } from '@endo/domain';

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
  // Spec 11.2: OpenBao Transit as the KMS. Without it the development stand-in is used, which
  // refuses staging and production (fail closed).
  ENDO_KMS_OPENBAO_ADDR: z.url({ protocol: /^https?$/ }).optional(),
  ENDO_KMS_OPENBAO_TOKEN_FILE: z.string().min(1).optional(),
  ENDO_KMS_OPENBAO_MOUNT: z
    .string()
    .regex(/^[a-z0-9_-]{1,64}$/)
    .optional(),
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
  /** The Keycloak extension's workload key: redeem and credential committed (ADR-0021). */
  IDENTITY_TRUSTED_KEYCLOAK_PUBLIC_KEY_JWK: Jwk.optional(),
  IDENTITY_WORKLOAD_PRIVATE_KEY_JWK: PrivateJwk.optional(),
  IDENTITY_API_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** The realm's base URL; activation's last step calls the extension's admin endpoint there. */
  IDENTITY_KEYCLOAK_REALM_URL: z.url({ protocol: /^https?$/ }).optional(),
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
  const kms =
    config.ENDO_KMS_OPENBAO_ADDR && config.ENDO_KMS_OPENBAO_TOKEN_FILE
      ? new OpenBaoKeyManager({
          address: config.ENDO_KMS_OPENBAO_ADDR,
          token: config.ENDO_KMS_OPENBAO_TOKEN_FILE,
          ...(config.ENDO_KMS_OPENBAO_MOUNT ? { mount: config.ENDO_KMS_OPENBAO_MOUNT } : {}),
        })
      : new DevKeyManager(config.ENDO_ENV);
  let persons: PersonStore;
  let enrolment: PatientRouteDeps | undefined;
  let onConsented: ((transactionId: string) => void) | undefined;
  let email: EmailRouteDeps | undefined;
  let relayTimer: NodeJS.Timeout | undefined;
  let closeVault = (): Promise<void> => Promise.resolve();
  if (config.IDENTITY_DATABASE_URL) {
    const db = createDb<IdentityDatabase>(
      createPool(config.IDENTITY_DATABASE_URL, { applicationName: 'endo-identity' }),
    );
    persons = new PostgresPersonStore(db, kms);
    // Email one-time codes (ADR-0026). Keycloak delivers them; confirming a new address needs
    // the extension's send endpoint, configured with the realm URL below.
    email = { store: new EmailCodeStore(db, kms), sender: null };

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
      const signer = new WorkloadTokenSigner(config.IDENTITY_WORKLOAD_PRIVATE_KEY_JWK, 'identity');
      enrolment = {
        store: new PostgresEnrolmentStore(db),
        codes: new EnrolmentCodes(kms),
        clinical: new HttpClinicalClient({
          apiBaseUrl: config.IDENTITY_API_BASE_URL,
          signer,
          fetch,
        }),
        now: () => new Date(),
      };
      // Activation (ADR-0021 section 10). Without the realm URL activation waits before step 3:
      // the account stays quarantined, never half-active.
      const keycloak = config.IDENTITY_KEYCLOAK_REALM_URL
        ? new HttpKeycloakAdmin({ realmUrl: config.IDENTITY_KEYCLOAK_REALM_URL, signer, fetch })
        : null;
      // ADR-0026: confirmation codes go out through Keycloak's sender too.
      if (keycloak) email = { store: new EmailCodeStore(db, kms), sender: keycloak };
      const activator = new Activator({
        store: enrolment.store,
        clinical: enrolment.clinical,
        keycloak,
        now: () => new Date(),
        audit: (action, tx) => enrolmentAudit(action, tx, uuidv7()),
      });
      onConsented = (id) => {
        activator.run(id).catch(() => process.stderr.write('enrolment activation failed\n'));
      };
      const activationTimer = setInterval(() => {
        activator.sweep().catch(() => process.stderr.write('enrolment activation sweep failed\n'));
      }, 30_000);
      activationTimer.unref();
      // Deadlines, cancellations and cleanup (sections 10 and 11). Counts only, never ids.
      const cleaner = new Cleaner({
        store: enrolment.store,
        clinical: enrolment.clinical,
        keycloak,
        now: () => new Date(),
        audit: (action, tx) => enrolmentAudit(action, tx, uuidv7()),
      });
      const cleanupTimer = setInterval(() => {
        cleaner
          .sweep()
          .then((waiting) => {
            if (waiting > 0) process.stderr.write(`enrolment cleanup waiting: ${waiting}\n`);
          })
          .catch(() => process.stderr.write('enrolment cleanup sweep failed\n'));
      }, 30_000);
      cleanupTimer.unref();
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
      scopes: ['identity.person.create', 'identity.enrolment.clinic'],
    };
  }
  if (config.IDENTITY_TRUSTED_JOBS_PUBLIC_KEY_JWK) {
    trusted['jobs'] = {
      publicJwk: config.IDENTITY_TRUSTED_JOBS_PUBLIC_KEY_JWK,
      scopes: ['identity.person.erase'],
    };
  }

  if (config.IDENTITY_TRUSTED_KEYCLOAK_PUBLIC_KEY_JWK) {
    trusted['keycloak'] = {
      publicJwk: config.IDENTITY_TRUSTED_KEYCLOAK_PUBLIC_KEY_JWK,
      scopes: ['identity.enrolment.keycloak', 'identity.email_code.keycloak'],
    };
  }
  if (config.IDENTITY_TRUSTED_BFF_PATIENT_PUBLIC_KEY_JWK) {
    trusted['bff-patient'] = {
      publicJwk: config.IDENTITY_TRUSTED_BFF_PATIENT_PUBLIC_KEY_JWK,
      scopes: ['identity.enrolment.patient', 'identity.patient.resolve', 'identity.email.patient'],
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
    ...(onConsented ? { onConsented } : {}),
    ...(email ? { email } : {}),
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
