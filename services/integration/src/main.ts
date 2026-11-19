import { z } from 'zod';
import { Environment, loadConfig } from '@endo/config';
import { WorkloadTokenSigner } from '@endo/service-kit';
import { HttpApi } from './api-client.ts';
import { buildIntegration } from './app.ts';

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
  INTEGRATION_PORT: z.coerce.number().int().min(1).max(65535),
  INTEGRATION_HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  /** The public base URL record systems use (https in deployed environments). */
  INTEGRATION_BASE_URL: z.url({ protocol: /^https?$/ }),
  INTEGRATION_API_BASE_URL: z.url({ protocol: /^https?$/ }),
  /** This service's workload key; the API trusts it for client resolution and FHIR reads only. */
  INTEGRATION_WORKLOAD_PRIVATE_KEY_JWK: PrivateJwk,
  INTEGRATION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),
});

async function main(): Promise<void> {
  const config = loadConfig(Config, process.env);
  const app = await buildIntegration({
    logLevel: config.ENDO_LOG_LEVEL,
    baseUrl: config.INTEGRATION_BASE_URL.replace(/\/$/, ''),
    api: new HttpApi({
      apiBaseUrl: config.INTEGRATION_API_BASE_URL,
      signer: new WorkloadTokenSigner(config.INTEGRATION_WORKLOAD_PRIVATE_KEY_JWK, 'integration'),
      fetch,
    }),
    now: () => Date.now(),
    rateLimitPerMinute: config.INTEGRATION_RATE_LIMIT_PER_MINUTE,
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close());
  await app.listen({ host: config.INTEGRATION_HOST, port: config.INTEGRATION_PORT });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `integration failed to start: ${error instanceof Error ? error.name : 'unknown'}\n`,
  );
  if (error instanceof Error && error.name === 'ConfigError')
    process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
