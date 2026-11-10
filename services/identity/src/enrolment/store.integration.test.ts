import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { createDb, createPool, runMigrations, testDatabaseUrl } from '@endo/db';
import { uuidv7 } from '@endo/domain';
import { IDENTITY_MIGRATIONS_DIR, type IdentityDatabase } from '@endo/identity-store';
import { DevKeyManager } from '@endo/crypto';
import { EnrolmentCodes } from './code.ts';
import {
  PostgresEnrolmentStore,
  type CodeCheckAudit,
  type CodeMatcher,
  type OutboxEvent,
} from './store.ts';
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
/** A fixed stand-in code for tests that never check one. */
const fixedCode = () => Promise.resolve({ code: '123456', sealed });

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
    await store.create(tx, binding(), fixedCode, started);
    return { tx, started };
  }

  const codeAudit = (e: CodeCheckAudit): OutboxEvent =>
    'after' in e
      ? audit(`identity.enrolment.${e.kind}`, e.after.id)
      : {
          id: uuidv7(),
          action: `identity.enrolment.${e.kind}`,
          resource: { type: 'enrolment_invitation', id: e.invitationId },
        };
  const anyCode: CodeMatcher = () => Promise.resolve(true);

  /** Confirms a transaction the only way there is: through the code check. */
  async function confirm(tx: EnrolmentTransaction, now = new Date()) {
    const r = await store.confirmByCode(
      { invitationId: tx.invitationId, orgId: tx.orgId, code: '123456' },
      anyCode,
      () => now,
      codeAudit,
    );
    if (r.outcome !== 'confirmed') throw new Error(`confirm refused: ${r.outcome}`);
    return { ok: true as const, changed: true, tx: r.tx };
  }

  async function step(id: string, event: EnrolmentEvent, now = new Date()) {
    if (event.type === 'confirm') {
      const stored = await store.get(id);
      if (!stored) throw new Error('no such transaction');
      return confirm(stored.tx, now);
    }
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
    expect(
      await store.apply(uuidv7(), { type: 'credential-committed' }, () => new Date(), auditStep),
    ).toEqual({ ok: false, reason: 'not-found' });
  });

  it('confirms only through the code check', async () => {
    const { tx } = await newTransaction();
    await expect(
      store.apply(tx.id, { type: 'confirm' } as never, () => new Date(), auditStep),
    ).rejects.toThrow(/confirmByCode/);
    expect((await store.get(tx.id))?.tx.status).toBe('awaiting-confirmation');
  });

  it('refuses a stale deadline cancellation from the sweep', async () => {
    const { tx } = await newTransaction();
    const at = (min: number) => new Date(tx.startedAt.getTime() + min * 60_000);
    expect(await store.listOverdue(at(16), 10_000)).toContain(tx.id);
    // Before the sweep acts, the clinic confirms (at minute 10): a new 15-minute deadline.
    await confirm(tx, at(10));
    expect(
      await store.apply(tx.id, { type: 'cancel', reason: 'deadline' }, () => at(16), auditStep),
    ).toEqual({ ok: false, reason: 'not-overdue' });
    expect((await store.get(tx.id))?.tx.status).toBe('confirmed');
  });

  it('serialises concurrent events on one transaction: exactly one cancel changes it', async () => {
    const { tx } = await newTransaction();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.apply(
          tx.id,
          { type: 'cancel', reason: 'patient-cancelled' },
          () => new Date(),
          auditStep,
        ),
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

  describe('ADR-0021 section 3: the clinician code check', () => {
    const kms = new DevKeyManager('test');
    const codes = new EnrolmentCodes(kms);
    const realCode: CodeMatcher = (c, b, s) => codes.matches(c, b, s);

    /** Starts one transaction with a real code, drawn by `create` under the guard row. */
    async function startOne(invitationId: string, orgId: string, issuer: EnrolmentCodes) {
      const tx = startTransaction({ id: uuidv7(), invitationId, orgId, now: new Date() });
      const { code } = await store.create(
        tx,
        binding(),
        (pending) => issuer.issue({ invitationId, transactionId: tx.id }, pending),
        audit('identity.enrolment.started', tx.id),
      );
      return { tx, code };
    }

    /** Starts transactions on one invitation, each with a real code distinct from the others. */
    async function startOn(invitationId: string, orgId: string, n = 1) {
      const out: { tx: EnrolmentTransaction; code: string }[] = [];
      for (let i = 0; i < n; i++) {
        out.push(await startOne(invitationId, orgId, codes));
      }
      return out;
    }
    const wrongFor = (code: string) => (code === '000000' ? '000001' : '000000');
    const seen: CodeCheckAudit[] = [];
    const recording = (e: CodeCheckAudit) => {
      seen.push(e);
      return codeAudit(e);
    };
    const check = (invitationId: string, orgId: string, code: string, now = new Date()) =>
      store.confirmByCode({ invitationId, orgId, code }, realCode, () => now, recording);
    const guardOf = async (invitationId: string) =>
      (
        await admin.query(
          'SELECT wrong_attempts, locked_until FROM enrolment_invitation_guard WHERE invitation_id = $1',
          [invitationId],
        )
      ).rows[0] as { wrong_attempts: number; locked_until: Date | null } | undefined;

    it('gives concurrent starts on one invitation distinct codes', async () => {
      const inv = uuidv7();
      const org = uuidv7();
      // The guard row must exist already: on a first start, inserting it alone would serialise
      // the two starts. A wrong code creates it.
      await store.confirmByCode(
        { invitationId: inv, orgId: org, code: '999999' },
        anyCode,
        () => new Date(),
        codeAudit,
      );
      // Every draw is 111111 until two have been made: unserialised starts would share it.
      let draws = 0;
      const colliding = new EnrolmentCodes(kms, () => (draws++ < 2 ? '111111' : '222222'));
      // Force overlap: each start's draw waits (up to 1 s) for the other start to reach its draw.
      // Serialised, the second is held at the guard row, so the first goes on after the wait.
      let arrived = 0;
      const start = (tx: EnrolmentTransaction) =>
        store.create(
          tx,
          binding(),
          async (pending) => {
            arrived++;
            for (let i = 0; i < 20 && arrived < 2; i++) await new Promise((r) => setTimeout(r, 50));
            return colliding.issue({ invitationId: inv, transactionId: tx.id }, pending);
          },
          audit('identity.enrolment.started', tx.id),
        );
      const txs = [0, 1].map(() =>
        startTransaction({ id: uuidv7(), invitationId: inv, orgId: org, now: new Date() }),
      );
      const [a, b] = await Promise.all(txs.map(start));
      expect([a!.code, b!.code].sort()).toEqual(['111111', '222222']);
    });

    it('locks out without deadlocking against a concurrent cancel in another organisation', async () => {
      for (let round = 0; round < 8; round++) {
        const inv = uuidv7();
        const [a] = await startOn(inv, uuidv7());
        const [b] = await startOn(inv, uuidv7());
        const orgA = a!.tx.orgId;
        const wrong = ['000000', '000001', '000002'].find((c) => c !== a!.code && c !== b!.code)!;
        for (let i = 0; i < 4; i++) await check(inv, orgA, wrong);
        const [locked, cancelled] = await Promise.all([
          check(inv, orgA, wrong),
          store.apply(
            b!.tx.id,
            { type: 'cancel', reason: 'patient-cancelled' },
            () => new Date(),
            auditStep,
          ),
        ]);
        expect(locked.outcome).toBe('locked');
        expect(cancelled.ok).toBe(true);
        // Whichever ran first, b ended exactly once, and the lock left nothing pending.
        expect((await store.get(b!.tx.id))?.tx.status).toBe('cancelling');
        expect((await store.get(a!.tx.id))?.tx.status).toBe('cancelling');
      }
    });

    it('confirms nothing if a code ever matches two transactions', async () => {
      const inv = uuidv7();
      const org = uuidv7();
      const one = startTransaction({
        id: uuidv7(),
        invitationId: inv,
        orgId: org,
        now: new Date(),
      });
      const two = startTransaction({
        id: uuidv7(),
        invitationId: inv,
        orgId: org,
        now: new Date(),
      });
      for (const tx of [one, two])
        await store.create(tx, binding(), fixedCode, audit('identity.enrolment.started', tx.id));
      await expect(
        store.confirmByCode(
          { invitationId: inv, orgId: org, code: '123456' },
          anyCode,
          () => new Date(),
          codeAudit,
        ),
      ).rejects.toThrow(/more than one/);
      for (const tx of [one, two])
        expect((await store.get(tx.id))?.tx.status).toBe('awaiting-confirmation');
    });

    it('confirms the transaction whose code was typed and cancels its siblings', async () => {
      const inv = uuidv7();
      const org = uuidv7();
      const [a, b, c] = await startOn(inv, org, 3);
      const r = await check(inv, org, b!.code);
      expect(r).toMatchObject({ outcome: 'confirmed', tx: { id: b!.tx.id, status: 'confirmed' } });
      expect(r.outcome === 'confirmed' && [...r.cancelled].sort()).toEqual(
        [a!.tx.id, c!.tx.id].sort(),
      );
      expect((await store.get(b!.tx.id))?.code).toBeNull();
      for (const s of [a, c])
        expect((await store.get(s!.tx.id))?.tx).toMatchObject({
          status: 'cancelling',
          cancelReason: 'sibling-confirmed',
        });
      // Nothing counted against the invitation.
      expect(await guardOf(inv)).toMatchObject({ wrong_attempts: 0, locked_until: null });
    });

    it('counts wrong codes per invitation, across transactions, and locks at the fifth', async () => {
      const inv = uuidv7();
      const org = uuidv7();
      const [a, b] = await startOn(inv, org, 2);
      const wrong = [a!.code, b!.code].includes('000000')
        ? [a!.code, b!.code].includes('000001')
          ? '000002'
          : '000001'
        : '000000';
      for (const remaining of [4, 3, 2, 1])
        expect(await check(inv, org, wrong)).toEqual({ outcome: 'wrong', remaining });
      const before = Date.now();
      const locked = await check(inv, org, wrong);
      expect(locked.outcome).toBe('locked');
      if (locked.outcome !== 'locked') return;
      expect([...locked.cancelled].sort()).toEqual([a!.tx.id, b!.tx.id].sort());
      // 15 minutes by the database clock (allowing for the two clocks differing slightly).
      const ms = locked.lockedUntil.getTime() - before;
      expect(ms).toBeGreaterThan(14 * 60_000);
      expect(ms).toBeLessThan(16 * 60_000);
      for (const s of [a, b])
        expect((await store.get(s!.tx.id))?.tx).toMatchObject({
          status: 'cancelling',
          cancelReason: 'code-lockout',
        });
      expect(await guardOf(inv)).toMatchObject({ wrong_attempts: 0 });

      // While locked: even the right code is refused and nothing is counted, and nothing starts.
      const versionOf = async () =>
        (
          await admin.query<{ version: number }>(
            'SELECT version FROM enrolment_invitation_guard WHERE invitation_id = $1',
            [inv],
          )
        ).rows[0]?.version;
      const version = await versionOf();
      expect(await check(inv, org, a!.code)).toMatchObject({ outcome: 'locked', cancelled: [] });
      expect(await versionOf()).toBe(version);
      await expect(startOn(inv, org)).rejects.toThrow(/locked/);
    });

    it('never puts the typed code into an audit event', async () => {
      const inv = uuidv7();
      const org = uuidv7();
      const [a] = await startOn(inv, org);
      seen.length = 0;
      await check(inv, org, wrongFor(a!.code));
      await check(inv, org, a!.code);
      expect(seen.map((e) => e.kind)).toEqual(['wrong-code', 'confirmed']);
      const text = JSON.stringify(seen);
      expect(text).not.toContain(a!.code);
      expect(text).not.toContain(wrongFor(a!.code));
    });

    it("does not match another organisation's or an expired transaction", async () => {
      const inv = uuidv7();
      const org = uuidv7();
      const [a] = await startOn(inv, org);
      expect(await check(inv, uuidv7(), a!.code)).toMatchObject({ outcome: 'wrong' });
      const late = new Date(a!.tx.startedAt.getTime() + 16 * 60_000);
      expect(await check(inv, org, a!.code, late)).toMatchObject({ outcome: 'wrong' });
      expect((await store.get(a!.tx.id))?.tx.status).toBe('awaiting-confirmation');
      expect(await guardOf(inv)).toMatchObject({ wrong_attempts: 2 });
    });

    it('serialises concurrent entries: four wrong, then the lock, then refusals', async () => {
      const inv = uuidv7();
      const org = uuidv7();
      const [a] = await startOn(inv, org);
      const results = await Promise.all(
        Array.from({ length: 7 }, () => check(inv, org, wrongFor(a!.code))),
      );
      expect(results.filter((r) => r.outcome === 'wrong')).toHaveLength(4);
      const cancelledByLocks = results.flatMap((r) =>
        r.outcome === 'locked' ? [r.cancelled] : [],
      );
      expect(cancelledByLocks).toHaveLength(3);
      // Only the entry that locked it cancelled anything.
      expect(cancelledByLocks.map((c) => c.length).sort()).toEqual([0, 0, 1]);
    });

    it('lets exactly one of several concurrent right entries confirm', async () => {
      const inv = uuidv7();
      const org = uuidv7();
      const [a] = await startOn(inv, org);
      const results = await Promise.all(Array.from({ length: 3 }, () => check(inv, org, a!.code)));
      expect(results.filter((r) => r.outcome === 'confirmed')).toHaveLength(1);
      // Once it is confirmed nothing awaits confirmation, so a repeat is a wrong entry.
      expect(results.filter((r) => r.outcome === 'wrong')).toHaveLength(2);
    });

    it('lifts the lock after 15 minutes', async () => {
      const inv = uuidv7();
      const org = uuidv7();
      const [a] = await startOn(inv, org);
      for (let i = 0; i < 5; i++) await check(inv, org, wrongFor(a!.code));
      // Move the lock into the past directly (the guard trigger would refuse it, so bypass it).
      const c = await admin.connect();
      try {
        await c.query("SET session_replication_role = 'replica'");
        await c.query(
          "UPDATE enrolment_invitation_guard SET locked_until = now() - interval '1 second' WHERE invitation_id = $1",
          [inv],
        );
      } finally {
        await c.query("SET session_replication_role = 'origin'");
        c.release();
      }
      const [again] = await startOn(inv, org);
      expect(await check(inv, org, again!.code)).toMatchObject({ outcome: 'confirmed' });
    });

    describe('the database enforces the counter and the lock', () => {
      async function asAdmin(
        inv: string,
        statements: [string, unknown[]][],
        withAudit = true,
      ): Promise<void> {
        const c = await admin.connect();
        try {
          await c.query('BEGIN');
          for (const [text, params] of statements) await c.query(text, params);
          if (withAudit)
            await c.query('INSERT INTO audit_outbox (id, event) VALUES ($1, $2)', [
              uuidv7(),
              JSON.stringify({ id: uuidv7(), action: 'test.direct', resource: { id: inv } }),
            ]);
          await c.query('COMMIT');
        } catch (error) {
          await c.query('ROLLBACK');
          throw error;
        } finally {
          c.release();
        }
      }
      const plusOne: [string, unknown[]] = [
        'UPDATE enrolment_invitation_guard SET wrong_attempts = wrong_attempts + 1 WHERE invitation_id = $1',
        [],
      ];
      const on = (inv: string, s: [string, unknown[]]): [string, unknown[]] => [s[0], [inv]];

      it('gives the service no way to set the lock, skip the count or delete', async () => {
        const inv = uuidv7();
        const org = uuidv7();
        await startOn(inv, org);
        await expect(
          db
            .updateTable('enrolment_invitation_guard')
            .set({ locked_until: null } as never)
            .where('invitation_id', '=', inv)
            .execute(),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.deleteFrom('enrolment_invitation_guard').where('invitation_id', '=', inv).execute(),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db
            .insertInto('enrolment_invitation_guard')
            .values({ invitation_id: uuidv7(), wrong_attempts: 3 } as never)
            .execute(),
        ).rejects.toThrow(/permission denied/);
      });

      it('counts one at a time, never down, and only with an audit event', async () => {
        const inv = uuidv7();
        await startOn(inv, uuidv7());
        await expect(
          asAdmin(inv, [
            [
              'UPDATE enrolment_invitation_guard SET wrong_attempts = 2 WHERE invitation_id = $1',
              [inv],
            ],
          ]),
        ).rejects.toThrow(/one wrong code at a time/);
        await expect(asAdmin(inv, [on(inv, plusOne)], false)).rejects.toThrow(
          /without its audit event/,
        );
        await expect(asAdmin(inv, [on(inv, plusOne), on(inv, plusOne)])).rejects.toThrow(
          /one enrolment change per database transaction/,
        );
        await asAdmin(inv, [on(inv, plusOne)]);
        await expect(
          asAdmin(inv, [
            [
              'UPDATE enrolment_invitation_guard SET wrong_attempts = 0 WHERE invitation_id = $1',
              [inv],
            ],
          ]),
        ).rejects.toThrow(/one wrong code at a time/);
        expect(await guardOf(inv)).toMatchObject({ wrong_attempts: 1 });
      });

      it('refuses a lock that leaves a transaction awaiting confirmation', async () => {
        const inv = uuidv7();
        await startOn(inv, uuidv7());
        for (let i = 0; i < 4; i++) await asAdmin(inv, [on(inv, plusOne)]);
        await expect(asAdmin(inv, [on(inv, plusOne)])).rejects.toThrow(
          /no transaction awaiting confirmation/,
        );
        expect(await guardOf(inv)).toMatchObject({ wrong_attempts: 4, locked_until: null });
      });

      it('refuses a confirmation of a locked invitation, however it is written', async () => {
        const inv = uuidv7();
        const org = uuidv7();
        const [a] = await startOn(inv, org);
        for (let i = 0; i < 4; i++) await asAdmin(inv, [on(inv, plusOne)]);
        // Lock it the legitimate way, which cancels a; then start b in a past window.
        await check(inv, org, wrongFor(a!.code));
        const c = await admin.connect();
        let bId: string;
        try {
          await c.query("SET session_replication_role = 'replica'");
          await c.query(
            "UPDATE enrolment_invitation_guard SET locked_until = now() - interval '1 second' WHERE invitation_id = $1",
            [inv],
          );
          const [b] = await startOn(inv, org);
          bId = b!.tx.id;
          await c.query(
            "UPDATE enrolment_invitation_guard SET locked_until = now() + interval '10 minutes' WHERE invitation_id = $1",
            [inv],
          );
        } finally {
          await c.query("SET session_replication_role = 'origin'");
          c.release();
        }
        await expect(
          asAdminWithAuditOn(
            bId!,
            "UPDATE enrolment_transaction SET status = 'confirmed', code_mac = NULL, code_wrapped_key = NULL WHERE id = $1",
          ),
        ).rejects.toThrow(/invitation is locked/);
      });
    });

    /** A direct UPDATE of one enrolment transaction with an audit event naming it. */
    async function asAdminWithAuditOn(txId: string, text: string) {
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query(text, [txId]);
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

    it('rejects decisions with missing fields, fractional versions or bad times', async () => {
      const at = new Date().toISOString();
      const good = { status: 'granted', version: 1, decided_at: at };
      const valid = (d: unknown) =>
        admin
          .query<{ ok: boolean }>('SELECT enrolment_decisions_valid($1::jsonb) AS ok', [
            JSON.stringify(d),
          ])
          .then((r) => r.rows[0]?.ok);
      const all = (bad: unknown) => ({
        self_tracking: good,
        share_with_care_team: good,
        research_deidentified: good,
        org_aggregate_reporting: bad,
      });
      expect(await valid(all(good))).toBe(true);
      for (const bad of [
        { version: 1, decided_at: at },
        { status: 'granted', decided_at: at },
        { status: 'granted', version: 1 },
        { status: 'granted', version: 1.5, decided_at: at },
        { status: 'granted', version: 0, decided_at: at },
        { status: 'granted', version: 1, decided_at: 'yesterday' },
        { ...good, extra: true },
        null,
      ])
        expect(await valid(all(bad)), JSON.stringify(bad)).toBe(false);
    });

    it('allows one change per transaction row per database transaction', async () => {
      const { tx } = await newTransaction();
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          "UPDATE enrolment_transaction SET status = 'confirmed', code_mac = NULL, code_wrapped_key = NULL WHERE id = $1",
          [tx.id],
        );
        await expect(
          c.query(
            "UPDATE enrolment_transaction SET status = 'cancelling', cancel_reason = 'deadline', state_deadline = NULL WHERE id = $1",
            [tx.id],
          ),
        ).rejects.toThrow(/one enrolment change per database transaction/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('allows one change even across savepoints, and a rolled-back change frees the row', async () => {
      const { tx } = await newTransaction();
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query('INSERT INTO audit_outbox (id, event) VALUES ($1, $2)', [
          uuidv7(),
          JSON.stringify(audit('test.direct', tx.id)),
        ]);
        await c.query('SAVEPOINT a');
        await c.query(
          "UPDATE enrolment_transaction SET status = 'confirmed', code_mac = NULL, code_wrapped_key = NULL WHERE id = $1",
          [tx.id],
        );
        await c.query('SAVEPOINT b');
        await expect(
          c.query(
            "UPDATE enrolment_transaction SET status = 'cancelling', cancel_reason = 'deadline', state_deadline = NULL WHERE id = $1",
            [tx.id],
          ),
        ).rejects.toThrow(/one enrolment change per database transaction/);
        await c.query('ROLLBACK TO SAVEPOINT b');
        // Undo the first change too: the row may then change once more.
        await c.query('ROLLBACK TO SAVEPOINT a');
        await c.query(
          "UPDATE enrolment_transaction SET status = 'cancelling', cancel_reason = 'deadline', state_deadline = NULL, code_mac = NULL, code_wrapped_key = NULL WHERE id = $1",
          [tx.id],
        );
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally {
        c.release();
      }
      expect((await store.get(tx.id))?.tx.status).toBe('cancelling');
    });

    it('keeps change marks out of the service role reach', async () => {
      await expect(db.deleteFrom('enrolment_change_mark' as never).execute()).rejects.toThrow(
        /permission denied/,
      );
      const { tx } = await newTransaction();
      // The old session-setting trick no longer clears anything.
      await expect(
        db.transaction().execute(async (trx) => {
          await trx
            .insertInto('audit_outbox')
            .values({ id: uuidv7(), event: JSON.stringify(audit('x', tx.id)) })
            .execute();
          await trx
            .updateTable('enrolment_transaction')
            .set({ status: 'confirmed', code_mac: null, code_wrapped_key: null })
            .where('id', '=', tx.id)
            .execute();
          await trx
            .selectNoFrom((eb) =>
              eb
                .fn('set_config', [
                  eb.val(`endo_enrolment.changed_${tx.id.replaceAll('-', '')}`),
                  eb.val('0'),
                  eb.lit(true),
                ])
                .as('x'),
            )
            .execute();
          await trx
            .updateTable('enrolment_transaction')
            .set({ status: 'redeemed', provisional_subject: SUBJECT })
            .where('id', '=', tx.id)
            .execute();
        }),
      ).rejects.toThrow(/one enrolment change per database transaction/);
    });

    it('still allows one change if the audit check is forced to run early', async () => {
      const { tx } = await newTransaction();
      await expect(
        db.transaction().execute(async (trx) => {
          await trx
            .insertInto('audit_outbox')
            .values({ id: uuidv7(), event: JSON.stringify(audit('x', tx.id)) })
            .execute();
          await trx
            .updateTable('enrolment_transaction')
            .set({ status: 'confirmed', code_mac: null, code_wrapped_key: null })
            .where('id', '=', tx.id)
            .execute();
          await sql`SET CONSTRAINTS enrolment_transaction_audited IMMEDIATE`.execute(trx);
          await trx
            .updateTable('enrolment_transaction')
            .set({ status: 'redeemed', provisional_subject: SUBJECT })
            .where('id', '=', tx.id)
            .execute();
        }),
      ).rejects.toThrow(/one enrolment change per database transaction/);
    });

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
      expect(
        await store.apply(
          tx.id,
          { type: 'redeem', provisionalSubject: SUBJECT },
          () => late,
          auditStep,
        ),
      ).toEqual({ ok: false, reason: 'expired' });
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
      await step(tx.id, { type: 'cancel', reason: 'patient-cancelled' });
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
        store.create({ ...tx, status: 'confirmed' }, binding(), fixedCode, audit('x', tx.id)),
      ).rejects.toThrow(/starts awaiting confirmation|check constraint/);
      const old = new Date(Date.now() - 10 * 60_000);
      await expect(
        store.create(
          startTransaction({ id: uuidv7(), invitationId: uuidv7(), orgId: uuidv7(), now: old }),
          binding(),
          fixedCode,
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
