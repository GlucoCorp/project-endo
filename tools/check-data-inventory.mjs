#!/usr/bin/env node
// Spec 11.3: every column created by a migration must be documented in docs/data-inventory.md
// (purpose, legal basis, retention, sensitivity). Columns are matched as `table.column` in backticks.
// Handles CREATE TABLE and ALTER TABLE … ADD COLUMN in packages/*/migrations and services/*/migrations.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const NOT_COLUMNS = new Set([
  'constraint',
  'primary',
  'unique',
  'check',
  'foreign',
  'exclude',
  'like',
]);

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Lower-case word tokens plus single-character punctuation, e.g. ["create","table","t","("]. */
function tokenize(sql) {
  const tokens = [];
  let word = '';
  for (const ch of sql.toLowerCase()) {
    if (/[a-z0-9_"]/.test(ch)) {
      word += ch;
      continue;
    }
    if (word) tokens.push(word.replaceAll('"', ''));
    word = '';
    if (ch === '(' || ch === ')' || ch === ',' || ch === ';') tokens.push(ch);
  }
  if (word) tokens.push(word.replaceAll('"', ''));
  return tokens;
}

/** Skips optional "if [not] exists" and returns the index of the next token. */
function skipIfExists(tokens, i) {
  if (tokens.at(i) !== 'if') return i;
  return tokens.at(i + 1) === 'not' ? i + 3 : i + 2;
}

export function columnsFromSql(rawSql) {
  const tokens = tokenize(stripComments(rawSql).replace(/'[^']*'/g, ' '));
  const cols = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens.at(i) === 'create' && tokens.at(i + 1) === 'table') {
      let j = skipIfExists(tokens, i + 2);
      const table = tokens.at(j);
      if (tokens.at(j + 1) !== '(') continue;
      // Walk the column list: the first word after "(" or a top-level "," names a column.
      let depth = 0;
      let expectName = true;
      for (j = j + 1; j < tokens.length; j++) {
        const t = tokens.at(j);
        if (t === '(') {
          depth++;
          continue;
        }
        if (t === ')') {
          depth--;
          if (depth === 0) break;
          continue;
        }
        if (depth === 1 && t === ',') {
          expectName = true;
          continue;
        }
        if (depth === 1 && expectName) {
          if (!NOT_COLUMNS.has(t)) cols.push(`${table}.${t}`);
          expectName = false;
        }
      }
      i = j;
    } else if (tokens.at(i) === 'alter' && tokens.at(i + 1) === 'table') {
      const j = skipIfExists(tokens, i + 2);
      const table = tokens.at(j);
      if (tokens.at(j + 1) === 'add' && tokens.at(j + 2) === 'column') {
        cols.push(`${table}.${tokens.at(skipIfExists(tokens, j + 3))}`);
      }
    }
  }
  return cols;
}

async function migrationFiles() {
  const files = [];
  for (const group of ['packages', 'services']) {
    const pkgs = await readdir(join(ROOT, group), { withFileTypes: true }).catch(() => []);
    for (const p of pkgs.filter((d) => d.isDirectory())) {
      const dir = join(ROOT, group, p.name, 'migrations');
      const names = await readdir(dir).catch(() => []);
      for (const n of names.filter((x) => x.endsWith('.sql'))) files.push(join(dir, n));
    }
  }
  return files;
}

const inventory = await readFile(join(ROOT, 'docs/data-inventory.md'), 'utf8');
const missing = [];
let total = 0;
for (const file of await migrationFiles()) {
  for (const col of columnsFromSql(await readFile(file, 'utf8'))) {
    total++;
    if (!inventory.includes(`\`${col}\``)) missing.push(`${col}  (${file.slice(ROOT.length)})`);
  }
}
if (missing.length > 0) {
  console.error(
    `Columns missing from docs/data-inventory.md (spec 11.3):\n  ${missing.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(`Data inventory OK (${total} columns documented).`);
