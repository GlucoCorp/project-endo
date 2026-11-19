#!/usr/bin/env node
// Restore drill (spec 12.8: quarterly, with a written report; docs/runbooks/restore.md).
//
//   node tools/restore-drill.mjs --manifest ./backups/<name>.manifest.json --key ./backup.key \
//     --scratch endo_drill_20261116 --report ./drill.md \
//     [--user postgres] [--exec "docker exec -i endo-test-db"] [--keep]
//
// Verifies the ciphertext's SHA-256, decrypts with AES-256-GCM (the auth tag must match),
// restores into a NEW scratch database (its name must contain "drill"; an existing one is
// refused), then checks:
//   1. every table's row count equals the manifest;
//   2. no patient whose key was shredded has a key again (crypto-shredding survives restore);
//   3. no erased deletion request has a patient record again (REQ-009 survives restore);
//   4. no erased identity person has a key again.
// Writes a Markdown report with counts only (never data), and drops the scratch database unless
// --keep. Exit 0 only if every check passes.

import { spawn } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs, psql, readKey, splitCommand } from './pg-tools.mjs';

const opts = parseArgs(process.argv.slice(2));
const arg = (name) => {
  const v = opts.get(name);
  return typeof v === 'string' ? v : undefined;
};
for (const required of ['manifest', 'key', 'scratch', 'report']) {
  if (!arg(required)) {
    process.stderr.write(`missing --${required}\n`);
    process.exit(2);
  }
}
const scratch = arg('scratch') ?? '';
const keep = opts.get('keep') === true;
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(scratch) || !scratch.includes('drill')) {
  process.stderr.write('--scratch must be a plain database name containing "drill"\n');
  process.exit(2);
}
const user = arg('user') ?? 'postgres';
const exec = splitCommand(arg('exec') ?? '');
const key = readKey(readFileSync(arg('key') ?? '', 'utf8'));
const manifest = JSON.parse(readFileSync(arg('manifest') ?? '', 'utf8'));
if (manifest.format !== 'endo-backup-v1') throw new Error('unknown manifest format');
const dumpPath = join(dirname(arg('manifest') ?? ''), manifest.file);
const started = new Date();
const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

// 0. Integrity of the file before anything is restored.
const fileHash = createHash('sha256').update(readFileSync(dumpPath)).digest('hex');
check('Ciphertext SHA-256 matches the manifest', fileHash === manifest.sha256, '');

const exists = psql(
  exec,
  user,
  'postgres',
  "SELECT 1 FROM pg_database WHERE datname = :'scratch'",
  {
    scratch,
  },
);
if (exists.trim() !== '') {
  process.stderr.write(`scratch database ${scratch} already exists: refusing\n`);
  process.exit(2);
}
psql(exec, user, 'postgres', 'CREATE DATABASE :"scratch"', { scratch });

let restoreOk = false;
try {
  if (fileHash === manifest.sha256) {
    // Decrypt completely first: GCM proves the data only at the end, so nothing reaches
    // pg_restore before the auth tag has been verified. The plaintext lives in a private
    // temporary directory and is removed whatever happens.
    const dir = mkdtempSync(join(tmpdir(), 'endo-drill-'));
    const plain = join(dir, 'dump');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(manifest.tag, 'base64'));
      let verified = false;
      try {
        await pipeline(
          createReadStream(dumpPath),
          decipher,
          createWriteStream(plain, { mode: 0o600 }),
        );
        verified = true;
      } catch {
        verified = false; // a wrong key or a changed file fails the auth tag
      }
      check('Decrypted and the auth tag verified before restoring', verified, '');
      if (verified) {
        const [cmd, ...cmdArgs] = [
          ...exec,
          'pg_restore',
          '-U',
          user,
          '-d',
          scratch,
          '--exit-on-error',
        ];
        // pg_restore's own output is withheld: its errors can quote rows.
        const restore = spawn(cmd, cmdArgs, { stdio: ['pipe', 'ignore', 'ignore'] });
        const exited = new Promise((resolve) => restore.on('close', resolve));
        try {
          await pipeline(createReadStream(plain), restore.stdin);
          restoreOk = (await exited) === 0;
        } catch {
          restoreOk = false;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  check('Restored with pg_restore', restoreOk, '');

  if (restoreOk) {
    // 1. Row counts.
    const mismatched = [];
    for (const [table, expected] of Object.entries(manifest.row_counts)) {
      const [schema, rel] = table.split('.');
      const got = Number(
        psql(exec, user, scratch, 'SELECT count(*) FROM :"schema".:"rel"', { schema, rel }).trim(),
      );
      if (got !== expected) mismatched.push(`${table}: ${String(got)} of ${String(expected)}`);
    }
    check(
      `Row counts match for ${String(Object.keys(manifest.row_counts).length)} tables`,
      mismatched.length === 0,
      mismatched.join('; '),
    );
    // 2-4. Erasure invariants, wherever the tables exist (any schema).
    const invariant = (label, tableA, sql) => {
      const schemas = psql(
        exec,
        user,
        scratch,
        "SELECT table_schema FROM information_schema.tables WHERE table_name = :'t'",
        { t: tableA },
      )
        .split('\n')
        .filter(Boolean);
      let bad = 0;
      for (const s of schemas) bad += Number(psql(exec, user, scratch, sql, { s }).trim());
      check(
        `${label} (${String(schemas.length)} schema(s))`,
        bad === 0,
        bad ? `${String(bad)} found` : '',
      );
    };
    invariant(
      'No shredded patient key came back',
      'patient_key_shredded',
      'SELECT count(*) FROM :"s".patient_key k JOIN :"s".patient_key_shredded x USING (patient_id)',
    );
    invariant(
      'No erased patient record came back',
      'deletion_request',
      'SELECT count(*) FROM :"s".patient_record r JOIN :"s".deletion_request d ON d.patient_id = r.id WHERE d.erased_at IS NOT NULL',
    );
    invariant(
      'No shredded identity key came back',
      'person_key_shredded',
      'SELECT count(*) FROM :"s".person_key k JOIN :"s".person_key_shredded x USING (person_id)',
    );
  }
} finally {
  if (!keep) psql(exec, user, 'postgres', 'DROP DATABASE IF EXISTS :"scratch"', { scratch });
}

const passed = results.every((r) => r.ok);
const report = [
  `# Restore drill: ${manifest.database}`,
  '',
  `- Backup taken: ${manifest.created_at}`,
  `- Drill run: ${started.toISOString()} to ${new Date().toISOString()}`,
  `- Scratch database: \`${scratch}\` (${keep ? 'kept' : 'dropped after the drill'})`,
  `- Result: **${passed ? 'passed' : 'FAILED'}**`,
  '',
  '| Check | Result | Detail |',
  '| --- | --- | --- |',
  ...results.map((r) => `| ${r.name} | ${r.ok ? 'pass' : 'fail'} | ${r.detail || ''} |`),
  '',
  'Counts only; no data is copied into this report.',
  '',
].join('\n');
writeFileSync(arg('report') ?? '', report);
process.stdout.write(`${passed ? 'passed' : 'FAILED'}: ${arg('report') ?? ''}\n`);
process.exit(passed ? 0 : 1);
