import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Kysely } from 'kysely';
import { createDb, createPool, runMigrations, testDatabaseUrl } from '@endo/db';
import { uuidv7 } from '@endo/domain';
import { IDENTITY_MIGRATIONS_DIR, type IdentityDatabase } from '@endo/identity-store';
import { PostgresEnrolmentStore, type OutboxEvent } from './store.ts';
import {
  startTransaction,
  type ConsentDecisions,
  type EnrolmentEvent,
  type EnrolmentTransaction,
} from './state-machine.ts';

const url = testDatabaseUrl();
const SUBJECT = 'kc-subject-synthetic';
const sealed = { wrappedKey: 'd3JhcHBlZA', mac: 'bWFj' };
const binding = () => createHash('sha256').update(randomBytes(32)).digest('hex');

describe.skipIf(!url)('REQ-001, RISK-S05 ADR-0021 enrolment transaction store', () => {
  let admin: pg.Pool;
  let relay: pg.Pool;
  let db: Kysely<IdentityDatabase>;
  let store: PostgresEnrolmentStore;

  beforeAll(async () => {
    const schema = `enrol_${randomBytes(6).toString('hex')}`;
    const pw = Object.fromEntries(
      ['owner', 'api', 'relay'].map((k) => [k, randomBytes(16).toString('hex')]),
    );
    const at = (user: string, password: string) => {
      const u = new URL(url!);
      u.username = user;
      u.password = password;
      u.searchParams.set('options', `-c search_path=${schema}`);
      return u.toString();
    };
    const bootstrap = await readFile(
      fileURLToPath(
        new URL('../../../../packages/identity-store/bootstrap/roles.sql', import.meta.url),
      ),
      'utf8',
    );
    const su = new pg.Client({ connectionString: url });
    await su.connect();
    try {
      await su.query(bootstrap);
      for (const [role, password, extra] of [
        ['enrol_owner_test', pw['owner']!, ''],
        ['enrol_api_test', pw['api']!, 'IN ROLE endo_identity_app'],
        ['enrol_relay_test', pw['relay']!, 'IN ROLE endo_identity_relay'],
      ] as const) {
        const exists = await su.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        // Role names and hex passwords are fixed or generated here, never external input.
        if (exists.rowCount === 0)
          await su.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' ${extra}`);
        else await su.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
      }
      await su.query(`CREATE SCHEMA ${schema} AUTHORIZATION enrol_owner_test`);
    } finally {
      await su.end();
    }
    const owner = createPool(at('enrol_owner_test', pw['owner']!), {
      applicationName: 'endo-test',
      max: 1,
    });
    try {
      await runMigrations(owner, IDENTITY_MIGRATIONS_DIR);
    } finally {
      await owner.end();
    }
    const base = new URL(url!);
    admin = new pg.Pool({ connectionString: at(base.username, base.password) });
    relay = new pg.Pool({ connectionString: at('enrol_relay_test', pw['relay']!) });
    db = createDb<IdentityDatabase>(
      createPool(at('enrol_api_test', pw['api']!), { applicationName: 'endo-test' }),
    );
    store = new PostgresEnrolmentStore(db);
  });

  afterAll(async () => {
    await db.destroy();
    await relay.end();
    await admin.end();
  });

  const audit = (action: string, txId: string): OutboxEvent => ({
    id: uuidv7(),
    action,
    resource: { type: 'enrolment_transaction', id: txId },
  });
  const auditStep = (_: EnrolmentTransaction, after: EnrolmentTransaction) =>
    audit(`identity.enrolment.${after.status}`, after.id);
  const queued = async (id: string) =>
    (await relay.query('SELECT 1 FROM audit_outbox WHERE id = $1', [id])).rowCount;

  async function newTransaction(now = new Date()) {
    const tx = startTransaction({ id: uuidv7(), invitationId: uuidv7(), orgId: uuidv7(), now });
    const started = audit('identity.enrolment.started', tx.id);
    await store.create(tx, { bindingHash: binding(), code: sealed }, started);
    return { tx, started };
  }

  async function step(id: string, event: EnrolmentEvent, now = new Date()) {
    const r = await store.apply(id, event, () => now, auditStep);
    if (!r.ok) throw new Error(`${event.type} refused: ${r.reason}`);
    return r;
  }

  const decisions = (now: Date): ConsentDecisions => ({
    self_tracking: { status: 'granted', version: 3, decidedAt: now },
    share_with_care_team: { status: 'granted', version: 2, decidedAt: now },
    research_deidentified: { status: 'declined', version: 1, decidedAt: now },
    org_aggregate_reporting: { status: 'declined', version: 1, decidedAt: now },
  });

  it('creates a transaction with its code and audit event, and reads it back', async () => {
    const { tx, started } = await newTransaction();
    expect(await queued(started.id)).toBe(1);
    const stored = await store.get(tx.id);
    expect(stored).toMatchObject({ tx: { ...tx }, code: sealed, version: 1 });
    expect(await store.get(uuidv7())).toBeNull();
  });

  it('walks to active, clearing the code after confirmation and keeping her decisions', async () => {
    const { tx } = await newTransaction();
    const now = new Date();
    const confirmed = await step(tx.id, { type: 'confirm' });
    expect(confirmed.tx.status).toBe('confirmed');
    expect((await store.get(tx.id))?.code).toBeNull();

    await step(tx.id, { type: 'redeem', provisionalSubject: SUBJECT });
    await step(tx.id, { type: 'credential-committed' });
    await step(tx.id, { type: 'callback', subject: SUBJECT, credentialCommitted: false });
    const personId = uuidv7();
    const patientId = uuidv7();
    await step(tx.id, { type: 'consent', decisions: decisions(now), personId, patientId });
    await step(tx.id, { type: 'claim-result', result: 'succeeded' });
    for (const s of [1, 2, 3] as const)
      await step(tx.id, { type: 'activation-step-done', step: s });

    const done = await store.get(tx.id);
    expect(done?.tx).toMatchObject({ status: 'active', personId, patientId, activationStep: 3 });
    expect(done?.tx.decisions).toEqual(decisions(now));
    // One version per change: nine events after creation.
    expect(done?.version).toBe(1 + 9);
  });

  it('writes nothing for a refusal or a repeat', async () => {
    const { tx } = await newTransaction();
    expect(
      await store.apply(
        tx.id,
        { type: 'redeem', provisionalSubject: SUBJECT },
        () => new Date(),
        auditStep,
      ),
    ).toEqual({ ok: false, reason: 'wrong-state' });
    const cancel = await store.apply(
      tx.id,
      { type: 'cancel', reason: 'patient-cancelled' },
      () => new Date(),
      auditStep,
    );
    expect(cancel).toMatchObject({ ok: true, changed: true });
    const event = audit('repeat', tx.id);
    const repeat = await store.apply(
      tx.id,
      { type: 'cancel', reason: 'deadline' },
      () => new Date(),
      () => event,
    );
    expect(repeat).toMatchObject({
      ok: true,
      changed: false,
      tx: { cancelReason: 'patient-cancelled' },
    });
    expect(await queued(event.id)).toBe(0);
    expect((await store.get(tx.id))?.version).toBe(2);
    expect(await store.apply(uuidv7(), { type: 'confirm' }, () => new Date(), auditStep)).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('serialises concurrent events on one transaction: exactly one confirm wins', async () => {
    const { tx } = await newTransaction();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.apply(tx.id, { type: 'confirm' }, () => new Date(), auditStep),
      ),
    );
    expect(results.filter((r) => r.ok && r.changed)).toHaveLength(1);
    expect((await store.get(tx.id))?.version).toBe(2);
  });

  it('lists overdue pre-claim transactions for the deadline sweep', async () => {
    const { tx } = await newTransaction();
    const later = new Date(tx.startedAt.getTime() + 16 * 60_000);
    expect(await store.listOverdue(later, 1000)).toContain(tx.id);
    expect(await store.listOverdue(new Date(tx.startedAt.getTime() + 60_000), 1000)).not.toContain(
      tx.id,
    );
    await step(tx.id, { type: 'cancel', reason: 'deadline' }, later);
    expect(await store.listOverdue(later, 1000)).not.toContain(tx.id);
  });

  describe('the database refuses what the state machine never produces', () => {
    /** One admin transaction: a direct UPDATE, plus an audit event naming the transaction. */
    async function asAdminWithAudit(txId: string, text: string, params: unknown[] = []) {
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query(text, [txId, ...params]);
        await c.query('INSERT INTO audit_outbox (id, event) VALUES ($1, $2)', [
          uuidv7(),
          JSON.stringify(audit('test.direct', txId)),
        ]);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally {
        c.release();
      }
    }

    const cancelColumns = {
      status: 'cancelling',
      cancel_reason: 'deadline',
      state_deadline: null,
      code_mac: null,
      code_wrapped_key: null,
    };

    it('refuses any change without its audit event in the same transaction', async () => {
      const { tx } = await newTransaction();
      await expect(
        db
          .updateTable('enrolment_transaction')
          .set(cancelColumns)
          .where('id', '=', tx.id)
          .execute(),
      ).rejects.toThrow(/without its audit event/);
      // An event about another transaction does not count.
      await expect(
        db.transaction().execute(async (trx) => {
          await trx
            .insertInto('audit_outbox')
            .values({ id: uuidv7(), event: JSON.stringify(audit('x', uuidv7())) })
            .execute();
          await trx
            .updateTable('enrolment_transaction')
            .set(cancelColumns)
            .where('id', '=', tx.id)
            .execute();
        }),
      ).rejects.toThrow(/without its audit event/);
      expect((await store.get(tx.id))?.tx.status).toBe('awaiting-confirmation');
    });

    it('keeps deadlines: present before claiming, never moved or past the absolute deadline', async () => {
      const { tx } = await newTransaction();
      await expect(
        asAdminWithAudit(
          tx.id,
          "UPDATE enrolment_transaction SET status = 'confirmed', code_mac = NULL, code_wrapped_key = NULL, state_deadline = NULL WHERE id = $1",
        ),
      ).rejects.toThrow(/check constraint/);
      await expect(
        asAdminWithAudit(
          tx.id,
          "UPDATE enrolment_transaction SET state_deadline = state_deadline + interval '1 minute' WHERE id = $1",
        ),
      ).rejects.toThrow(/cannot be moved|not allowed/);
      await expect(
        asAdminWithAudit(
          tx.id,
          "UPDATE enrolment_transaction SET status = 'confirmed', code_mac = NULL, code_wrapped_key = NULL, state_deadline = expires_at + interval '1 minute' WHERE id = $1",
        ),
      ).rejects.toThrow(/check constraint|cannot be moved/);
    });

    it('accepts decisions only in full, and only at consent', async () => {
      const { tx } = await newTransaction();
      await expect(
        asAdminWithAudit(tx.id, "UPDATE enrolment_transaction SET decisions = '{}' WHERE id = $1"),
      ).rejects.toThrow(/check constraint|written once|not allowed/);
      await step(tx.id, { type: 'confirm' });
      await step(tx.id, { type: 'redeem', provisionalSubject: SUBJECT });
      await step(tx.id, { type: 'callback', subject: SUBJECT, credentialCommitted: true });
      const at = new Date().toISOString();
      const three = JSON.stringify({
        self_tracking: { status: 'granted', version: 1, decided_at: at },
        share_with_care_team: { status: 'granted', version: 1, decided_at: at },
        research_deidentified: { status: 'declined', version: 1, decided_at: at },
      });
      await expect(
        asAdminWithAudit(
          tx.id,
          "UPDATE enrolment_transaction SET status = 'claiming', state_deadline = NULL, decisions = $2, person_id = gen_random_uuid(), patient_id = gen_random_uuid() WHERE id = $1",
          [three],
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it('never skips activation, and never rewrites a cancellation reason', async () => {
      const { tx } = await newTransaction();
      const now = new Date();
      for (const e of [
        { type: 'confirm' },
        { type: 'redeem', provisionalSubject: SUBJECT },
        { type: 'callback', subject: SUBJECT, credentialCommitted: true },
        { type: 'consent', decisions: decisions(now), personId: uuidv7(), patientId: uuidv7() },
        { type: 'claim-result', result: 'succeeded' },
      ] as EnrolmentEvent[])
        await step(tx.id, e);
      await expect(
        asAdminWithAudit(tx.id, "UPDATE enrolment_transaction SET status = 'active' WHERE id = $1"),
      ).rejects.toThrow(/every activation step|check constraint/);

      const { tx: other } = await newTransaction();
      await step(other.id, { type: 'cancel', reason: 'patient-cancelled' });
      await expect(
        asAdminWithAudit(
          other.id,
          "UPDATE enrolment_transaction SET status = 'cancelled', cancel_reason = 'deadline' WHERE id = $1",
        ),
      ).rejects.toThrow(/written once/);
    });

    it('writes a cancel request once and clears it when claiming ends', async () => {
      const { tx } = await newTransaction();
      const now = new Date();
      for (const e of [
        { type: 'confirm' },
        { type: 'redeem', provisionalSubject: SUBJECT },
        { type: 'callback', subject: SUBJECT, credentialCommitted: true },
        { type: 'consent', decisions: decisions(now), personId: uuidv7(), patientId: uuidv7() },
        { type: 'cancel', reason: 'clinician-revoked' },
      ] as EnrolmentEvent[])
        await step(tx.id, e);
      await expect(
        asAdminWithAudit(
          tx.id,
          "UPDATE enrolment_transaction SET cancel_requested = 'patient-cancelled' WHERE id = $1",
        ),
      ).rejects.toThrow(/written once/);
      const done = await step(tx.id, { type: 'cancel-resolved', result: 'released' });
      expect(done.tx).toMatchObject({
        status: 'cancelling',
        cancelReason: 'clinician-revoked',
        cancelRequested: null,
      });
    });

    it('judges deadlines at the time the locked change runs, not when it was requested', async () => {
      const { tx } = await newTransaction();
      const late = new Date(tx.startedAt.getTime() + 16 * 60_000);
      // The request was made in time, but the clock read under the lock is past the deadline.
      expect(await store.apply(tx.id, { type: 'confirm' }, () => late, auditStep)).toEqual({
        ok: false,
        reason: 'expired',
      });
    });

    it('refuses a transition outside the section 10 table', async () => {
      const { tx } = await newTransaction();
      await expect(
        admin.query(`UPDATE enrolment_transaction SET status = 'active' WHERE id = $1`, [tx.id]),
      ).rejects.toThrow(/not allowed|check constraint/);
      // A legal transition, written directly, still needs its audit event in the same transaction.
      await asAdminWithAudit(
        tx.id,
        `UPDATE enrolment_transaction SET status = 'cancelling', cancel_reason = 'deadline', state_deadline = NULL, code_mac = NULL, code_wrapped_key = NULL WHERE id = $1`,
      );
      await expect(
        admin.query(
          `UPDATE enrolment_transaction SET status = 'awaiting-confirmation' WHERE id = $1`,
          [tx.id],
        ),
      ).rejects.toThrow(/not allowed/);
    });

    it('never changes a final transaction or its identity', async () => {
      const { tx } = await newTransaction();
      await step(tx.id, { type: 'cancel', reason: 'deadline' });
      await expect(
        admin.query(`UPDATE enrolment_transaction SET binding_hash = $2 WHERE id = $1`, [
          tx.id,
          binding(),
        ]),
      ).rejects.toThrow(/identity is fixed/);
      await step(tx.id, { type: 'cleanup-done' });
      await expect(
        admin.query(`UPDATE enrolment_transaction SET state_deadline = now() WHERE id = $1`, [
          tx.id,
        ]),
      ).rejects.toThrow(/final/);
    });

    it('writes decisions and claim ids once, and moves activation forward one step at a time', async () => {
      const { tx } = await newTransaction();
      const now = new Date();
      for (const e of [
        { type: 'confirm' },
        { type: 'redeem', provisionalSubject: SUBJECT },
        { type: 'credential-committed' },
        { type: 'callback', subject: SUBJECT, credentialCommitted: false },
        { type: 'consent', decisions: decisions(now), personId: uuidv7(), patientId: uuidv7() },
        { type: 'claim-result', result: 'succeeded' },
      ] as EnrolmentEvent[])
        await step(tx.id, e);
      await expect(
        admin.query(`UPDATE enrolment_transaction SET person_id = $2 WHERE id = $1`, [
          tx.id,
          uuidv7(),
        ]),
      ).rejects.toThrow(/written once/);
      await expect(
        admin.query(`UPDATE enrolment_transaction SET decisions = '{}' WHERE id = $1`, [tx.id]),
      ).rejects.toThrow(/written once/);
      await expect(
        admin.query(`UPDATE enrolment_transaction SET activation_step = 2 WHERE id = $1`, [tx.id]),
      ).rejects.toThrow(/one at a time/);
    });

    it('starts only awaiting confirmation, at the database time, and gives the service no delete', async () => {
      const tx = startTransaction({
        id: uuidv7(),
        invitationId: uuidv7(),
        orgId: uuidv7(),
        now: new Date(),
      });
      await expect(
        store.create(
          { ...tx, status: 'confirmed' },
          { bindingHash: binding(), code: sealed },
          audit('x', tx.id),
        ),
      ).rejects.toThrow(/starts awaiting confirmation|check constraint/);
      const old = new Date(Date.now() - 10 * 60_000);
      await expect(
        store.create(
          startTransaction({ id: uuidv7(), invitationId: uuidv7(), orgId: uuidv7(), now: old }),
          { bindingHash: binding(), code: sealed },
          audit('x', uuidv7()),
        ),
      ).rejects.toThrow(/start time is not now/);
      const { tx: kept } = await newTransaction();
      await expect(
        db.deleteFrom('enrolment_transaction').where('id', '=', kept.id).execute(),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db
          .updateTable('enrolment_transaction')
          .set({ version: 99 } as never)
          .where('id', '=', kept.id)
          .execute(),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
