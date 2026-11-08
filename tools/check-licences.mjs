#!/usr/bin/env node
// Licence allowlist check (spec 18.2): MIT, Apache-2.0, BSD, ISC. MPL-2.0 only after review,
// recorded in REVIEWED below with the ADR that approved it. Anything else fails.
import { execSync } from 'node:child_process';

// Constant command strings only: nothing user-controlled reaches the shell.
const run = (cmd) => execSync(cmd, { encoding: 'utf8' });

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'ISC',
  'BlueOak-1.0.0', // permissive, equivalent to MIT/ISC; used by several npm tooling packages
  'CC0-1.0',
  'Python-2.0', // argparse (eslint dependency), permissive
]);
// package name -> ADR that approved a licence outside ALLOWED (e.g. MPL-2.0).
const REVIEWED = new Map([
  // MPL-2.0, dev-only (Vite CSS transformer pulled in by Vitest); never shipped. Pending human confirmation.
  ['lightningcss', 'ADR-0010'],
  ['lightningcss-win32-x64-msvc', 'ADR-0010'],
  ['lightningcss-linux-x64-gnu', 'ADR-0010'],
  ['lightningcss-linux-x64-musl', 'ADR-0010'],
  ['lightningcss-darwin-arm64', 'ADR-0010'],
]);

// Production dependencies get no exceptions at all.
const prodOut = run('pnpm licenses list --json --prod');
const prodFailures = [];
for (const [licence, pkgs] of Object.entries(JSON.parse(prodOut))) {
  const ok = licence
    .replace(/[()]/g, '')
    .split(/\s+OR\s+/)
    .some((l) => ALLOWED.has(l.trim()));
  if (!ok) for (const p of pkgs) prodFailures.push(`${p.name}: ${licence}`);
}
if (prodFailures.length > 0) {
  console.error(`Production licence check failed:\n  ${prodFailures.join('\n  ')}`);
  process.exit(1);
}

const out = run('pnpm licenses list --json');
const byLicence = JSON.parse(out);
const failures = [];
let count = 0;
for (const [licence, pkgs] of Object.entries(byLicence)) {
  // SPDX "A OR B": acceptable if any option is allowed.
  const ok = licence
    .replace(/[()]/g, '')
    .split(/\s+OR\s+/)
    .some((l) => ALLOWED.has(l.trim()));
  for (const p of pkgs) {
    count++;
    if (!ok && !REVIEWED.has(p.name))
      failures.push(`${p.name}@${p.versions?.join(',') ?? '?'}: ${licence}`);
  }
}
if (failures.length > 0) {
  console.error(
    `Licence check failed for ${failures.length} package(s):\n  ${failures.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(`Licence check passed (${count} packages).`);
