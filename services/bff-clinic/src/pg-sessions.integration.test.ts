import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { testDatabaseUrl } from '@endo/db';
import { SessionTable } from '@endo/session-store';
import { createTestSessionDb, type TestSessionDb } from '@endo/session-store/testing';
import { PostgresClinicSessions } from './pg-sessions.ts';

const url = testDatabaseUrl();
const ISS = 'https://kc.test/realms/endo';
const ORG = '01900000-0000-7000-8000-00000000000a';

describe.skipIf(!url)('ADR-0019, ADR-0033 durable clinician sessions', () => {
  let t: TestSessionDb;
  let sessions: PostgresClinicSessions;
  beforeAll(async () => {
    t = await createTestSessionDb(url!);
    sessions = new PostgresClinicSessions(new SessionTable(t.db));
  });
  afterAll(() => t.close());

  const make = (sid = 'kc-sid-1', subject = 'kc-sub-1') =>
    sessions.create({
      personId: '01900000-0000-7000-8000-0000000000e1',
      issuer: ISS,
      subject,
      sid,
      idToken: 'id-token',
      refresh: { wrappedKey: 'w', envelope: 'v1.a.b.c' },
      memberships: [{ orgId: ORG, role: 'clinician' }],
    });
  const age = (token: string, minutes: number) =>
    t.admin.query(
      `UPDATE browser_session SET last_seen_at = now() - make_interval(mins => $2) WHERE token_hash = $1`,
      [createHash('sha256').update(token).digest('hex'), minutes],
    );

  it('creates a pending session, activates it with a new id and CSRF token, and keeps the deadline', async () => {
    const token = await make();
    const pending = await sessions.resolve(token);
    expect(pending).toMatchObject({ state: 'pending-org', active: null, issuer: ISS });
    const next = await sessions.activate(token, { orgId: ORG, role: 'clinician' });
    expect(next).not.toBeNull();
    expect(await sessions.resolve(token)).toBeNull(); // the old id stops at once
    const active = await sessions.resolve(next ?? '');
    expect(active).toMatchObject({ state: 'active', active: { orgId: ORG, role: 'clinician' } });
    expect(active?.csrfToken).not.toBe(pending?.csrfToken);
    expect(active?.createdAt).toBe(pending?.createdAt);
    expect(await sessions.activate('x'.repeat(43), { orgId: ORG, role: 'clinician' })).toBeNull();
  });

  it('never extends the idle time on background reads or background activation', async () => {
    const token = await make();
    await age(token, 10);
    const quiet = await sessions.resolve(token, { touch: false });
    expect(Date.now() - (quiet?.lastSeenAt ?? 0)).toBeGreaterThan(9 * 60_000);
    const next = await sessions.activate(
      token,
      { orgId: ORG, role: 'clinician' },
      { touch: false },
    );
    const after = await sessions.resolve(next ?? '', { touch: false });
    expect(Date.now() - (after?.lastSeenAt ?? 0)).toBeGreaterThan(9 * 60_000);
    // Idle beyond 15 minutes: gone.
    await age(next ?? '', 16);
    expect(await sessions.resolve(next ?? '')).toBeNull();
  });

  it('records a revalidation, revokes, and logs out by Keycloak session or subject', async () => {
    const token = await make('sid-a', 'sub-a');
    await sessions.recordRevalidation(token, { wrappedKey: 'w2', envelope: 'v1.d.e.f' });
    expect((await sessions.resolve(token))?.refresh).toEqual({
      wrappedKey: 'w2',
      envelope: 'v1.d.e.f',
    });
    await sessions.recordRevalidation('y'.repeat(43), { wrappedKey: 'x', envelope: 'x' });
    const other = await make('sid-b', 'sub-a');
    expect(await sessions.revokeMatching(ISS, { sid: 'sid-a' })).toBe(1);
    expect(await sessions.resolve(token)).toBeNull();
    expect(await sessions.revokeMatching(ISS, { sub: 'sub-a' })).toBe(1);
    expect(await sessions.resolve(other)).toBeNull();
    const last = await make();
    await sessions.revoke(last);
    expect(await sessions.resolve(last)).toBeNull();
  });
});
