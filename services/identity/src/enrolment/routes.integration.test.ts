import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import { DevKeyManager, FieldCipher, InMemoryPatientKeyStore } from '@endo/crypto';
import { testDatabaseUrl } from '@endo/db';
import { uuidv7 } from '@endo/domain';
import {
  WorkloadTokenSigner,
  WorkloadTokenVerifier,
  generateServiceKeyPair,
} from '@endo/service-kit';
import { buildIdentity } from '../app.ts';
import { InMemoryPersonStore } from '../persons.ts';
import { ClinicalUnavailableError, type ClinicalClient, type LiveInvitation } from './clinical.ts';
import { EnrolmentCodes } from './code.ts';
import { PostgresEnrolmentStore } from './store.ts';
import { setupIdentityTestDb, type TestIdentityDb } from './test-db.ts';

const url = testDatabaseUrl();
const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = () => hex(randomBytes(32).toString('hex'));

describe.skipIf(!url)(
  'REQ-001, RISK-S05 ADR-0021 patient enrolment routes (patient BFF only)',
  () => {
    let t: TestIdentityDb;
    let app: FastifyInstance;
    let store: PostgresEnrolmentStore;
    const audit = new InMemoryAuditStore();
    const logs: string[] = [];
    const kms = new DevKeyManager('test');
    /** Link tokens the fake API knows: token hash -> invitation. */
    const links = new Map<string, LiveInvitation>();
    let apiDown = false;
    let clock: () => Date = () => new Date();
    let patientKey: Awaited<ReturnType<typeof generateServiceKeyPair>>;
    let clinicKey: Awaited<ReturnType<typeof generateServiceKeyPair>>;

    const clinical: ClinicalClient = {
      find: (h) =>
        apiDown
          ? Promise.reject(new ClinicalUnavailableError())
          : Promise.resolve(links.get(h) ?? null),
    };

    /** A new live link; its token carries the PHI marker, which must never be recorded. */
    function newLink(reserved = false) {
      const token = `SYNTHETIC_PHI_MARKER-${randomBytes(8).toString('hex')}`;
      const invitation = { invitationId: uuidv7(), orgId: uuidv7(), reserved };
      links.set(hex(token), invitation);
      return { tokenHash: hex(token), ...invitation };
    }

    beforeAll(async () => {
      t = await setupIdentityTestDb(url!, 'routes');
      store = new PostgresEnrolmentStore(t.db);
      patientKey = await generateServiceKeyPair();
      clinicKey = await generateServiceKeyPair();
      app = await buildIdentity({
        logLevel: 'info',
        verifier: new WorkloadTokenVerifier('identity', {
          'bff-patient': {
            publicJwk: patientKey.publicJwk,
            scopes: ['identity.enrolment.patient'],
          },
          'bff-clinic': { publicJwk: clinicKey.publicJwk, scopes: ['identity.subject.resolve'] },
        }),
        audit: new AuditWriter(audit),
        persons: new InMemoryPersonStore(
          new FieldCipher(kms, new InMemoryPatientKeyStore(), 'kms/identity'),
        ),
        idpIssuer: 'https://idp.test/realms/endo',
        enrolment: { store, codes: new EnrolmentCodes(kms), clinical, now: () => clock() },
        logStream: { write: (m: string) => logs.push(m) },
      });
    });

    afterAll(async () => {
      await app.close();
      await t.close();
    });

    const asPatient = async () => ({
      authorization: `Bearer ${await new WorkloadTokenSigner(patientKey.privateJwk, 'bff-patient').sign(['identity.enrolment.patient'], 'identity')}`,
    });
    const post = async (path: string, payload: object, headers?: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: `/internal/v1/enrolment/transactions${path}`,
        headers: headers ?? (await asPatient()),
        payload,
      });
    const start = (tokenHash: string, binding: string) =>
      post('', { token_hash: tokenHash, binding_hash: binding });

    it('starts a transaction and shows its code once', async () => {
      const link = newLink();
      const binding = secret();
      const res = await start(link.tokenHash, binding);
      expect(res.statusCode).toBe(201);
      const body = res.json<{ transaction_id: string; code: string; status: string }>();
      expect(body).toMatchObject({ status: 'awaiting-confirmation', expired: false });
      expect(body.code).toMatch(/^[0-9]{6}$/);
      // Queued with its audit event, about this transaction and organisation.
      const queued = await t.relay.query<{ event: { action: string; org_id: string } }>(
        "SELECT event FROM audit_outbox WHERE event->'resource'->>'id' = $1",
        [body.transaction_id],
      );
      expect(queued.rows.map((r) => r.event)).toEqual([
        expect.objectContaining({ action: 'identity.enrolment.started', org_id: link.orgId }),
      ]);

      // Again from the same browser: the same transaction, and no code.
      const again = await start(link.tokenHash, binding);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ transaction_id: body.transaction_id });
      expect(again.json()).not.toHaveProperty('code');

      // From another browser: a separate transaction with a different code.
      const other = await start(link.tokenHash, secret());
      expect(other.statusCode).toBe(201);
      expect(other.json<{ code: string }>().code).not.toBe(body.code);
    });

    it('refuses links that are not live, reserved or locked, and fails closed without the API', async () => {
      expect((await start(hex('unknown'), secret())).statusCode).toBe(404);
      expect((await start(newLink(true).tokenHash, secret())).statusCode).toBe(409);

      const link = newLink();
      for (let i = 0; i < 5; i++)
        await store.confirmByCode(
          { invitationId: link.invitationId, orgId: link.orgId, code: '999999' },
          () => Promise.resolve(false),
          () => new Date(),
          (e) => ({
            id: uuidv7(),
            action: `test.${e.kind}`,
            resource: { id: 'invitationId' in e ? e.invitationId : e.after.id },
          }),
        );
      const locked = await start(link.tokenHash, secret());
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({
        type: 'https://errors.glucorp.health/enrolment.locked',
      });

      apiDown = true;
      try {
        expect((await start(newLink().tokenHash, secret())).statusCode).toBe(503);
      } finally {
        apiDown = false;
      }
    });

    it('gives two simultaneous Starts from one browser one transaction and one code', async () => {
      const link = newLink();
      const binding = secret();
      const [a, b] = await Promise.all([
        start(link.tokenHash, binding),
        start(link.tokenHash, binding),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
      expect(a.json<{ transaction_id: string }>().transaction_id).toBe(
        b.json<{ transaction_id: string }>().transaction_id,
      );
      expect([a, b].filter((r) => 'code' in r.json<object>())).toHaveLength(1);
    });

    it('refuses a fourth browser while three wait for confirmation', async () => {
      const link = newLink();
      for (let i = 0; i < 3; i++)
        expect((await start(link.tokenHash, secret())).statusCode).toBe(201);
      const fourth = await start(link.tokenHash, secret());
      expect(fourth.statusCode).toBe(409);
      expect(fourth.json()).toMatchObject({ type: 'https://errors.glucorp.health/enrolment.busy' });
    });

    it('answers status and cancel only to the browser that started it', async () => {
      const link = newLink();
      const binding = secret();
      const id = (await start(link.tokenHash, binding)).json<{ transaction_id: string }>()
        .transaction_id;

      const status = await post(`/${id}/status`, { binding_hash: binding });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ transaction_id: id, status: 'awaiting-confirmation' });
      expect(status.json()).not.toHaveProperty('code');

      // A wrong binding and an unknown transaction look the same.
      const wrong = await post(`/${id}/status`, { binding_hash: secret() });
      const unknown = await post(`/${uuidv7()}/status`, { binding_hash: binding });
      expect(wrong.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(wrong.json<{ type: string }>().type).toBe(unknown.json<{ type: string }>().type);
      expect((await post(`/${id}/cancel`, { binding_hash: secret() })).statusCode).toBe(404);
      expect((await store.get(id))?.tx.status).toBe('awaiting-confirmation');

      const cancelled = await post(`/${id}/cancel`, { binding_hash: binding });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({ status: 'cancelling' });
      expect((await store.get(id))?.tx.cancelReason).toBe('patient-cancelled');
      // Repeating it changes nothing.
      expect((await post(`/${id}/cancel`, { binding_hash: binding })).json()).toMatchObject({
        status: 'cancelling',
      });
    });

    it('reports a passed deadline', async () => {
      const binding = secret();
      const id = (await start(newLink().tokenHash, binding)).json<{ transaction_id: string }>()
        .transaction_id;
      clock = () => new Date(Date.now() + 16 * 60_000);
      try {
        const res = await post(`/${id}/status`, { binding_hash: binding });
        expect(res.json()).toMatchObject({ status: 'awaiting-confirmation', expired: true });
      } finally {
        clock = () => new Date();
      }
    });

    it('refuses every caller but the patient BFF with its scope', async () => {
      const link = newLink();
      const body = { token_hash: link.tokenHash, binding_hash: secret() };
      expect((await post('', body, {})).statusCode).toBe(401);
      const clinic = {
        authorization: `Bearer ${await new WorkloadTokenSigner(clinicKey.privateJwk, 'bff-clinic').sign(['identity.subject.resolve'], 'identity')}`,
      };
      expect((await post('', body, clinic)).statusCode).toBe(403);
      expect(
        (await audit.readRange(1, 500)).some(
          (e) =>
            e.action === 'identity.enrolment.start' &&
            e.outcome === 'denied' &&
            e.resource.type === 'enrolment_transaction',
        ),
      ).toBe(true);
    });

    it('never records a code, a token, its hash or a browser binding', async () => {
      const link = newLink();
      const binding = secret();
      const res = await start(link.tokenHash, binding);
      const { code } = res.json<{ code: string }>();
      await post(`/${res.json<{ transaction_id: string }>().transaction_id}/status`, {
        binding_hash: binding,
      });
      const outbox = await t.relay.query<{ event: unknown }>('SELECT event FROM audit_outbox');
      const recorded =
        logs.join('') + JSON.stringify(await audit.readRange(1, 500)) + JSON.stringify(outbox.rows);
      for (const s of ['SYNTHETIC_PHI_MARKER', link.tokenHash, binding])
        expect(recorded).not.toContain(s);
      // The code is six digits, which could appear by chance inside an id; look for it as a value.
      expect(recorded).not.toContain(`"${code}"`);
    });
  },
);
