#!/usr/bin/env node
// Encrypted logical backup of one database (spec 12.8; docs/runbooks/backups.md).
//
//   node tools/backup.mjs --db endo_clinical --out ./backups --key ./backup.key \
//     [--user postgres] [--exec "docker exec -i endo-test-db"]
//
// pg_dump (custom format) is streamed through AES-256-GCM with a 32-byte key (hex in --key; in
// deployed environments the key comes from kms/backup, never from disk). The dump is never written
// unencrypted. Next to it, a manifest records the IV, auth tag, the ciphertext's SHA-256 and the
// row count of every table, which the restore drill compares (tools/restore-drill.mjs).
// Output names carry the database and a UTC timestamp only; never data.

import { spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { parseArgs, psql, readKey, splitCommand } from './pg-tools.mjs';

const opts = parseArgs(process.argv.slice(2));
const arg = (name) => {
  const v = opts.get(name);
  return typeof v === 'string' ? v : undefined;
};
for (const required of ['db', 'out', 'key']) {
  if (!arg(required)) {
    process.stderr.write(`missing --${required}\n`);
    process.exit(2);
  }
}
const db = arg('db') ?? '';
const out = arg('out') ?? '';
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(db)) {
  process.stderr.write('--db must be a plain database name\n');
  process.exit(2);
}
const user = arg('user') ?? 'postgres';
const exec = splitCommand(arg('exec') ?? '');
const key = readKey(readFileSync(arg('key') ?? '', 'utf8'));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const name = `${db}-${stamp}`;
mkdirSync(out, { recursive: true });
const dumpPath = join(out, `${name}.dump.enc`);

/** Every table's row count, one "schema.table|n" line each (no data). */
const COUNT_ROWS = [
  "SELECT n.nspname || '.' || c.relname,",
  "  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I',",
  "    n.nspname, c.relname), false, true, '')))[1]::text",
  '  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace',
  "  WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')",
  "    AND n.nspname NOT LIKE 'pg_toast%'",
  '  ORDER BY 1',
].join('\n');

// Row counts first, from the same server (a consistency check for the drill, not a guarantee:
// pg_dump takes its own snapshot).
const counts = Object.fromEntries(
  psql(exec, user, db, COUNT_ROWS)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [table, n] = line.split('|');
      return [table, Number(n)];
    }),
);

const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const hash = createHash('sha256');
const [cmd, ...cmdArgs] = [...exec, 'pg_dump', '-U', user, '-d', db, '-Fc'];
const dump = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'inherit'] });
const exited = new Promise((resolve) => dump.on('close', resolve));
await pipeline(
  dump.stdout,
  cipher,
  new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  }),
  createWriteStream(dumpPath, { mode: 0o600 }),
);
const code = await exited;
if (code !== 0) {
  process.stderr.write(`pg_dump failed (exit ${String(code)})\n`);
  process.exit(1);
}

const manifest = {
  format: 'endo-backup-v1',
  database: db,
  created_at: new Date().toISOString(),
  file: `${name}.dump.enc`,
  cipher: 'aes-256-gcm',
  iv: iv.toString('base64'),
  tag: cipher.getAuthTag().toString('base64'),
  sha256: hash.digest('hex'),
  row_counts: counts,
};
writeFileSync(join(out, `${name}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(`${join(out, `${name}.manifest.json`)}\n`);
