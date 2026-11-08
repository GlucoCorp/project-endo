#!/usr/bin/env node
// Lists every unfinished clinical, licence and legal marker (spec 0 rule 5, 24).
// Usage: node tools/check-clinical-todos.mjs [--release]
//   default:   report only (exit 0) — used on every PR so the debt stays visible.
//   --release: exit 1 if any marker remains — used by the release pipeline (spec 7.3, M6).
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MARKERS = ['TODO_CLINICAL', 'TODO_LICENCE', 'TODO_LEGAL'];
// Content only: code, READMEs and ADRs mention the markers by name and are not unfinished content.
const SCAN = ['clinical', 'docs'];
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.turbo']);
const release = process.argv.includes('--release');

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const counts = new Map(MARKERS.map((m) => [m, 0]));
const byFile = new Map();
for (const top of SCAN) {
  for await (const file of walk(join(ROOT, top))) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    if (rel.endsWith('README.md') || rel.startsWith('docs/adr/')) continue;
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const m of MARKERS) {
      const n = text.split(m).length - 1;
      if (n > 0) {
        counts.set(m, (counts.get(m) ?? 0) + n);
        byFile.set(rel, (byFile.get(rel) ?? 0) + n);
      }
    }
  }
}

for (const [file, n] of [...byFile].sort()) console.log(`${String(n).padStart(4)}  ${file}`);
console.log(MARKERS.map((m) => `${m}: ${counts.get(m)}`).join('  '));
const total = [...counts.values()].reduce((a, b) => a + b, 0);
if (release && total > 0) {
  console.error('Release blocked: unfinished clinical, licence or legal content remains.');
  process.exit(1);
}
