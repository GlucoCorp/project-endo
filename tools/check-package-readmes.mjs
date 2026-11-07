#!/usr/bin/env node
// Spec 23: every package has a README stating its purpose, public API and owners.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const failures = [];
for (const group of ['packages', 'services', 'apps']) {
  const dirs = await readdir(join(ROOT, group), { withFileTypes: true }).catch(() => []);
  for (const d of dirs.filter((e) => e.isDirectory())) {
    const readme = await readFile(join(ROOT, group, d.name, 'README.md'), 'utf8').catch(() => null);
    if (readme === null) {
      failures.push(`${group}/${d.name}: missing README.md`);
      continue;
    }
    for (const required of ['**Purpose:**', '**Owners:**', '## Public API']) {
      if (!readme.includes(required))
        failures.push(`${group}/${d.name}: README lacks "${required}"`);
    }
  }
}
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Package READMEs OK.');
