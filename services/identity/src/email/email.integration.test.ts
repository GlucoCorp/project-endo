import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevKeyManager } from '@endo/crypto';
import { testDatabaseUrl } from '@endo/db';
import { uuidv7 } from '@endo/domain';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { buildIdentity } from '../app.ts';
import { PostgresPersonStore } from '../persons.ts';
import { setupIdentityTestDb, type TestIdentityDb } from '../enrolment/test-db.ts';
import { EmailCodeStore, PER_ADDRESS_PER_HOUR, type AuditFn } from './store.ts';

const url = testDatabaseUrl();
const MARKER = 'synthetic_phi_marker';

describe.skipIf(!url)('REQ-001 ADR-0026 email one-time codes (identity vault)', () => {
  let t: TestIdentityDb;
  let store: EmailCodeStore;
  let persons: PostgresPersonStore;
  let next = '123456';
  const kms = new DevKeyManager('test');
  const audit: AuditFn = (action, id) => ({
    id: uuidv7(),
    actor: { id: null, role: 'system' },
    action,
    resource: { type: 'email_code', id },
    org_id: null,
    purpose_of_use: 'operations',
    outcome: 'success',
    reason: null,
    request_id: uuidv7(),
  });
  const actions = async (id: string) =>
    (
      await t.admin.query<{ action: string }>(
        `SELECT event->>'action' AS action FROM audit_outbox WHERE event->'resource'->>'id' = $1 ORDER BY id`,
        [id],
      )
    ).rows.map((r) => r.action);

  /** A patient (person with a sign-in subject and a patient record), as activation leaves her. */
  async function patient() {
    const id = uuidv7();
    await persons.create({ id, email: null, displayName: null });
    await t.admin.query(`UPDATE person SET idp_subject = $2 WHERE id = $1`, [id, `kc-${id}`]);
    await t.admin.query(
      `INSERT INTO patient_link (person_id, patient_record_id, org_id) VALUES ($1, $2, $3)`,
      [id, uuidv7(), uuidv7()],
    );
    return id;
  }
  /** Her address, confirmed through the code sent to it. */
  async function confirmed(personId: string, address: string) {
    const d = await store.issueConfirm(personId, address, '192.0.2.1', audit);
    expect(d.deliver).toEqual({ to: address.trim().toLowerCase(), code: next });
    expect(await store.verifyConfirm(personId, d.requestId, next, audit)).toBe(true);
  }

  beforeAll(async () => {
    t = await setupIdentityTestDb(url!, 'email');
    persons = new PostgresPersonStore(t.db, kms);
    store = new EmailCodeStore(t.db, kms, () => next);
  });
  afterAll(() => t.close());

  it('confirms her address, then signs her in with a code sent to it, once', async () => {
    const id = await patient();
    const address = `${MARKER}+${id}@example.test`;
    await confirmed(id, ` ${address.toUpperCase()} `);
    const row = await t.admin.query<{ email_index: string; email_encrypted: string }>(
      'SELECT email_index, email_encrypted FROM person WHERE id = $1',
      [id],
    );
    // Encrypted under her key, found only through the blind index.
    expect(row.rows[0]?.email_encrypted).not.toContain(MARKER);
    expect(row.rows[0]?.email_index).toBe(await store.index('address', address));

    next = '654321';
    const d = await store.issueSignIn(address, '192.0.2.2', audit);
    // Delivered to the address she confirmed (normalised), whatever case she typed.
    expect(d.deliver).toEqual({ to: address, code: '654321' });
    const stored = await t.admin.query<{ code_mac: string; pending_email: string | null }>(
      'SELECT code_mac, pending_email FROM email_code WHERE id = $1',
      [d.requestId],
    );
    expect(stored.rows[0]?.code_mac).not.toContain('654321');
    expect(await store.verifySignIn(d.requestId, '000000', audit)).toBeNull();
    expect(await store.verifySignIn(d.requestId, '654321', audit)).toBe(`kc-${id}`);
    // Used once.
    expect(await store.verifySignIn(d.requestId, '654321', audit)).toBeNull();
    expect(await actions(d.requestId)).toEqual([
      'identity.email_code.issued',
      'identity.email_code.wrong',
      'identity.email_code.used',
    ]);
    // Nothing identifying is ever in the outbox.
    const all = await t.admin.query<{ event: unknown }>('SELECT event FROM audit_outbox');
    expect(JSON.stringify(all.rows)).not.toContain(MARKER);
  });

  it('answers the same for an unknown address, and never a code', async () => {
    const d = await store.issueSignIn(`${MARKER}-nobody@example.test`, '192.0.2.3', audit);
    expect(d.deliver).toBeNull();
    expect(d.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.verifySignIn(d.requestId, next, audit)).toBeNull();
    expect(await actions(d.requestId)).toEqual(['identity.email_code.no_match']);
    // A confirmed address of someone who is not a patient (no record) gets no code either.
    const notPatient = uuidv7();
    await persons.create({ id: notPatient, email: null, displayName: null });
    await confirmed(notPatient, `staff-${notPatient}@example.test`);
    expect(
      (await store.issueSignIn(`staff-${notPatient}@example.test`, '192.0.2.4', audit)).deliver,
    ).toBeNull();
  });

  it('locks a code after five wrong entries, even for the right code', async () => {
    const id = await patient();
    await confirmed(id, `lock-${id}@example.test`);
    const d = await store.issueSignIn(`lock-${id}@example.test`, '192.0.2.5', audit);
    for (let i = 0; i < 5; i++)
      expect(await store.verifySignIn(d.requestId, '999999', audit)).toBeNull();
    expect(await store.verifySignIn(d.requestId, next, audit)).toBeNull();
    expect((await actions(d.requestId)).at(-1)).toBe('identity.email_code.locked');
  });

  it(`allows ${String(PER_ADDRESS_PER_HOUR)} requests per address an hour, then sends nothing`, async () => {
    const id = await patient();
    const address = `limit-${id}@example.test`;
    await confirmed(id, address);
    // The confirmation counted as one request for this address.
    for (let i = 1; i < PER_ADDRESS_PER_HOUR; i++)
      expect(
        (await store.issueSignIn(address, `198.51.100.${String(i)}`, audit)).deliver,
      ).not.toBeNull();
    const limited = await store.issueSignIn(address, '198.51.100.99', audit);
    expect(limited.deliver).toBeNull();
    expect(await actions(limited.requestId)).toEqual(['identity.email_code.limited']);
  });

  it('refuses a code for another person, and an address another account already uses', async () => {
    const a = await patient();
    const b = await patient();
    await confirmed(a, `shared-${a}@example.test`);
    const d = await store.issueConfirm(b, `shared-${a}@example.test`, '203.0.113.1', audit);
    expect(await store.verifyConfirm(a, d.requestId, next, audit)).toBe(false);
    expect(await store.verifyConfirm(b, d.requestId, next, audit)).toBe(false);
  });

  it('erasure: her address can no longer find her', async () => {
    const id = await patient();
    await confirmed(id, `erase-${id}@example.test`);
    await persons.erase(id);
    expect(
      (await store.issueSignIn(`erase-${id}@example.test`, '203.0.113.2', audit)).deliver,
    ).toBeNull();
  });

  it('the database keeps the rules: 10 minutes, no rewrites, no deletes, audited writes', async () => {
    const id = await patient();
    await confirmed(id, `db-${id}@example.test`);
    const d = await store.issueSignIn(`db-${id}@example.test`, '203.0.113.3', audit);
    const life = await t.admin.query<{ s: number }>(
      `SELECT EXTRACT(EPOCH FROM expires_at - created_at)::int AS s FROM email_code WHERE id = $1`,
      [d.requestId],
    );
    expect(life.rows[0]?.s).toBe(600);
    await expect(
      t.db.updateTable('email_code').set({ attempts: 3 }).where('id', '=', d.requestId).execute(),
    ).rejects.toThrow();
    await expect(
      t.db.deleteFrom('email_code').where('id', '=', d.requestId).execute(),
    ).rejects.toThrow();
    // Even the owner cannot write a code without its audit event.
    await expect(
      t.admin.query(
        `INSERT INTO email_code (id, purpose, address_index, source_index) VALUES ($1, 'sign-in', $2, $2)`,
        [uuidv7(), 'a'.repeat(64)],
      ),
    ).rejects.toThrow(/audit event/);
    // An expired code is final.
    const c = await t.admin.connect();
    try {
      await c.query("SET session_replication_role = 'replica'");
      await c.query(
        `UPDATE email_code SET created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' WHERE id = $1`,
        [d.requestId],
      );
    } finally {
      await c.query("SET session_replication_role = 'origin'");
      c.release();
    }
    expect(await store.verifySignIn(d.requestId, next, audit)).toBeNull();
  });

  it('routes: Keycloak signs in, the patient BFF confirms; nobody else, and no address leaks', async () => {
    const kc = await generateServiceKeyPair();
    const bff = await generateServiceKeyPair();
    const logs: string[] = [];
    const sent: { to: string; code: string; purpose: string }[] = [];
    const app = await buildIdentity({
      logLevel: 'info',
      logStream: { write: (m: string) => logs.push(m) },
      verifier: new WorkloadTokenVerifier('identity', {
        keycloak: { publicJwk: kc.publicJwk, scopes: ['identity.email_code.keycloak'] },
        'bff-patient': { publicJwk: bff.publicJwk, scopes: ['identity.email.patient'] },
      }),
      audit: new AuditWriter(new InMemoryAuditStore()),
      persons,
      idpIssuer: 'https://kc.test/realms/endo',
      email: {
        store,
        sender: {
          send: (to, code, purpose) => {
            sent.push({ to, code, purpose });
            return Promise.resolve(true);
          },
        },
      },
    });
    const as = async (key: typeof kc, who: 'keycloak' | 'bff-patient', scope: string) => ({
      authorization: `Bearer ${await new WorkloadTokenSigner(key.privateJwk, who).sign([scope], 'identity')}`,
    });
    const post = async (url: string, payload: object, headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: `/internal/v1/email-codes${url}`, payload, headers });
    const id = await patient();
    const address = `${MARKER}-route-${id}@example.test`;
    const bffAuth = await as(bff, 'bff-patient', 'identity.email.patient');
    const kcAuth = await as(kc, 'keycloak', 'identity.email_code.keycloak');

    next = '111222';
    const started = await post(
      '/confirm',
      { person_id: id, address, source_ip: '192.0.2.10' },
      bffAuth,
    );
    expect(started.statusCode).toBe(202);
    expect(sent.at(-1)).toEqual({ to: address, code: '111222', purpose: 'confirm' });
    const requestId = started.json<{ request_id: string }>().request_id;
    expect(started.body).not.toContain('111222');
    expect(
      (
        await post(
          '/confirm/verify',
          { person_id: id, request_id: requestId, code: '111222' },
          bffAuth,
        )
      ).statusCode,
    ).toBe(204);

    next = '333444';
    const signIn = await post('/sign-in', { address, source_ip: '192.0.2.11' }, kcAuth);
    expect(signIn.json()).toEqual({
      request_id: expect.any(String) as string,
      deliver: { to: address, code: '333444' },
    });
    const rid = signIn.json<{ request_id: string }>().request_id;
    const wrong = await post('/sign-in/verify', { request_id: rid, code: '000000' }, kcAuth);
    expect(wrong.statusCode).toBe(403);
    const ok = await post('/sign-in/verify', { request_id: rid, code: '333444' }, kcAuth);
    expect(ok.json()).toEqual({ subject: `kc-${id}` });
    // Each scope belongs to one caller: a valid token without it is forbidden.
    expect((await post('/sign-in', { address, source_ip: '192.0.2.12' }, bffAuth)).statusCode).toBe(
      403,
    );
    expect(
      (await post('/confirm', { person_id: id, address, source_ip: '192.0.2.12' }, kcAuth))
        .statusCode,
    ).toBe(403);
    expect(
      (await post('/sign-in', { address: 'not an address', source_ip: '192.0.2.12' }, kcAuth))
        .statusCode,
    ).toBe(400);
    expect(logs.join('')).not.toContain(MARKER);
    await app.close();
  });

  it('routes: confirming an address is unavailable without a sender', async () => {
    const bff = await generateServiceKeyPair();
    const app = await buildIdentity({
      logLevel: 'silent',
      verifier: new WorkloadTokenVerifier('identity', {
        'bff-patient': { publicJwk: bff.publicJwk, scopes: ['identity.email.patient'] },
      }),
      audit: new AuditWriter(new InMemoryAuditStore()),
      persons,
      idpIssuer: 'https://kc.test/realms/endo',
      email: { store, sender: null },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/v1/email-codes/confirm',
      headers: {
        authorization: `Bearer ${await new WorkloadTokenSigner(bff.privateJwk, 'bff-patient').sign(['identity.email.patient'], 'identity')}`,
      },
      payload: { person_id: uuidv7(), address: 'a@example.test', source_ip: '192.0.2.13' },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
