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

    /** What the fake API answers to the next reserve: done, refused, or down. */
    let reserveAnswer: 'done' | 'refused' | 'down' = 'done';
    const reserved: string[] = [];
    const clinical: ClinicalClient = {
      find: (h) =>
        apiDown
          ? Promise.reject(new ClinicalUnavailableError())
          : Promise.resolve(links.get(h) ?? null),
      reserve: (r) => {
        reserved.push(r.transactionId);
        return reserveAnswer === 'down'
          ? Promise.reject(new ClinicalUnavailableError())
          : Promise.resolve(reserveAnswer);
      },
    };
    let apiKey: Awaited<ReturnType<typeof generateServiceKeyPair>>;
    let kcKey: Awaited<ReturnType<typeof generateServiceKeyPair>>;

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
      apiKey = await generateServiceKeyPair();
      kcKey = await generateServiceKeyPair();
      app = await buildIdentity({
        logLevel: 'info',
        verifier: new WorkloadTokenVerifier('identity', {
          'bff-patient': {
            publicJwk: patientKey.publicJwk,
            scopes: ['identity.enrolment.patient'],
          },
          'bff-clinic': { publicJwk: clinicKey.publicJwk, scopes: ['identity.subject.resolve'] },
          api: { publicJwk: apiKey.publicJwk, scopes: ['identity.enrolment.clinic'] },
          keycloak: { publicJwk: kcKey.publicJwk, scopes: ['identity.enrolment.keycloak'] },
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

    describe('ADR-0021 sections 2 and 3: the clinic confirms by code (API caller only)', () => {
      const CLINICIAN = '01900000-0000-7000-8000-0000000000c1';
      const asApi = async () => ({
        authorization: `Bearer ${await new WorkloadTokenSigner(apiKey.privateJwk, 'api').sign(['identity.enrolment.clinic'], 'identity')}`,
      });
      const confirm = async (
        link: { invitationId: string; orgId: string },
        code: string,
        headers?: Record<string, string>,
      ) =>
        app.inject({
          method: 'POST',
          url: '/internal/v1/enrolment/confirm',
          headers: headers ?? (await asApi()),
          payload: {
            org_id: link.orgId,
            invitation_id: link.invitationId,
            code,
            clinician_id: CLINICIAN,
            attestation: { identified: true, own_phone: true },
          },
        });
      async function started() {
        const link = newLink();
        const res = await start(link.tokenHash, secret());
        const body = res.json<{ transaction_id: string; code: string }>();
        return { link, id: body.transaction_id, code: body.code };
      }
      const wrongFor = (code: string) => (code === '000000' ? '000001' : '000000');

      it('confirms the right code, reserves the invitation, and audits the clinician', async () => {
        reserveAnswer = 'done';
        const { link, id, code } = await started();
        const res = await confirm(link, code);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ outcome: 'confirmed' });
        expect(reserved).toContain(id);
        expect((await store.get(id))?.tx.status).toBe('confirmed');
        const outbox = await t.relay.query<{ event: { action: string; actor: unknown } }>(
          "SELECT event FROM audit_outbox WHERE event->'resource'->>'id' = $1",
          [id],
        );
        expect(outbox.rows.map((r) => r.event)).toContainEqual(
          expect.objectContaining({
            action: 'identity.enrolment.confirmed_attested',
            actor: { id: CLINICIAN, role: 'clinician' },
          }),
        );
      });

      it('counts a wrong code against the invitation, and never records the code', async () => {
        const { link, id, code } = await started();
        const res = await confirm(link, wrongFor(code));
        expect(res.json()).toEqual({ outcome: 'wrong', remaining: 4 });
        expect((await store.get(id))?.tx.status).toBe('awaiting-confirmation');
        const outbox = await t.relay.query('SELECT event FROM audit_outbox');
        expect(JSON.stringify(outbox.rows)).not.toContain(`"${wrongFor(code)}"`);
      });

      it('cancels when the invitation can no longer be reserved, and says it is unavailable', async () => {
        reserveAnswer = 'refused';
        try {
          const { link, id, code } = await started();
          expect((await confirm(link, code)).json()).toEqual({ outcome: 'unavailable' });
          expect((await store.get(id))?.tx).toMatchObject({
            status: 'cancelling',
            cancelReason: 'claim-refused',
          });
        } finally {
          reserveAnswer = 'done';
        }
      });

      it('fails closed when the API cannot be reached, leaving the confirmation in place', async () => {
        reserveAnswer = 'down';
        try {
          const { link, id, code } = await started();
          expect((await confirm(link, code)).statusCode).toBe(503);
          expect((await store.get(id))?.tx.status).toBe('confirmed');
        } finally {
          reserveAnswer = 'done';
        }
      });

      it('answers only the API, and refuses a missing attestation', async () => {
        const { link, code } = await started();
        const patientBff = {
          authorization: `Bearer ${await new WorkloadTokenSigner(patientKey.privateJwk, 'bff-patient').sign(['identity.enrolment.patient'], 'identity')}`,
        };
        expect((await confirm(link, code, patientBff)).statusCode).toBe(403);
        expect((await confirm(link, code, {})).statusCode).toBe(401);
        const noAttestation = await app.inject({
          method: 'POST',
          url: '/internal/v1/enrolment/confirm',
          headers: await asApi(),
          payload: {
            org_id: link.orgId,
            invitation_id: link.invitationId,
            code,
            clinician_id: CLINICIAN,
            attestation: { identified: true, own_phone: false },
          },
        });
        expect(noAttestation.statusCode).toBe(400);
        // And the API cannot start transactions (that is the patient BFF's scope).
        const startAsApi = await app.inject({
          method: 'POST',
          url: '/internal/v1/enrolment/transactions',
          headers: await asApi(),
          payload: { token_hash: link.tokenHash, binding_hash: secret() },
        });
        expect(startAsApi.statusCode).toBe(403);
      });
    });

    describe('ADR-0021 sections 5 to 7: the handoff into Keycloak', () => {
      const ISSUER = 'https://idp.test/realms/endo';
      const request = (kind: 'enrol' | 'resume' = 'enrol') => ({
        kind,
        issuer: ISSUER,
        client_id: 'bff-patient',
        redirect_uri: 'https://app.test/auth/callback',
        code_challenge: 'C'.repeat(43),
        state: `state-${randomBytes(8).toString('hex')}`,
        nonce: `nonce-${randomBytes(8).toString('hex')}`,
      });
      const kcSession = { root_session_id: 'root-1', client_uuid: 'client-1', tab_id: 'tab-1' };
      const as = async (key: typeof kcKey, who: 'keycloak' | 'api', scope: string) => ({
        authorization: `Bearer ${await new WorkloadTokenSigner(key.privateJwk, who).sign([scope], 'identity')}`,
      });
      const asKeycloak = () => as(kcKey, 'keycloak', 'identity.enrolment.keycloak');

      /** A transaction the clinic has confirmed, with its browser binding. */
      async function confirmed() {
        const link = newLink();
        const binding = secret();
        const started = (await start(link.tokenHash, binding)).json<{
          transaction_id: string;
          code: string;
        }>();
        const res = await app.inject({
          method: 'POST',
          url: '/internal/v1/enrolment/confirm',
          headers: await as(apiKey, 'api', 'identity.enrolment.clinic'),
          payload: {
            org_id: link.orgId,
            invitation_id: link.invitationId,
            code: started.code,
            clinician_id: '01900000-0000-7000-8000-0000000000c1',
            attestation: { identified: true, own_phone: true },
          },
        });
        expect(res.json()).toEqual({ outcome: 'confirmed' });
        return { id: started.transaction_id, binding };
      }
      const handoff = async (id: string, binding: string, req = request()) =>
        post(`/${id}/handoff`, { binding_hash: binding, ...req });
      const redeem = async (ref: string, req: object, session = kcSession) =>
        app.inject({
          method: 'POST',
          url: '/internal/v1/enrolment/handoffs/redeem',
          headers: await asKeycloak(),
          payload: { handoff_ref: ref, session, ...req },
        });

      it('hands off once, redeems once for one Keycloak session, then follows the passkey', async () => {
        const { id, binding } = await confirmed();
        const req = request();
        const h = await handoff(id, binding, req);
        expect(h.statusCode).toBe(201);
        const ref = h.json<{ handoff_ref: string }>().handoff_ref;
        expect(ref).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const first = await redeem(ref, req);
        expect(first.statusCode).toBe(200);
        const out = first.json<{ transaction_id: string; provisional_subject: string }>();
        expect(out).toMatchObject({ transaction_id: id, kind: 'enrol' });
        expect((await store.get(id))?.tx).toMatchObject({
          status: 'redeemed',
          provisionalSubject: out.provisional_subject,
        });
        // The same Keycloak session retrying gets the same answer; any other session is refused.
        expect((await redeem(ref, req)).json()).toEqual(first.json());
        expect((await redeem(ref, req, { ...kcSession, tab_id: 'tab-2' })).statusCode).toBe(403);

        // The callback must wait for the passkey to be committed.
        const early = await post(`/${id}/callback`, {
          binding_hash: binding,
          subject: out.provisional_subject,
        });
        expect(early.statusCode).toBe(409);
        const committed = await app.inject({
          method: 'POST',
          url: `/internal/v1/enrolment/transactions/${id}/credential-committed`,
          headers: await asKeycloak(),
        });
        expect(committed.json()).toEqual({ status: 'credential-committed' });
        const wrongSubject = await post(`/${id}/callback`, {
          binding_hash: binding,
          subject: 'other',
        });
        expect(wrongSubject.statusCode).toBe(403);
        const cb = await post(`/${id}/callback`, {
          binding_hash: binding,
          subject: out.provisional_subject,
        });
        expect(cb.statusCode).toBe(200);
        expect(cb.json()).toMatchObject({ status: 'consent-pending' });
      });

      it('refuses a handoff before confirmation, for another browser, or for another issuer', async () => {
        const link = newLink();
        const binding = secret();
        const id = (await start(link.tokenHash, binding)).json<{ transaction_id: string }>()
          .transaction_id;
        expect((await handoff(id, binding)).statusCode).toBe(409);
        const ok = await confirmed();
        expect((await handoff(ok.id, secret())).statusCode).toBe(404);
        expect(
          (await handoff(ok.id, ok.binding, { ...request(), issuer: 'https://evil.test' }))
            .statusCode,
        ).toBe(400);
      });

      it('refuses a redemption that differs from the handoff in any bound value, or is unknown', async () => {
        const { id, binding } = await confirmed();
        const req = request();
        const ref = (await handoff(id, binding, req)).json<{ handoff_ref: string }>().handoff_ref;
        for (const changed of [
          { ...req, client_id: 'other-client' },
          { ...req, redirect_uri: 'https://evil.test/cb' },
          { ...req, code_challenge: 'D'.repeat(43) },
          { ...req, state: `${req.state}x` },
          { ...req, nonce: `${req.nonce}x` },
          { ...req, kind: 'resume' as const },
        ])
          expect((await redeem(ref, changed)).statusCode).toBe(403);
        expect((await redeem(randomBytes(32).toString('base64url'), req)).statusCode).toBe(403);
        // None of those consumed it.
        expect((await redeem(ref, req)).statusCode).toBe(200);
      });

      it('lets only Keycloak redeem, and never records the reference', async () => {
        const { id, binding } = await confirmed();
        const req = request();
        const ref = (await handoff(id, binding, req)).json<{ handoff_ref: string }>().handoff_ref;
        const asPatientBff = await asPatient();
        const res = await app.inject({
          method: 'POST',
          url: '/internal/v1/enrolment/handoffs/redeem',
          headers: asPatientBff,
          payload: { handoff_ref: ref, session: kcSession, ...req },
        });
        expect(res.statusCode).toBe(403);
        const outbox = await t.relay.query('SELECT event FROM audit_outbox');
        expect(JSON.stringify(outbox.rows) + logs.join('')).not.toContain(ref);
      });

      it('the database allows one redemption, never changes a binding, and caps the lifetime', async () => {
        const { id, binding } = await confirmed();
        const ref = (await handoff(id, binding)).json<{ handoff_ref: string }>().handoff_ref;
        const hash = createHash('sha256').update(ref).digest('hex');
        await expect(
          t.admin.query('UPDATE enrolment_handoff SET redirect_uri = $2 WHERE ref_hash = $1', [
            hash,
            'https://evil.test',
          ]),
        ).rejects.toThrow(/binding is fixed/);
        await expect(
          t.admin.query(
            "UPDATE enrolment_handoff SET expires_at = now() + interval '1 hour' WHERE ref_hash = $1",
            [hash],
          ),
        ).rejects.toThrow(/binding is fixed|check constraint/);
      });
    });
  },
);
