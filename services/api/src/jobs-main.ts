import { z } from 'zod';
import { Environment, loadConfig } from '@endo/config';
import { PostgresDeletionStore, type ClinicalDatabase } from '@endo/clinical-store';
import { createDb, createPool } from '@endo/db';
import { uuidv7 } from '@endo/domain';
import { WorkloadTokenSigner } from '@endo/service-kit';
import { DeletionJob, HttpIdentityErasure } from './deletion-job.ts';

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

/**
 * The jobs process (spec 7 `jobs/`): the same image as the API, its own process and secrets. It
 * holds the jobs workload key, which the identity service trusts for `identity.person.erase` and
 * nothing else; the API process never holds that key. Its audit events go through the clinical
 * outbox, which the API's relay publishes (spec 2.6).
 */
const Config = z.object({
  ENDO_ENV: Environment,
  // Clinical store as a member of endo_clinical_app (ADR-0017); patient_erase acts on due
  // requests only.
  JOBS_CLINICAL_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  JOBS_WORKLOAD_PRIVATE_KEY_JWK: PrivateJwk,
  JOBS_IDENTITY_BASE_URL: z.url({ protocol: /^https?$/ }),
  JOBS_DELETION_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
});

async function main(): Promise<void> {
  const config = loadConfig(Config, process.env);
  const db = createDb<ClinicalDatabase>(
    createPool(config.JOBS_CLINICAL_DATABASE_URL, { applicationName: 'endo-jobs', max: 2 }),
  );
  const job = new DeletionJob(
    new PostgresDeletionStore(db),
    new HttpIdentityErasure({
      identityBaseUrl: config.JOBS_IDENTITY_BASE_URL,
      signer: new WorkloadTokenSigner(config.JOBS_WORKLOAD_PRIVATE_KEY_JWK, 'jobs'),
      fetch,
    }),
    () => uuidv7(),
  );
  // Counts only, never ids (spec 2.3).
  const tick = () =>
    job
      .run()
      .then((r) => {
        process.stdout.write(
          `${JSON.stringify({ event: 'deletion.run', erased: r.erased, identity_erased: r.identityErased, failed: r.failed })}\n`,
        );
      })
      .catch(() => process.stderr.write('deletion run failed\n'));
  await tick();
  const timer = setInterval(() => void tick(), config.JOBS_DELETION_INTERVAL_MS);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      clearInterval(timer);
      void db.destroy();
    });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `jobs failed to start: ${error instanceof Error ? error.name : 'unknown'}\n`,
  );
  if (error instanceof Error && error.name === 'ConfigError')
    process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
