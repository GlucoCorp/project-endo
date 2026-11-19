import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { testDatabaseUrl } from '@endo/db';
import { SessionTable } from '@endo/session-store';
import { createTestSessionDb, type TestSessionDb } from '@endo/session-store/testing';
import { PostgresPatientSessions } from './pg-sessions.ts';

const url = testDatabaseUrl();
const CLAIMS = {
  sub: '01900000-0000-7000-8000-0000000000f1',
  role: 'patient' as const,
  org_id: '01900000-0000-7000-8000-00000000000a',
  patient_id: '01900000-0000-7000-8000-0000000000a1',
};

describe.skipIf(!url)('spec 10.1, ADR-0033 durable patient sessions', () => {
  let t: TestSessionDb;
  let sessions: PostgresPatientSessions;
  beforeAll(async () => {
    t = await createTestSessionDb(url!);
    sessions = new PostgresPatientSessions(new SessionTable(t.db));
  });
  afterAll(() => t.close());

  const age = (token: string, column: 'last_seen_at' | 'created_at', minutes: number) =>
    t.admin.query(
      column === 'last_seen_at'
        ? 'UPDATE browser_session SET last_seen_at = now() - make_interval(mins => $2) WHERE token_hash = $1'
        : 'UPDATE browser_session SET created_at = now() - make_interval(mins => $2) WHERE token_hash = $1',
      [createHash('sha256').update(token).digest('hex'), minutes],
    );

  it('signs her in, and locks the app after 5 minutes unused when she chose app lock', async () => {
    const token = await sessions.createPatient(CLAIMS);
    expect(await sessions.resolve(token)).toMatchObject({ claims: CLAIMS, locked: false });
    expect(await sessions.setAppLock(token, true)).toBe(true);
    await age(token, 'last_seen_at', 6);
    expect((await sessions.resolve(token))?.locked).toBe(true);
    expect(await sessions.setAppLock(token, false)).toBe(false); // locked: refused
    expect(await sessions.setAppLock('x'.repeat(43), true)).toBe(false);
    await sessions.revoke(token);
    expect(await sessions.resolve(token)).toBeNull();
  });

  it('locks at once on request, only when app lock is on', async () => {
    const off = await sessions.createPatient(CLAIMS);
    await sessions.lock(off);
    expect((await sessions.resolve(off))?.locked).toBe(false);
    const on = await sessions.createPatient(CLAIMS, true);
    await sessions.lock(on);
    expect((await sessions.resolve(on))?.locked).toBe(true);
  });

  it('rotates a consent-pending session into hers, keeping the time of her first passkey', async () => {
    const pending = await sessions.createConsentPending('tx-1', 'kc-subject');
    expect(await sessions.consentPending(pending)).toMatchObject({
      transactionId: 'tx-1',
      subject: 'kc-subject',
    });
    expect(await sessions.resolve(pending)).toBeNull(); // not a patient session
    // Another transaction or subject: refused, and the pending session stays.
    expect(await sessions.rotate(pending, 'tx-2', 'kc-subject', CLAIMS)).toBeNull();
    expect(await sessions.rotate(pending, 'tx-1', 'other', CLAIMS)).toBeNull();
    expect(await sessions.consentPending(pending)).not.toBeNull();
    await age(pending, 'created_at', 11);
    const token = await sessions.rotate(pending, 'tx-1', 'kc-subject', CLAIMS);
    expect(await sessions.consentPending(pending)).toBeNull();
    const s = await sessions.resolve(token ?? '');
    expect(Date.now() - (s?.authenticatedAt ?? 0)).toBeGreaterThan(10 * 60_000);
    expect(await sessions.consentPending('y'.repeat(43))).toBeNull();
  });

  it('ends a consent-pending session after 60 minutes and hers after 12 hours', async () => {
    const pending = await sessions.createConsentPending('tx-3', 'kc');
    await age(pending, 'created_at', 61);
    expect(await sessions.consentPending(pending)).toBeNull();
    const token = await sessions.createPatient(CLAIMS);
    await age(token, 'created_at', 12 * 60 + 1);
    expect(await sessions.resolve(token)).toBeNull();
  });
});
