import { createRemoteJWKSet } from 'jose';
import { z } from 'zod';
import { Environment, isDeployedEnvironment, loadConfig } from '@endo/config';
import { DevKeyManager, OpenBaoKeyManager, EnvelopeSealer } from '@endo/crypto';
import {
  ServiceTokenSigner,
  WorkloadTokenSigner,
  isSecurityContact,
  loadAppShell,
} from '@endo/service-kit';
import { buildClinicBff } from './app.ts';
import { SeenTokenIds, TransactionStore } from './oidc.ts';
import { HttpResolver } from './resolve.ts';
import { InMemoryClinicSessions, type ClinicSessionStore } from './sessions.ts';
import { PostgresClinicSessions } from './pg-sessions.ts';
import { SessionTable, type SessionDatabase } from '@endo/session-store';
import { createDb, createPool } from '@endo/db';

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
const HttpUrl = z.url({ protocol: /^https?$/ });

const Config = z.object({
  // ADR-0033: durable sessions (a member of endo_sessions_app). Without it the in-memory store is
  // used, which refuses staging and production.
  BFF_CLINIC_SESSION_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  // Spec 11.2: OpenBao Transit as the KMS. Without it the development stand-in is used, which
  // refuses staging and production (fail closed).
  ENDO_KMS_OPENBAO_ADDR: z.url({ protocol: /^https?$/ }).optional(),
  ENDO_KMS_OPENBAO_TOKEN_FILE: z.string().min(1).optional(),
  ENDO_KMS_OPENBAO_MOUNT: z
    .string()
    .regex(/^[a-z0-9_-]{1,64}$/)
    .optional(),
  // M7, spec 16.2: record systems allowed to launch the portal, as [{"iss": ..., "client_id": ...}].
  BFF_CLINIC_SMART_ISSUERS: z
    .string()
    .transform((s, ctx) => {
      try {
        return z
          .array(
            z.object({
              iss: z.url({ protocol: /^https?$/ }),
              client_id: z.string().min(1).max(256),
            }),
          )
          .max(20)
          .parse(JSON.parse(s))
          .map((i) => ({ iss: i.iss, clientId: i.client_id }));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'invalid' });
        return z.NEVER;
      }
    })
    .optional(),
  // Spec 12.7: where vulnerability reports go (mailto: or https:), and the disclosure policy.
  ENDO_SECURITY_CONTACT: z
    .string()
    .refine((v) => isSecurityContact(v))
    .optional(),
  ENDO_SECURITY_POLICY_URL: z.url({ protocol: /^https$/ }).optional(),
  ENDO_ENV: Environment,
  ENDO_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  BFF_CLINIC_PORT: z.coerce.number().int().min(1).max(65535),
  BFF_CLINIC_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  // Keycloak (ADR-0019 sections 1-3): every URL from configuration, never from a token.
  BFF_CLINIC_OIDC_ISSUER: HttpUrl,
  BFF_CLINIC_OIDC_AUTHORIZATION_ENDPOINT: HttpUrl,
  BFF_CLINIC_OIDC_TOKEN_ENDPOINT: HttpUrl,
  BFF_CLINIC_OIDC_JWKS_URI: HttpUrl,
  BFF_CLINIC_OIDC_CLIENT_ID: z.string().min(1).default('bff-clinician'),
  BFF_CLINIC_OIDC_CLIENT_SECRET: z.string().min(32),
  BFF_CLINIC_OIDC_REDIRECT_URI: HttpUrl,
  BFF_CLINIC_OIDC_REQUIRED_ACR: z.string().min(1).default('1'),
  BFF_CLINIC_OIDC_END_SESSION_ENDPOINT: HttpUrl,
  BFF_CLINIC_OIDC_POST_LOGOUT_REDIRECT_URI: HttpUrl,
  BFF_CLINIC_IDENTITY_BASE_URL: HttpUrl,
  BFF_CLINIC_API_BASE_URL: HttpUrl,
  // Its own workload key (ADR-0018); never shared with the service-token key.
  BFF_CLINIC_WORKLOAD_PRIVATE_KEY_JWK: PrivateJwk,
  // Its service-token key (ADR-0019): calls to the API on behalf of the signed-in clinician.
  BFF_CLINIC_SERVICE_TOKEN_PRIVATE_KEY_JWK: PrivateJwk.optional(),
  /** Directory of the built portal (apps/clinic-web/dist), served from this origin. */
  BFF_CLINIC_APP_DIR: z.string().min(1).optional(),
  // Exact portal origin; state-changing requests must carry it (ADR-0019 section 8).
  BFF_CLINIC_PORTAL_ORIGIN: z.url({ protocol: /^https?$/ }).refine((u) => new URL(u).origin === u),
});

async function main(): Promise<void> {
  const config = loadConfig(Config, process.env);
  if (isDeployedEnvironment(config.ENDO_ENV)) {
    // In-memory transactions and sessions are dev-only; the durable store with atomic expiry
    // across replicas is part of the infrastructure slice (ADR-0019 section 5). Fail closed.
    throw new Error('bff-clinic has no durable session store yet; refusing to start.');
  }

  let sessionTable: SessionTable | null = null;
  if (config.BFF_CLINIC_SESSION_DATABASE_URL) {
    sessionTable = new SessionTable(
      createDb<SessionDatabase>(
        createPool(config.BFF_CLINIC_SESSION_DATABASE_URL, {
          applicationName: 'endo-bff-clinic-sessions',
        }),
      ),
    );
    const table = sessionTable;
    // Expired rows are removed every 10 minutes (reads already refuse them).
    setInterval(() => {
      table.sweep().catch(() => process.stderr.write('session sweep failed\n'));
    }, 600_000).unref();
  }
  const sessions: ClinicSessionStore = sessionTable
    ? new PostgresClinicSessions(sessionTable)
    : new InMemoryClinicSessions(config.ENDO_ENV);

  const app = await buildClinicBff({
    logLevel: config.ENDO_LOG_LEVEL,
    oidc: {
      issuer: config.BFF_CLINIC_OIDC_ISSUER,
      authorizationEndpoint: config.BFF_CLINIC_OIDC_AUTHORIZATION_ENDPOINT,
      tokenEndpoint: config.BFF_CLINIC_OIDC_TOKEN_ENDPOINT,
      clientId: config.BFF_CLINIC_OIDC_CLIENT_ID,
      clientSecret: config.BFF_CLINIC_OIDC_CLIENT_SECRET,
      redirectUri: config.BFF_CLINIC_OIDC_REDIRECT_URI,
      requiredAcr: config.BFF_CLINIC_OIDC_REQUIRED_ACR,
      endSessionEndpoint: config.BFF_CLINIC_OIDC_END_SESSION_ENDPOINT,
      postLogoutRedirectUri: config.BFF_CLINIC_OIDC_POST_LOGOUT_REDIRECT_URI,
    },
    // Key refreshes are rate-limited (cooldown) and time-boxed (ADR-0019 section 2).
    keys: createRemoteJWKSet(new URL(config.BFF_CLINIC_OIDC_JWKS_URI), {
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    }),
    transactions: new TransactionStore(),
    logoutTokens: new SeenTokenIds(),
    // DevKeyManager refuses deployed environments; main already refuses them too (no durable store).
    sealer: new EnvelopeSealer(
      config.ENDO_KMS_OPENBAO_ADDR && config.ENDO_KMS_OPENBAO_TOKEN_FILE
        ? new OpenBaoKeyManager({
            address: config.ENDO_KMS_OPENBAO_ADDR,
            token: config.ENDO_KMS_OPENBAO_TOKEN_FILE,
            ...(config.ENDO_KMS_OPENBAO_MOUNT ? { mount: config.ENDO_KMS_OPENBAO_MOUNT } : {}),
          })
        : new DevKeyManager(config.ENDO_ENV),
      'kms/identity',
    ),
    sessions,
    resolver: new HttpResolver({
      identityBaseUrl: config.BFF_CLINIC_IDENTITY_BASE_URL,
      apiBaseUrl: config.BFF_CLINIC_API_BASE_URL,
      signer: new WorkloadTokenSigner(config.BFF_CLINIC_WORKLOAD_PRIVATE_KEY_JWK, 'bff-clinic'),
      fetch,
    }),
    fetch,
    now: () => new Date(),
    portalOrigin: config.BFF_CLINIC_PORTAL_ORIGIN,
    ...(config.BFF_CLINIC_SMART_ISSUERS ? { smartIssuers: config.BFF_CLINIC_SMART_ISSUERS } : {}),
    securityContact: config.ENDO_SECURITY_CONTACT
      ? { contact: config.ENDO_SECURITY_CONTACT, policy: config.ENDO_SECURITY_POLICY_URL ?? null }
      : null,
    ...(config.BFF_CLINIC_APP_DIR ? { appShell: loadAppShell(config.BFF_CLINIC_APP_DIR) } : {}),
    ...(config.BFF_CLINIC_SERVICE_TOKEN_PRIVATE_KEY_JWK
      ? {
          enrolment: {
            apiBaseUrl: config.BFF_CLINIC_API_BASE_URL,
            signer: new ServiceTokenSigner(
              config.BFF_CLINIC_SERVICE_TOKEN_PRIVATE_KEY_JWK,
              'bff-clinic',
            ),
            fetch,
            now: () => new Date(),
          },
        }
      : {}),
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close());
  }
  await app.listen({ host: config.BFF_CLINIC_HOST, port: config.BFF_CLINIC_PORT });
}

main().catch((error: unknown) => {
  // Only the error class name: messages can carry configuration details.
  process.stderr.write(
    `bff-clinic failed to start: ${error instanceof Error ? error.name : 'unknown'}\n`,
  );
  if (error instanceof Error && error.name === 'ConfigError') {
    process.stderr.write(`${error.message}\n`);
  }
  process.exit(1);
});
