// Shared helpers for tools/backup.mjs and tools/restore-drill.mjs (node builtins only).

import { execFileSync, spawn } from 'node:child_process';

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
 * pasted into the SQL text. psql's own error output is not shown (it can quote row data).
 */
export function psql(exec, user, db, sql, vars = {}) {
  const args = [...exec, 'psql', '-U', user, '-d', db, '-At', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const [cmd, ...rest] = args;
  try {
    return execFileSync(cmd, rest, {
      encoding: 'utf8',
      input: `${sql}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('psql failed (its output is withheld: it can contain data)');
  }
}

/**
 * One long-lived psql session, so several statements share a transaction (and its snapshot).
 * Each query's output ends at a marker line the session echoes after it.
 */
export class PsqlSession {
  #proc;
  #buffer = '';
  #waiting = null;

  constructor(exec, user, db) {
    const [cmd, ...rest] = [...exec, 'psql', '-U', user, '-d', db, '-At', '-v', 'ON_ERROR_STOP=1'];
    this.#proc = spawn(cmd, rest, { stdio: ['pipe', 'pipe', 'ignore'] });
    this.#proc.stdout.setEncoding('utf8');
    this.#proc.stdout.on('data', (chunk) => {
      this.#buffer += chunk;
      this.#drain();
    });
    this.#proc.on('close', () => {
      if (this.#waiting) this.#waiting.reject(new Error('psql session ended'));
      this.#waiting = null;
    });
  }

  #drain() {
    const marker = '__ENDO_END__\n';
    const at = this.#buffer.indexOf(marker);
    if (at === -1 || !this.#waiting) return;
    const out = this.#buffer.slice(0, at);
    this.#buffer = this.#buffer.slice(at + marker.length);
    const w = this.#waiting;
    this.#waiting = null;
    w.resolve(out);
  }

  query(sql) {
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
      this.#proc.stdin.write(`${sql}\n\\echo __ENDO_END__\n`);
      this.#drain();
    });
  }

  close() {
    this.#proc.stdin.end('\\q\n');
  }
}
