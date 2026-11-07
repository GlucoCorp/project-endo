import { z } from 'zod';
import { Environment, loadConfig } from '@endo/config';
import { uuidv7 } from '@endo/domain';
import { ServiceTokenSigner } from '@endo/service-kit';
import { buildBff } from './app.ts';
import { DevSessionStore, SESSION_COOKIE } from './sessions.ts';

const Config = z.object({
  ENDO_ENV: Environment,
  ENDO_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  BFF_PATIENT_PORT: z.coerce.number().int().min(1).max(65535),
  BFF_PATIENT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
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

  const app = await buildBff({
    logLevel: config.ENDO_LOG_LEVEL,
    sessions,
    signer: new ServiceTokenSigner(config.BFF_PATIENT_SERVICE_TOKEN_PRIVATE_KEY_JWK, 'bff-patient'),
    apiBaseUrl: config.BFF_PATIENT_API_BASE_URL,
    fetch,
    rateLimitPerMinute: config.BFF_PATIENT_RATE_LIMIT_PER_MINUTE,
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close());
  }
  await app.listen({ host: '127.0.0.1', port: config.BFF_PATIENT_PORT });
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
