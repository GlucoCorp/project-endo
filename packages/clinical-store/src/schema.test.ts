import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLINICAL_MIGRATIONS_DIR, CONSENT_PURPOSES } from './index.ts';

describe('spec 13.1 consent purposes', () => {
  it('match the database CHECK constraint exactly', () => {
    const migration = readFileSync(
      join(CLINICAL_MIGRATIONS_DIR, '0001_enrolment_consent.sql'),
      'utf8',
    );
    const check = /purpose\s+text\s+NOT NULL CHECK \(purpose IN \(([^)]*)\)\)/.exec(migration);
    const inDb = (check?.[1] ?? '').match(/'([a-z_]+)'/g)?.map((s) => s.slice(1, -1));
    expect(inDb).toEqual([...CONSENT_PURPOSES]);
  });
});
