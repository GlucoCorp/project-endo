#!/usr/bin/env node
// Runs the platform's idempotent Postgres role scripts (infra/modules/platform/postgres-roles)
// against a throwaway server, exactly as the postgres-<instance>-roles Job does, and checks the
// result (spec 2.4, 11.1; ADR-0013, ADR-0017):
//   - two runs in a row succeed (idempotent) and create every database and login;
//   - each login connects to its own database and is refused by the others;
//   - logins carry no attribute beyond LOGIN;
//   - a changed password takes effect on the next run (rotation);
//   - a missing password stops the run.
// Usage: node tools/check-postgres-roles.mjs <superuser-url>   (CI only; synthetic passwords)
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const admin = process.argv[2];
if (!admin) {
  console.error('usage: node tools/check-postgres-roles.mjs <superuser-url>');
  process.exit(2);
}

const order = JSON.parse(
  readFileSync(join(ROOT, 'infra/modules/platform/postgres-roles/order.json'), 'utf8'),
);
const files = [...order.common, ...Object.values(order.databases).flat()];
const sqlText = files.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
const passwordVars = [...new Set([...sqlText.matchAll(/\\getenv pw ([A-Z_]+)/g)].map((m) => m[1]))];

/**
 * Read from the scripts, in order: login role -> its database, and login role -> the group roles
 * it must be a direct member of (`\set group`, plus grant-owner.sql for the clinical owner).
 */
const logins = new Map();
const expectedGroups = new Map();
for (const [db, dbFiles] of Object.entries(order.databases)) {
  for (const f of dbFiles) {
    let role;
    for (const line of readFileSync(join(ROOT, f), 'utf8').split('\n')) {
      const r = /^\\set role (\w+)/.exec(line);
      if (r) {
        role = r[1];
        logins.set(role, db);
        expectedGroups.set(role, new Set());
      }
      const g = /^\\set group (\w+)/.exec(line);
      if (g && role) expectedGroups.get(role).add(g[1]);
      // bootstrap/grant-owner.sql grants group roles to the database owner.
      const o = /^GRANT (\w+) TO :"owner";/.exec(line);
      if (o) expectedGroups.get(`${db}_owner`).add(o[1]);
    }
  }
}

const fresh = () => randomBytes(18).toString('hex');
const passwords = Object.fromEntries(passwordVars.map((v) => [v, fresh()]));
const envVarOf = (role) =>
  role.endsWith('_owner')
    ? `${role.slice(0, -6).toUpperCase()}_OWNER_PASSWORD`
    : `${role.toUpperCase()}_PASSWORD`;

/** The process environment without any password variable, so only `env` supplies them. */
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !passwordVars.includes(k)),
);

function reconcile(env) {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', admin];
  for (const f of files) args.push('-f', join(ROOT, f));
  return spawnSync('psql', args, { env: { ...baseEnv, ...env }, encoding: 'utf8' });
}

function canConnect(role, password, db) {
  const u = new URL(admin);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  const r = spawnSync('psql', ['-X', '-q', '-At', '-c', 'SELECT 1', u.toString()], {
    encoding: 'utf8',
  });
  return r.status === 0;
}

const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
};

for (const run of [1, 2]) {
  const r = reconcile(passwords);
  check(r.status === 0, `run ${run} failed: ${r.stderr.trim()}`);
}

const databases = Object.keys(order.databases);
for (const [role, db] of logins) {
  const pw = passwords[envVarOf(role)];
  check(pw !== undefined, `${role}: no password variable ${envVarOf(role)}`);
  check(canConnect(role, pw, db), `${role} cannot connect to ${db}`);
  for (const other of databases.filter((d) => d !== db))
    check(!canConnect(role, pw, other), `${role} can connect to ${other}`);
}

// Constant SQL read from stdin; the role list is a psql variable, quoted by psql itself.
const EXTRA_ATTRIBUTES =
  "SELECT rolname FROM pg_roles WHERE rolname = ANY (string_to_array(:'roles', ',')) " +
  'AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);';
const attrs = execFileSync(
  'psql',
  ['-X', '-At', '-v', `roles=${[...logins.keys()].join(',')}`, admin],
  {
    input: EXTRA_ATTRIBUTES,
    encoding: 'utf8',
  },
).trim();
check(attrs === '', `logins with extra attributes: ${attrs}`);

// Direct memberships are exactly the intended ones, and no service login can act as any owner.
const MEMBERSHIPS =
  "SELECT r.rolname || '=' || coalesce(string_agg(g.rolname, ',' ORDER BY g.rolname), '') " +
  'FROM pg_roles r LEFT JOIN pg_auth_members m ON m.member = r.oid ' +
  'LEFT JOIN pg_roles g ON g.oid = m.roleid ' +
  "WHERE r.rolname = ANY (string_to_array(:'roles', ',')) GROUP BY r.rolname;";
const actual = execFileSync(
  'psql',
  ['-X', '-At', '-v', `roles=${[...logins.keys()].join(',')}`, admin],
  {
    input: MEMBERSHIPS,
    encoding: 'utf8',
  },
)
  .trim()
  .split(/\r?\n/)
  .map((l) => l.split('='));
check(actual.length === logins.size, `expected ${logins.size} logins, found ${actual.length}`);
for (const [role, groups] of actual) {
  const want = [...(expectedGroups.get(role) ?? [])].sort().join(',');
  check(groups === want, `${role} is a member of [${groups}], expected [${want}]`);
}
const OWNER_REACH =
  "SELECT l || ' -> ' || o FROM unnest(string_to_array(:'services', ',')) AS l, " +
  "unnest(string_to_array(:'owners', ',')) AS o WHERE pg_has_role(l, o, 'USAGE');";
const owners = [...logins.keys()].filter((r) => r.endsWith('_owner'));
const services = [...logins.keys()].filter((r) => !r.endsWith('_owner'));
const reach = execFileSync(
  'psql',
  ['-X', '-At', '-v', `services=${services.join(',')}`, '-v', `owners=${owners.join(',')}`, admin],
  { input: OWNER_REACH, encoding: 'utf8' },
).trim();
check(reach === '', `service logins that can act as an owner: ${reach}`);

// Rotation: a new password works after the next run, and the old one stops working.
const [rotRole, rotDb] = [...logins].find(([r]) => !r.endsWith('_owner'));
const oldPw = passwords[envVarOf(rotRole)];
passwords[envVarOf(rotRole)] = fresh();
check(reconcile(passwords).status === 0, 'rotation run failed');
check(canConnect(rotRole, passwords[envVarOf(rotRole)], rotDb), `${rotRole}: new password refused`);
check(!canConnect(rotRole, oldPw, rotDb), `${rotRole}: old password still works`);

// A missing password stops the run rather than setting a placeholder.
const missing = Object.fromEntries(
  Object.entries(passwords).filter(([k]) => k !== envVarOf(rotRole)),
);
check(reconcile(missing).status !== 0, 'a missing password did not stop the run');
check(
  canConnect(rotRole, passwords[envVarOf(rotRole)], rotDb),
  `${rotRole}: password changed by a failed run`,
);

if (failures.length > 0) {
  console.error(`Postgres role scripts: ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `Postgres role scripts OK (${logins.size} logins, ${databases.length} databases, memberships, idempotent, rotation, missing-password stop).`,
);
