import { z } from 'zod';
import { Environment, loadConfig } from '@endo/config';
import { uuidv7 } from '@endo/domain';
import { ServiceTokenSigner, WorkloadTokenSigner, isSecurityContact } from '@endo/service-kit';
import { createRemoteJWKSet } from 'jose';
import { TransactionStore } from '@endo/oidc';
import { buildBff } from './app.ts';
import { loadAppShell } from './app-shell.ts';
import { DevSessionStore, SESSION_COOKIE } from './sessions.ts';

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
  BFF_PATIENT_PORT: z.coerce.number().int().min(1).max(65535),
  // Loopback by default; containers set 0.0.0.0 and rely on NetworkPolicy (ADR-0016).
  BFF_PATIENT_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  BFF_PATIENT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  // REQ-007: the local emergency number on the urgent-care screen, per deployment (region).
  // Spec 15: the API's VAPID public key (uncompressed P-256, base64url), for push reminders.
  BFF_PATIENT_VAPID_PUBLIC_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{87}$/)
    .optional(),
  // Spec 12.7: where vulnerability reports go (mailto: or https:), and the disclosure policy.
  ENDO_SECURITY_CONTACT: z
    .string()
    .refine((v) => isSecurityContact(v))
    .optional(),
  ENDO_SECURITY_POLICY_URL: z.url({ protocol: /^https$/ }).optional(),
  BFF_PATIENT_EMERGENCY_NUMBER: z
    .string()
    .regex(/^\+?[0-9]{2,15}$/)
    .optional(),
  BFF_PATIENT_API_BASE_URL: z.url({ protocol: /^https?$/ }),
  BFF_PATIENT_SERVICE_TOKEN_PRIVATE_KEY_JWK: z.string().transform((s, ctx) => {
    try {
      return z
        .object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string(), d: z.string() })
        .parse(JSON.parse(s));
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid' });
      return z.NEVER;
    }
  }),
  BFF_PATIENT_DEV_SESSIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  /** Directory of the built patient app (apps/patient-web/dist), served from this origin. */
  BFF_PATIENT_APP_DIR: z.string().min(1).optional(),
  /** Patient enrolment (ADR-0021): all three, or none. */
  BFF_PATIENT_IDENTITY_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  BFF_PATIENT_WORKLOAD_PRIVATE_KEY_JWK: PrivateJwk.optional(),
  /** Exact origin of the patient app, e.g. https://app.example (no path, no trailing slash). */
  BFF_PATIENT_ORIGIN: z
    .url({ protocol: /^https?$/ })
    .refine((u) => new URL(u).origin === u, 'must be an origin')
    .optional(),
  /**
   * Keycloak for her first passkey (ADR-0021 section 5). All of these, or none. Endpoints come from
   * trusted configuration, never discovery at request time (ADR-0019).
   */
  BFF_PATIENT_OIDC_ISSUER: z.url({ protocol: /^https?$/ }).optional(),
  BFF_PATIENT_OIDC_AUTHORIZATION_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  BFF_PATIENT_OIDC_TOKEN_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  BFF_PATIENT_OIDC_JWKS_URI: z.url({ protocol: /^https?$/ }).optional(),
  BFF_PATIENT_OIDC_END_SESSION_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  BFF_PATIENT_OIDC_CLIENT_ID: z.string().min(1).default('bff-patient'),
  BFF_PATIENT_OIDC_CLIENT_SECRET: z.string().min(32).optional(),
});

async function main(): Promise<void> {
  const config = loadConfig(Config, process.env);

  // Real sessions (passkeys, M1) are not built yet. Until then only dev sessions exist, and those
  // are refused outside dev/test by DevSessionStore itself.
  if (config.BFF_PATIENT_DEV_SESSIONS_ENABLED !== 'true') {
    throw new Error('No session provider configured.');
  }
  const sessions = new DevSessionStore(config.ENDO_ENV);
  const devToken = sessions.create({
    sub: uuidv7(),
    role: 'patient',
    org_id: null,
    patient_id: uuidv7(),
  });

  const enrolmentSettings = [
    config.BFF_PATIENT_IDENTITY_BASE_URL,
    config.BFF_PATIENT_WORKLOAD_PRIVATE_KEY_JWK,
    config.BFF_PATIENT_ORIGIN,
  ];
  if (enrolmentSettings.some(Boolean) && !enrolmentSettings.every(Boolean)) {
    throw new Error(
      'Enrolment needs BFF_PATIENT_IDENTITY_BASE_URL, BFF_PATIENT_WORKLOAD_PRIVATE_KEY_JWK and BFF_PATIENT_ORIGIN together.',
    );
  }

  const oidc = [
    config.BFF_PATIENT_OIDC_ISSUER,
    config.BFF_PATIENT_OIDC_AUTHORIZATION_ENDPOINT,
    config.BFF_PATIENT_OIDC_TOKEN_ENDPOINT,
    config.BFF_PATIENT_OIDC_JWKS_URI,
    config.BFF_PATIENT_OIDC_END_SESSION_ENDPOINT,
    config.BFF_PATIENT_OIDC_CLIENT_SECRET,
  ];
  if (oidc.some(Boolean) && !oidc.every(Boolean))
    throw new Error('Set every BFF_PATIENT_OIDC_* setting, or none.');
  const handoff =
    config.BFF_PATIENT_OIDC_ISSUER &&
    config.BFF_PATIENT_OIDC_AUTHORIZATION_ENDPOINT &&
    config.BFF_PATIENT_OIDC_TOKEN_ENDPOINT &&
    config.BFF_PATIENT_OIDC_JWKS_URI &&
    config.BFF_PATIENT_OIDC_END_SESSION_ENDPOINT &&
    config.BFF_PATIENT_OIDC_CLIENT_SECRET &&
    config.BFF_PATIENT_ORIGIN
      ? {
          oidc: {
            issuer: config.BFF_PATIENT_OIDC_ISSUER,
            authorizationEndpoint: config.BFF_PATIENT_OIDC_AUTHORIZATION_ENDPOINT,
            tokenEndpoint: config.BFF_PATIENT_OIDC_TOKEN_ENDPOINT,
            clientId: config.BFF_PATIENT_OIDC_CLIENT_ID,
            clientSecret: config.BFF_PATIENT_OIDC_CLIENT_SECRET,
            redirectUri: `${config.BFF_PATIENT_ORIGIN}/auth/enrolment/callback`,
            // ADR-0021 section 12: the first passkey is a fresh authentication.
            requiredAcr: '1',
            endSessionEndpoint: config.BFF_PATIENT_OIDC_END_SESSION_ENDPOINT,
            postLogoutRedirectUri: `${config.BFF_PATIENT_ORIGIN}/`,
          },
          keys: createRemoteJWKSet(new URL(config.BFF_PATIENT_OIDC_JWKS_URI)),
          transactions: new TransactionStore(),
          sessions,
        }
      : undefined;

  const app = await buildBff({
    logLevel: config.ENDO_LOG_LEVEL,
    sessions,
    signer: new ServiceTokenSigner(config.BFF_PATIENT_SERVICE_TOKEN_PRIVATE_KEY_JWK, 'bff-patient'),
    apiBaseUrl: config.BFF_PATIENT_API_BASE_URL,
    fetch,
    rateLimitPerMinute: config.BFF_PATIENT_RATE_LIMIT_PER_MINUTE,
    emergencyNumber: config.BFF_PATIENT_EMERGENCY_NUMBER ?? null,
    securityContact: config.ENDO_SECURITY_CONTACT
      ? { contact: config.ENDO_SECURITY_CONTACT, policy: config.ENDO_SECURITY_POLICY_URL ?? null }
      : null,
    vapidPublicKey: config.BFF_PATIENT_VAPID_PUBLIC_KEY ?? null,
    ...(config.BFF_PATIENT_APP_DIR ? { appShell: loadAppShell(config.BFF_PATIENT_APP_DIR) } : {}),
    ...(config.BFF_PATIENT_IDENTITY_BASE_URL &&
    config.BFF_PATIENT_WORKLOAD_PRIVATE_KEY_JWK &&
    config.BFF_PATIENT_ORIGIN
      ? {
          enrolment: {
            identityBaseUrl: config.BFF_PATIENT_IDENTITY_BASE_URL,
            signer: new WorkloadTokenSigner(
              config.BFF_PATIENT_WORKLOAD_PRIVATE_KEY_JWK,
              'bff-patient',
            ),
            patientOrigin: config.BFF_PATIENT_ORIGIN,
            fetch,
            now: () => new Date(),
            ...(handoff ? { handoff } : {}),
          },
        }
      : {}),
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close());
  }
  await app.listen({ host: config.BFF_PATIENT_HOST, port: config.BFF_PATIENT_PORT });
  // Dev only: a synthetic patient session for manual testing. Written to stdout, never the logger.
  process.stdout.write(`[dev] synthetic patient session cookie: ${SESSION_COOKIE}=${devToken}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `bff-patient failed to start: ${error instanceof Error ? error.name : 'unknown'}\n`,
  );
  if (error instanceof Error && error.name === 'ConfigError')
    process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
