import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPool, runMigrations } from '@endo/db';
import { CLINICAL_MIGRATIONS_DIR } from '@endo/clinical-store';
import { IDENTITY_MIGRATIONS_DIR } from '@endo/identity-store';
import { ServiceTokenSigner } from '@endo/service-kit';

/**
 * ADR-0021 slice 8: the real stack, on this machine, with SYNTHETIC data only.
 *
 * - Keycloak: the endo-keycloak image (the pinned release plus our extension), importing the
 *   reviewed realm file unchanged; its placeholders come from the environment.
 * - The identity service, the API and the patient BFF: their real entry points, as child
 *   processes, against fresh schemas in the test database (real roles, real migrations).
 * - The test acts as the clinic (it holds the clinic BFF's service key) and as her browser.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REALM = 'endo-dev';
export const KEYCLOAK_IMAGE = process.env['ENDO_KEYCLOAK_IMAGE'] ?? 'endo-keycloak:e2e';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => {
        resolve(port);
      });
    });
  });
const ed25519 = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: JSON.stringify(privateKey.export({ format: 'jwk' })),
    pub: JSON.stringify(publicKey.export({ format: 'jwk' })),
    privJwk: privateKey.export({ format: 'jwk' }),
  };
};

async function waitFor(url: string, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  let last = '';
  while (Date.now() < until) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return;
      last = String(r.status);
    } catch (e) {
      last = e instanceof Error ? e.message : 'error';
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} did not come up (${last})`);
}

export interface Stack {
  readonly bff: string;
  readonly api: string;
  readonly keycloak: string;
  readonly realmUrl: string;
  readonly orgId: string;
  readonly clinicianRef: string;
  /** Signs a clinic service token as the seeded clinician (the test is the clinic BFF). */
  clinicToken(): Promise<string>;
  /** Superuser access to the clinical schema (assertions only). */
  clinical: pg.Pool;
  logs: () => string;
  stop(): Promise<void>;
}

async function migrate(su: pg.Client, url: string, store: 'clinical' | 'identity') {
  const schema = `e2e_${store}_${randomBytes(4).toString('hex')}`;
  const pw = () => randomBytes(16).toString('hex');
  const bootstrap =
    store === 'clinical'
      ? 'packages/clinical-store/bootstrap/roles.sql'
      : 'packages/identity-store/bootstrap/roles.sql';
  // A fixed path inside this repository, never input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await su.query(readFileSync(`${ROOT}${bootstrap}`, 'utf8'));
  const roles =
    store === 'clinical'
      ? {
          owner: [
            'e2e_clin_owner',
            'IN ROLE endo_clinical_lookup, endo_clinical_membership_lookup',
          ],
          app: ['e2e_clin_app', 'IN ROLE endo_clinical_app'],
          relay: ['e2e_clin_relay', 'IN ROLE endo_clinical_relay'],
        }
      : {
          owner: ['e2e_id_owner', ''],
          app: ['e2e_id_app', 'IN ROLE endo_identity_app'],
          relay: ['e2e_id_relay', 'IN ROLE endo_identity_relay'],
        };
  const urls = new Map<string, string>();
  for (const [k, [role, extra]] of Object.entries(roles) as [string, [string, string]][]) {
    const p = pw();
    const exists = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    // Fixed role names and generated hex passwords, never input.
    if (exists.rowCount === 0) await su.query(`CREATE ROLE ${role} LOGIN PASSWORD '${p}' ${extra}`);
    else await su.query(`ALTER ROLE ${role} LOGIN PASSWORD '${p}'`);
    const u = new URL(url);
    u.username = role;
    u.password = p;
    u.searchParams.set('options', `-c search_path=${schema}`);
    urls.set(k, u.toString());
  }
  await su.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${roles.owner[0]}`);
  const owner = createPool(urls.get('owner') ?? '', { applicationName: 'e2e-owner', max: 1 });
  try {
    await runMigrations(
      owner,
      store === 'clinical' ? CLINICAL_MIGRATIONS_DIR : IDENTITY_MIGRATIONS_DIR,
    );
  } finally {
    await owner.end();
  }
  const admin = new URL(url);
  admin.searchParams.set('options', `-c search_path=${schema}`);
  return {
    schema,
    app: urls.get('app') ?? '',
    relay: urls.get('relay') ?? '',
    admin: admin.toString(),
  };
}

export async function startStack(databaseUrl: string): Promise<Stack> {
  const [kcPort, idPort, apiPort, bffPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
    freePort(),
  ]);
  const keycloak = `http://localhost:${String(kcPort)}`;
  const realmUrl = `${keycloak}/realms/${REALM}`;
  const bff = `http://localhost:${String(bffPort)}`;
  const api = `http://127.0.0.1:${String(apiPort)}`;
  const identity = `http://127.0.0.1:${String(idPort)}`;

  const su = new pg.Client({ connectionString: databaseUrl });
  await su.connect();
  let clinicalDb: Awaited<ReturnType<typeof migrate>>;
  let identityDb: Awaited<ReturnType<typeof migrate>>;
  try {
    clinicalDb = await migrate(su, databaseUrl, 'clinical');
    identityDb = await migrate(su, databaseUrl, 'identity');
  } finally {
    await su.end();
  }
  const clinical = new pg.Pool({ connectionString: clinicalDb.admin });
  const orgId = randomUUID();
  const clinicianRef = randomUUID();
  await clinical.query(
    `INSERT INTO organization (id, region, name) VALUES ($1, 'ke', 'Synthetic Clinic')`,
    [orgId],
  );
  await clinical.query(
    `INSERT INTO clinician (id, org_id, identity_ref, role) VALUES ($1, $2, $3, 'clinician')`,
    [randomUUID(), orgId, clinicianRef],
  );

  const k = {
    bffPatientService: ed25519(),
    bffPatientWorkload: ed25519(),
    bffClinicService: ed25519(),
    apiWorkload: ed25519(),
    identityWorkload: ed25519(),
    keycloakWorkload: ed25519(),
  };
  const secret = randomBytes(32).toString('base64url');

  // Keycloak: the reviewed realm, unchanged; it reaches the identity service on the host.
  const container = `endo-e2e-kc-${randomBytes(3).toString('hex')}`;
  const realmFile = `${ROOT}infra/modules/platform/realm/endo-dev.json`;
  const env: Record<string, string> = {
    KC_BOOTSTRAP_ADMIN_USERNAME: 'e2e-admin',
    KC_BOOTSTRAP_ADMIN_PASSWORD: randomBytes(16).toString('hex'),
    ENDO_BFF_PATIENT_CLIENT_SECRET: secret,
    ENDO_BFF_PATIENT_REDIRECT_URI: `${bff}/auth/callback`,
    ENDO_BFF_PATIENT_ENROLMENT_REDIRECT_URI: `${bff}/auth/enrolment/callback`,
    ENDO_BFF_PATIENT_POST_LOGOUT_URI: `${bff}/`,
    ENDO_BFF_CLINICIAN_CLIENT_SECRET: randomBytes(32).toString('base64url'),
    ENDO_BFF_CLINICIAN_REDIRECT_URI: 'http://localhost:1/auth/callback',
    ENDO_BFF_CLINICIAN_POST_LOGOUT_URI: 'http://localhost:1/',
    ENDO_BFF_CLINICIAN_BACKCHANNEL_LOGOUT_URI: 'http://localhost:1/auth/backchannel-logout',
    ENDO_SMTP_HOST: 'localhost',
    ENDO_SMTP_PORT: '1025',
    ENDO_SMTP_FROM: 'no-reply@example.invalid',
    ENDO_SMTP_STARTTLS: 'false',
    ENDO_IDENTITY_BASE_URL: `http://host.docker.internal:${String(idPort)}`,
    ENDO_KEYCLOAK_WORKLOAD_PRIVATE_KEY_JWK: k.keycloakWorkload.priv,
    ENDO_IDENTITY_WORKLOAD_PUBLIC_KEY_JWK: k.identityWorkload.pub,
  };
  // Secrets for the container live outside the repository, readable by this user only.
  const envFile = join(tmpdir(), `${container}.env`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a generated temp path
  writeFileSync(
    envFile,
    Object.entries(env)
      .map(([a, b]) => `${a}=${b}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  execFileSync('docker', [
    'run',
    '-d',
    '--name',
    container,
    '--add-host',
    'host.docker.internal:host-gateway',
    '-p',
    `127.0.0.1:${String(kcPort)}:8080`,
    '--env-file',
    envFile,
    '-v',
    `${realmFile}:/opt/keycloak/data/import/endo-dev.json:ro`,
    KEYCLOAK_IMAGE,
    'start-dev',
    '--import-realm',
    `--hostname=${keycloak}`,
  ]);

  const children: ChildProcess[] = [];
  let logs = '';
  const run = (service: string, vars: Record<string, string>) => {
    const child = spawn(process.execPath, ['src/main.ts'], {
      cwd: `${ROOT}services/${service}`,
      env: { PATH: process.env['PATH'] ?? '', ENDO_ENV: 'dev', ENDO_LOG_LEVEL: 'warn', ...vars },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = (b: Buffer) => {
      logs += `[${service}] ${b.toString()}`;
      if (logs.length > 200_000) logs = logs.slice(-100_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    children.push(child);
  };

  run('identity', {
    IDENTITY_PORT: String(idPort),
    IDENTITY_HOST: '0.0.0.0',
    IDENTITY_DATABASE_URL: identityDb.app,
    IDENTITY_AUDIT_RELAY_DATABASE_URL: identityDb.relay,
    IDENTITY_IDP_ISSUER: realmUrl,
    IDENTITY_TRUSTED_API_PUBLIC_KEY_JWK: k.apiWorkload.pub,
    IDENTITY_TRUSTED_BFF_PATIENT_PUBLIC_KEY_JWK: k.bffPatientWorkload.pub,
    IDENTITY_TRUSTED_KEYCLOAK_PUBLIC_KEY_JWK: k.keycloakWorkload.pub,
    IDENTITY_WORKLOAD_PRIVATE_KEY_JWK: k.identityWorkload.priv,
    IDENTITY_API_BASE_URL: api,
    IDENTITY_KEYCLOAK_REALM_URL: realmUrl,
  });
  run('api', {
    API_PORT: String(apiPort),
    // Whichever form this checkout has (JSON from ADR-0027, YAML before it).
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed repository path
    ENDO_CLINICAL_RULESET_PATH: existsSync(`${ROOT}clinical/rulesets/ruleset.1.0.0.json`)
      ? `${ROOT}clinical/rulesets/ruleset.1.0.0.json`
      : `${ROOT}clinical/rulesets/ruleset.1.0.0.yaml`,
    API_CLINICAL_DATABASE_URL: clinicalDb.app,
    API_AUDIT_RELAY_DATABASE_URL: clinicalDb.relay,
    API_SERVICE_TOKEN_PUBLIC_KEY_JWK: k.bffPatientService.pub,
    API_BFF_CLINIC_SERVICE_PUBLIC_KEY_JWK: k.bffClinicService.pub,
    API_IDENTITY_WORKLOAD_PUBLIC_KEY_JWK: k.identityWorkload.pub,
    API_WORKLOAD_PRIVATE_KEY_JWK: k.apiWorkload.priv,
    API_IDENTITY_BASE_URL: identity,
  });
  run('bff-patient', {
    BFF_PATIENT_PORT: String(bffPort),
    BFF_PATIENT_API_BASE_URL: api,
    BFF_PATIENT_SERVICE_TOKEN_PRIVATE_KEY_JWK: k.bffPatientService.priv,
    BFF_PATIENT_DEV_SESSIONS_ENABLED: 'true',
    BFF_PATIENT_APP_DIR: `${ROOT}apps/patient-web/dist`,
    BFF_PATIENT_IDENTITY_BASE_URL: identity,
    BFF_PATIENT_WORKLOAD_PRIVATE_KEY_JWK: k.bffPatientWorkload.priv,
    BFF_PATIENT_ORIGIN: bff,
    BFF_PATIENT_OIDC_ISSUER: realmUrl,
    BFF_PATIENT_OIDC_AUTHORIZATION_ENDPOINT: `${realmUrl}/protocol/openid-connect/auth`,
    BFF_PATIENT_OIDC_TOKEN_ENDPOINT: `${realmUrl}/protocol/openid-connect/token`,
    BFF_PATIENT_OIDC_JWKS_URI: `${realmUrl}/protocol/openid-connect/certs`,
    BFF_PATIENT_OIDC_END_SESSION_ENDPOINT: `${realmUrl}/protocol/openid-connect/logout`,
    BFF_PATIENT_OIDC_CLIENT_SECRET: secret,
  });

  const stop = async () => {
    for (const c of children) c.kill();
    try {
      execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    } catch {
      // already gone
    }
    try {
      rmSync(envFile, { force: true });
    } catch {
      // ignore
    }
    await clinical.end();
  };
  try {
    await waitFor(`${realmUrl}/.well-known/openid-configuration`, 240_000, 'Keycloak');
    await waitFor(`${identity}/healthz`, 60_000, 'identity');
    await waitFor(`${api}/healthz`, 60_000, 'api');
    await waitFor(`${bff}/healthz`, 60_000, 'bff-patient');
  } catch (e) {
    const kcLogs = (() => {
      try {
        return execFileSync('docker', ['logs', '--tail', '60', container]).toString();
      } catch {
        return '';
      }
    })();
    await stop();
    throw new Error(`${e instanceof Error ? e.message : 'stack failed'}\n${logs}\n${kcLogs}`);
  }
  const clinic = new ServiceTokenSigner(k.bffClinicService.privJwk, 'bff-clinic');
  return {
    bff,
    api,
    keycloak,
    realmUrl,
    orgId,
    clinicianRef,
    clinicToken: () =>
      clinic.sign({ sub: clinicianRef, role: 'clinician', org_id: orgId, patient_id: null }, 'api'),
    clinical,
    logs: () => logs,
    stop,
  };
}
