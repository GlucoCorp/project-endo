// Shared helpers for tools/backup.mjs and tools/restore-drill.mjs (node builtins only).

import { execFileSync } from 'node:child_process';

/** "docker exec -i endo-test-db" -> ['docker', 'exec', '-i', 'endo-test-db']; '' -> []. */
export function splitCommand(s) {
  return s.trim() === '' ? [] : s.trim().split(/\s+/);
}

/** --name value pairs as a Map; a flag with no value is `true`. */
export function parseArgs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv.at(i) ?? '';
    if (!a.startsWith('--')) continue;
    const next = argv.at(i + 1);
    if (next === undefined || next.startsWith('--')) out.set(a.slice(2), true);
    else {
      out.set(a.slice(2), next);
      i += 1;
    }
  }
  return out;
}

/** A 32-byte key from 64 hex characters (whitespace ignored). */
export function readKey(text) {
  const hex = text.trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('the key must be 64 hex characters');
  return Buffer.from(hex, 'hex');
}

/**
 * Runs SQL with psql (unaligned, tuples only), fed on stdin so psql variables work: values are
 * passed as `vars` and referenced as :'name' (a literal) or :"name" (an identifier), never
 * pasted into the SQL text.
 */
export function psql(exec, user, db, sql, vars = {}) {
  const args = [...exec, 'psql', '-U', user, '-d', db, '-At', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const [cmd, ...rest] = args;
  return execFileSync(cmd, rest, {
    encoding: 'utf8',
    input: `${sql}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
