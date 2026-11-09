import { createRemoteJWKSet } from 'jose';
import { z } from 'zod';
import { Environment, isDeployedEnvironment, loadConfig } from '@endo/config';
import { WorkloadTokenSigner } from '@endo/service-kit';
import { buildClinicBff } from './app.ts';
import { TransactionStore } from './oidc.ts';
import { HttpResolver } from './resolve.ts';
import { InMemoryClinicSessions } from './sessions.ts';

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
  BFF_CLINIC_IDENTITY_BASE_URL: HttpUrl,
  BFF_CLINIC_API_BASE_URL: HttpUrl,
  // Its own workload key (ADR-0018); never shared with the service-token key.
  BFF_CLINIC_WORKLOAD_PRIVATE_KEY_JWK: PrivateJwk,
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
    },
    // Key refreshes are rate-limited (cooldown) and time-boxed (ADR-0019 section 2).
    keys: createRemoteJWKSet(new URL(config.BFF_CLINIC_OIDC_JWKS_URI), {
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    }),
    transactions: new TransactionStore(),
    sessions: new InMemoryClinicSessions(config.ENDO_ENV),
    resolver: new HttpResolver({
      identityBaseUrl: config.BFF_CLINIC_IDENTITY_BASE_URL,
      apiBaseUrl: config.BFF_CLINIC_API_BASE_URL,
      signer: new WorkloadTokenSigner(config.BFF_CLINIC_WORKLOAD_PRIVATE_KEY_JWK, 'bff-clinic'),
      fetch,
    }),
    fetch,
    now: () => new Date(),
    portalOrigin: config.BFF_CLINIC_PORTAL_ORIGIN,
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
