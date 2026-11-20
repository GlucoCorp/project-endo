import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  AuditEventInput,
  AuditWriter,
  InMemoryAuditStore,
  PostgresAuditStore,
  type AuditDatabase,
  type AuditReader,
  type AuditStore,
} from '@endo/audit';
import {
  Environment,
  assertClinicalReleaseReady,
  isDeployedEnvironment,
  loadClinicalContent,
  loadConfig,
} from '@endo/config';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  PostgresConsentStore,
  PostgresEpisodeStore,
  PostgresIdempotentInvitationStore,
  PostgresInvitationReservationStore,
  PostgresMembershipStore,
  PostgresPatientKeyStore,
  PostgresVerdictStore,
  PostgresReminderStore,
  PostgresReviewStore,
  PostgresShareLinkStore,
  PermanentPublishError,
  findLiveInvitation,
  outboxAlert,
  outboxHealth,
  relayAuditOutbox,
  type ClinicalDatabase,
  type ConsentStore,
  type EpisodeStore,
  type ReminderStore,
  type ReviewStore,
  type ShareLinkStore,
  PostgresDeletionStore,
  PostgresOrgAdminStore,
  PostgresStaffInvitationStore,
  PostgresReportingStore,
  PostgresIntegrationStore,
  PostgresEhrLinkStore,
  type IdempotentInvitationStore,
  type MembershipStore,
} from '@endo/clinical-store';
import { DevKeyManager, OpenBaoKeyManager, EnvelopeSealer, FieldCipher } from '@endo/crypto';
import { createDb, createPool } from '@endo/db';
import {
  ServiceTokenVerifier,
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
} from '@endo/service-kit';
import { uuidv7 } from '@endo/domain';
import { HttpIdentityEnrolment } from './identity-client.ts';
import { VerdictService, loadRuleset } from './verdicts.ts';
import { ReminderService } from './reminders.ts';
import { buildApi } from './app.ts';
import type { EnrolmentCoordination } from './routes/coordinator.ts';

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

const PublicJwk = z.string().transform((s, ctx) => {
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
  ENDO_CLINICAL_RULESET_PATH: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65535),
  // Loopback by default; containers set 0.0.0.0 and rely on NetworkPolicy (ADR-0016).
  API_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(1200),
  // Durable audit store (spec 2.6, 11.1). Required in staging and production.
  API_AUDIT_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  // Clinical store as a member of endo_clinical_app (ADR-0017). Required in staging and production.
  API_CLINICAL_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  // Audit outbox relay as a member of endo_clinical_relay: a separate credential, because the API
  // role may only add events (ADR-0017). Required whenever the clinical store is configured.
  API_AUDIT_RELAY_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  // Clinic BFF (ADR-0019): its service-token key (clinician and org_admin only) and, separately,
  // its workload key (membership lookup only). Both optional until the clinic BFF is deployed.
  API_BFF_CLINIC_SERVICE_PUBLIC_KEY_JWK: PublicJwk.optional(),
  API_BFF_CLINIC_WORKLOAD_PUBLIC_KEY_JWK: PublicJwk.optional(),
  /** The identity service's workload key: enrolment coordinator routes (ADR-0021 section 13). */
  API_IDENTITY_WORKLOAD_PUBLIC_KEY_JWK: PublicJwk.optional(),
  /** The integration service's workload key (M7): client resolution and FHIR reads only. */
  API_INTEGRATION_WORKLOAD_PUBLIC_KEY_JWK: PublicJwk.optional(),
  /** The patient BFF's workload key: a receiver's view of a share link (REQ-008), nothing else. */
  API_BFF_PATIENT_WORKLOAD_PUBLIC_KEY_JWK: PublicJwk.optional(),
  /** The API's own workload key and the identity service's URL: clinic confirm (ADR-0021). */
  API_WORKLOAD_PRIVATE_KEY_JWK: PrivateJwk.optional(),
  API_IDENTITY_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  // Spec 15: Web Push reminders. A P-256 private JWK for VAPID, and the operator contact sent to
  // push services (an https URL or mailto of the organisation, never a person). Without both, no
  // reminder is sent.
  API_VAPID_PRIVATE_KEY_JWK: z
    .string()
    .transform((s, ctx) => {
      try {
        return z
          .object({
            kty: z.literal('EC'),
            crv: z.literal('P-256'),
            x: z.string(),
            y: z.string(),
            d: z.string(),
          })
          .parse(JSON.parse(s));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'invalid' });
        return z.NEVER;
      }
    })
    .optional(),
  API_VAPID_SUBJECT: z
    .string()
    .regex(/^(https:\/\/|mailto:)[^\s]{3,200}$/)
    .optional(),
  // Spec 18.5: public keys that may sign the rule set, as {"key-id": <Ed25519 public JWK>}.
  // Required in staging and production (the rule set must verify before the API starts).
  ENDO_RULESET_PUBLIC_KEYS: z
    .string()
    .transform((s, ctx) => {
      try {
        const parsed = z
          .record(
            z.string().regex(/^[a-z0-9-]{1,64}$/),
            z.object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string() }),
          )
          .parse(JSON.parse(s));
        return new Map(Object.entries(parsed));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'invalid' });
        return z.NEVER;
      }
    })
    .optional(),
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
  // Spec 18.5: the signature beside it (`<rule set>.sig.json`) must verify with a pinned key;
  // deployed environments refuse to start without one.
  // Same operator-controlled path as the rule set, never from a request.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const signatureText = await readFile(
    `${config.ENDO_CLINICAL_RULESET_PATH}.sig.json`,
    'utf8',
  ).catch(() => null);
  const ruleset = loadRuleset(
    rulesetText,
    signatureText,
    config.ENDO_RULESET_PUBLIC_KEYS ?? new Map(),
    isDeployedEnvironment(config.ENDO_ENV),
  );
  // The instrument, catalogue and goals sit beside the rule set in clinical/ (ADR-0027). Any
  // TODO_CLINICAL refuses startup in staging and production; development uses placeholders.
  const clinicalDir = join(dirname(config.ENDO_CLINICAL_RULESET_PATH), '..');
  const readClinical = (p: string) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFile(join(clinicalDir, p), 'utf8');
  const content = loadClinicalContent(config.ENDO_ENV, {
    instrument: await readClinical('instrument/checkin.v1.json'),
    treatments: await readClinical('treatments/catalogue.v1.json'),
    goals: await readClinical('goals/templates.v1.json'),
  });
  // DevKeyManager refuses staging and production: deployed environments need the OpenBao
  // KeyManager (infra slice) before the API can start. Fail closed.
  const kms =
    config.ENDO_KMS_OPENBAO_ADDR && config.ENDO_KMS_OPENBAO_TOKEN_FILE
      ? new OpenBaoKeyManager({
          address: config.ENDO_KMS_OPENBAO_ADDR,
          environment: config.ENDO_ENV,
          token: config.ENDO_KMS_OPENBAO_TOKEN_FILE,
          ...(config.ENDO_KMS_OPENBAO_MOUNT ? { mount: config.ENDO_KMS_OPENBAO_MOUNT } : {}),
        })
      : new DevKeyManager(config.ENDO_ENV);

  // Spec 2.6: deployed environments must use the durable Postgres audit store. Fail closed.
  let auditStore: AuditStore & AuditReader;
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
  let consents: ConsentStore;
  let episodes: { store: EpisodeStore; cipherFor: (orgId: string) => FieldCipher } | undefined;
  let verdicts: VerdictService | undefined;
  let links: ShareLinkStore | undefined;
  let deletions: PostgresDeletionStore | undefined;
  let orgAdmin: PostgresOrgAdminStore | undefined;
  let staffInvitations: PostgresStaffInvitationStore | undefined;
  let reporting: PostgresReportingStore | undefined;
  let integrations: PostgresIntegrationStore | undefined;
  let ehrLinks: PostgresEhrLinkStore | undefined;
  let reviews:
    | { reviews: ReviewStore; episodes: EpisodeStore; cipherFor: (orgId: string) => FieldCipher }
    | undefined;
  let reminders: { store: ReminderStore; cipherFor: (orgId: string) => FieldCipher } | undefined;
  let coordination: EnrolmentCoordination | undefined;
  let relayOutbox: () => Promise<void>;
  const auditWriter = new AuditWriter(auditStore);
  // Queued events carry their outbox id; the audit store assigns its own.
  const publish = (queued: unknown, occurredAt?: Date): Promise<void> => {
    const input: Record<string, unknown> = { ...(queued as Record<string, unknown>) };
    delete input['id'];
    // An event that fails the schema can never be published: only that counts an attempt.
    // A failing audit store is an outage, which the relay waits out (spec 2.6).
    const parsed = AuditEventInput.safeParse(input);
    if (!parsed.success) return Promise.reject(new PermanentPublishError());
    return auditWriter.write(parsed.data, occurredAt).then(() => undefined);
  };
  let closeClinical = (): Promise<void> => Promise.resolve();
  if (config.API_CLINICAL_DATABASE_URL) {
    const pool = createPool(config.API_CLINICAL_DATABASE_URL, {
      applicationName: 'endo-api-clinical',
    });
    const db = createDb<ClinicalDatabase>(pool);
    invitations = new PostgresIdempotentInvitationStore(db);
    memberships = new PostgresMembershipStore(db);
    consents = new PostgresConsentStore(db);
    verdicts = new VerdictService(new PostgresVerdictStore(db), ruleset, () => new Date());
    links = new PostgresShareLinkStore(db);
    deletions = new PostgresDeletionStore(db);
    orgAdmin = new PostgresOrgAdminStore(db);
    staffInvitations = new PostgresStaffInvitationStore(db);
    reporting = new PostgresReportingStore(db);
    integrations = new PostgresIntegrationStore(db);
    ehrLinks = new PostgresEhrLinkStore(db);
    reviews = {
      reviews: new PostgresReviewStore(db),
      episodes: new PostgresEpisodeStore(db),
      cipherFor: (orgId) => new FieldCipher(kms, new PostgresPatientKeyStore(db, orgId)),
    };
    reminders = {
      store: new PostgresReminderStore(db),
      cipherFor: (orgId) => new FieldCipher(kms, new PostgresPatientKeyStore(db, orgId)),
    };
    episodes = {
      store: new PostgresEpisodeStore(db),
      cipherFor: (orgId) => new FieldCipher(kms, new PostgresPatientKeyStore(db, orgId)),
    };
    const reservations = new PostgresInvitationReservationStore(db);
    coordination = {
      find: (tokenHash) => findLiveInvitation(db, tokenHash),
      state: (orgId, invitationId) => reservations.state(orgId, invitationId),
      reserve: (r) => reservations.reserve(r),
      release: (r) => reservations.release(r),
      revokeHeld: (r) => reservations.revokeHeld(r),
      claim: (r) => reservations.claim(r),
    };
    if (!config.API_AUDIT_RELAY_DATABASE_URL) {
      throw new Error('API_AUDIT_RELAY_DATABASE_URL is required with API_CLINICAL_DATABASE_URL.');
    }
    const relayDb = createDb<ClinicalDatabase>(
      createPool(config.API_AUDIT_RELAY_DATABASE_URL, {
        applicationName: 'endo-api-relay',
        max: 2,
      }),
    );
    relayOutbox = async () => {
      await relayAuditOutbox(relayDb, publish);
      // Counts only. Repeats every run while anything is set aside or the backlog is stale.
      const alert = outboxAlert('api', await outboxHealth(relayDb));
      if (alert) process.stderr.write(alert);
    };
    closeClinical = async () => {
      await db.destroy();
      await relayDb.destroy();
    };
  } else if (isDeployedEnvironment(config.ENDO_ENV)) {
    throw new Error('API_CLINICAL_DATABASE_URL is required in staging and production.');
  } else {
    const store = new InMemoryIdempotentInvitationStore();
    invitations = store;
    memberships = new InMemoryMembershipStore();
    consents = new InMemoryConsentStore();
    // Serialised; an event leaves the queue only once it is published.
    let running: Promise<void> = Promise.resolve();
    relayOutbox = () => {
      running = running.then(async () => {
        while (store.outbox.length > 0) {
          await publish(store.outbox[0]);
          store.outbox.shift();
        }
      });
      return running;
    };
  }

  const app = await buildApi({
    logLevel: config.ENDO_LOG_LEVEL,
    verifier: new ServiceTokenVerifier('api', {
      'bff-patient': { publicJwk: config.API_SERVICE_TOKEN_PUBLIC_KEY_JWK, roles: ['patient'] },
      ...(config.API_BFF_CLINIC_SERVICE_PUBLIC_KEY_JWK
        ? {
            'bff-clinic': {
              publicJwk: config.API_BFF_CLINIC_SERVICE_PUBLIC_KEY_JWK,
              // Never glucorp_support: support access has its own path (spec 10.3).
              roles: ['clinician', 'org_admin'],
            },
          }
        : {}),
    }),
    workloadVerifier: new WorkloadTokenVerifier('api', {
      ...(config.API_BFF_CLINIC_WORKLOAD_PUBLIC_KEY_JWK
        ? {
            'bff-clinic': {
              publicJwk: config.API_BFF_CLINIC_WORKLOAD_PUBLIC_KEY_JWK,
              scopes: ['api.membership.resolve', 'api.staff.join'],
            },
          }
        : {}),
      ...(config.API_INTEGRATION_WORKLOAD_PUBLIC_KEY_JWK
        ? {
            integration: {
              publicJwk: config.API_INTEGRATION_WORKLOAD_PUBLIC_KEY_JWK,
              scopes: ['api.integration.resolve', 'api.fhir.read'],
            },
          }
        : {}),
      ...(config.API_IDENTITY_WORKLOAD_PUBLIC_KEY_JWK
        ? {
            identity: {
              publicJwk: config.API_IDENTITY_WORKLOAD_PUBLIC_KEY_JWK,
              scopes: ['api.enrolment.coordinate'],
            },
          }
        : {}),
      ...(config.API_BFF_PATIENT_WORKLOAD_PUBLIC_KEY_JWK
        ? {
            'bff-patient': {
              publicJwk: config.API_BFF_PATIENT_WORKLOAD_PUBLIC_KEY_JWK,
              scopes: ['api.share.view'],
            },
          }
        : {}),
    }),
    audit: auditWriter,
    invitations,
    memberships,
    sealer: new EnvelopeSealer(kms, 'kms/clinical'),
    relayOutbox,
    now: () => new Date(),
    consents,
    ...(coordination ? { coordination } : {}),
    ...(verdicts ? { verdicts } : {}),
    ...(reminders ? { reminders } : {}),
    ...(reviews
      ? { reviews: { ...reviews, content, deployed: isDeployedEnvironment(config.ENDO_ENV) } }
      : {}),
    ...(episodes
      ? {
          episodes: {
            episodes: episodes.store,
            content,
            cipherFor: episodes.cipherFor,
            deployed: isDeployedEnvironment(config.ENDO_ENV),
            ...(orgAdmin
              ? {
                  defaultIntervalWeeks: async (orgId: string) =>
                    (await orgAdmin.settings(orgId)).defaultReviewIntervalWeeks,
                }
              : {}),
          },
        }
      : {}),
    ...(reviews && links
      ? {
          history: {
            episodes: reviews.episodes,
            reviews: reviews.reviews,
            links,
            audit: auditStore,
            content,
            cipherFor: reviews.cipherFor,
          },
        }
      : {}),
    ...(orgAdmin && staffInvitations ? { orgAdmin: { orgAdmin, staffInvitations } } : {}),
    ...(reporting ? { dashboard: { reporting } } : {}),
    ...(ehrLinks ? { ehrLinks: { ehrLinks } } : {}),
    ...(integrations && reviews && links
      ? {
          integrations: {
            integrations,
            episodes: reviews.episodes,
            reviews: reviews.reviews,
            links,
            audit: auditStore,
            content,
            cipherFor: reviews.cipherFor,
          },
        }
      : {}),
    ...(reviews && links && deletions
      ? {
          dataRights: {
            episodes: reviews.episodes,
            reviews: reviews.reviews,
            links,
            deletions,
            audit: auditStore,
            content,
            cipherFor: reviews.cipherFor,
          },
        }
      : {}),
    ...(config.API_WORKLOAD_PRIVATE_KEY_JWK && config.API_IDENTITY_BASE_URL
      ? {
          identity: new HttpIdentityEnrolment({
            identityBaseUrl: config.API_IDENTITY_BASE_URL,
            signer: new WorkloadTokenSigner(config.API_WORKLOAD_PRIVATE_KEY_JWK, 'api'),
            fetch,
          }),
        }
      : {}),
    rateLimitPerMinute: config.API_RATE_LIMIT_PER_MINUTE,
  });

  // Periodic relay for events whose immediate relay failed or was interrupted.
  const relayTimer = setInterval(() => {
    relayOutbox().catch(() => process.stderr.write('audit outbox relay failed\n'));
  }, 5_000);
  relayTimer.unref();

  // Spec 15: reminders, hourly at the top of her chosen hour. Counts only in the logs.
  if (reminders && config.API_VAPID_PRIVATE_KEY_JWK && config.API_VAPID_SUBJECT) {
    const sender = new ReminderService(
      reminders.store,
      reminders.cipherFor,
      { privateJwk: config.API_VAPID_PRIVATE_KEY_JWK, subject: config.API_VAPID_SUBJECT },
      fetch,
      () => new Date(),
    );
    const reminderTimer = setInterval(() => {
      sender
        .run()
        .then((r) => {
          if (r.failed > 0) process.stderr.write(`reminders: ${String(r.failed)} not accepted\n`);
        })
        .catch(() => process.stderr.write('reminder run failed\n'));
    }, 3_600_000);
    reminderTimer.unref();
  }

  // REQ-004: the verdict schedule (shadow mode), hourly; each episode once per rule set version.
  if (verdicts) {
    const service = verdicts;
    const scheduleTimer = setInterval(() => {
      service
        .runSchedule(() => uuidv7())
        .then(() => relayOutbox())
        .catch(() => process.stderr.write('verdict schedule failed\n'));
    }, 3_600_000);
    scheduleTimer.unref();
  }

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
