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
import {
  ClinicalUnavailableError,
  type ClaimInput,
  type ClinicalClient,
  type ConsentsInput,
  type LiveInvitation,
} from './clinical.ts';
import { Activator } from './activation.ts';
import { Cleaner } from './cleanup.ts';
import { enrolmentAudit } from './routes.ts';
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
    let claimAnswer: 'done' | 'refused' | 'down' = 'done';
    const claimed: ClaimInput[] = [];
    const consentsWritten: ConsentsInput[] = [];
    const released: string[] = [];
    const revoked: string[] = [];
    let releaseAnswer: 'released' | 'claimed' | 'down' = 'released';
    const clinical: ClinicalClient = {
      find: (h) =>
        apiDown
          ? Promise.reject(new ClinicalUnavailableError())
          : Promise.resolve(links.get(h) ?? null),
      claim: (r) => {
        claimed.push(r);
        return claimAnswer === 'down'
          ? Promise.reject(new ClinicalUnavailableError())
          : Promise.resolve(claimAnswer);
      },
      consents: (r) => {
        consentsWritten.push(r);
        return Promise.resolve();
      },
      release: (r) => {
        released.push(r.transactionId);
        return releaseAnswer === 'down'
          ? Promise.reject(new ClinicalUnavailableError())
          : Promise.resolve(releaseAnswer);
      },
      revokeHeld: (r) => {
        revoked.push(r.transactionId);
        return Promise.resolve('done');
      },
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

      it('resumes the same provisional user after a lost callback, and refuses expired handoffs', async () => {
        const { id, binding } = await confirmed();
        const req = request();
        const ref = (await handoff(id, binding, req)).json<{ handoff_ref: string }>().handoff_ref;
        const subject = (await redeem(ref, req)).json<{ provisional_subject: string }>()
          .provisional_subject;
        // A resume handoff (section 11) authenticates the same provisional user; no transition.
        const again = request('resume');
        const resumeRef = (await handoff(id, binding, again)).json<{ handoff_ref: string }>()
          .handoff_ref;
        const resumed = await redeem(resumeRef, again, { ...kcSession, tab_id: 'tab-9' });
        expect(resumed.json()).toEqual({
          transaction_id: id,
          provisional_subject: subject,
          kind: 'resume',
        });
        expect((await store.get(id))?.tx.status).toBe('redeemed');
        // An enrol handoff is no longer possible once redeemed.
        expect((await handoff(id, binding, request('enrol'))).statusCode).toBe(409);

        // A handoff past its five minutes is refused.
        const late = request('resume');
        const lateRef = (await handoff(id, binding, late)).json<{ handoff_ref: string }>()
          .handoff_ref;
        const c = await t.admin.connect();
        try {
          await c.query("SET session_replication_role = 'replica'");
          await c.query(
            "UPDATE enrolment_handoff SET created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' WHERE ref_hash = $1",
            [createHash('sha256').update(lateRef).digest('hex')],
          );
        } finally {
          await c.query("SET session_replication_role = 'origin'");
          c.release();
        }
        expect((await redeem(lateRef, late)).statusCode).toBe(403);
      });

      /** A transaction at consent-pending: confirmed, redeemed, passkey committed, called back. */
      async function consentPending() {
        const { id, binding } = await confirmed();
        const req = request();
        const ref = (await handoff(id, binding, req)).json<{ handoff_ref: string }>().handoff_ref;
        const subject = (await redeem(ref, req)).json<{ provisional_subject: string }>()
          .provisional_subject;
        await app.inject({
          method: 'POST',
          url: `/internal/v1/enrolment/transactions/${id}/credential-committed`,
          headers: await asKeycloak(),
        });
        await post(`/${id}/callback`, { binding_hash: binding, subject });
        return { id, binding };
      }
      const decisions = (selfTracking: 'granted' | 'declined' = 'granted', at = new Date()) => ({
        self_tracking: { status: selfTracking, version: 1, decided_at: at.toISOString() },
        share_with_care_team: { status: 'granted', version: 1, decided_at: at.toISOString() },
        research_deidentified: { status: 'declined', version: 1, decided_at: at.toISOString() },
        org_aggregate_reporting: { status: 'declined', version: 1, decided_at: at.toISOString() },
      });

      it('records all four decisions and moves on to claiming; declining self-tracking ends it', async () => {
        const a = await consentPending();
        const res = await post(`/${a.id}/consent`, {
          binding_hash: a.binding,
          decisions: decisions(),
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ status: 'claiming' });
        const stored = (await store.get(a.id))?.tx;
        expect(stored?.decisions?.share_with_care_team).toMatchObject({
          status: 'granted',
          version: 1,
        });
        expect(stored?.personId).toMatch(/^[0-9a-f-]{36}$/);
        expect(stored?.patientId).toMatch(/^[0-9a-f-]{36}$/);

        const b = await consentPending();
        const declined = await post(`/${b.id}/consent`, {
          binding_hash: b.binding,
          decisions: decisions('declined'),
        });
        expect(declined.json()).toMatchObject({ status: 'cancelling' });
        expect((await store.get(b.id))?.tx.cancelReason).toBe('declined');
      });

      it('activates: claim, person and link, consents, Keycloak; one durable step at a time', async () => {
        const a = await consentPending();
        await post(`/${a.id}/consent`, { binding_hash: a.binding, decisions: decisions() });
        const finalised: string[] = [];
        let keycloakUp = false;
        const activator = new Activator({
          store,
          clinical,
          keycloak: {
            finalise: (subject) => {
              if (!keycloakUp) return Promise.resolve(false);
              finalised.push(subject);
              return Promise.resolve(true);
            },
          },
          now: () => new Date(),
          audit: (action, tx) => enrolmentAudit(action, tx, 'test'),
        });
        // Keycloak not reachable yet: it stops before step 3, quarantined, never half-active.
        expect(await activator.run(a.id)).toBe('waiting');
        const mid = (await store.get(a.id))?.tx;
        expect(mid).toMatchObject({ status: 'activating', activationStep: 2 });
        expect(claimed.find((c) => c.transactionId === a.id)).toMatchObject({
          patientId: mid?.patientId,
          identityRef: mid?.personId,
        });
        const person = await t.admin.query<{ idp_subject: string }>(
          'SELECT idp_subject FROM person WHERE id = $1',
          [mid?.personId],
        );
        expect(person.rows[0]?.idp_subject).toBe(mid?.provisionalSubject);
        const link = await t.admin.query(
          'SELECT 1 FROM patient_link WHERE patient_record_id = $1',
          [mid?.patientId],
        );
        expect(link.rowCount).toBe(1);
        const written = consentsWritten.find((c) => c.patientId === mid?.patientId);
        expect(written?.decisions.map((d) => [d.purpose, d.status, d.version])).toEqual([
          ['self_tracking', 'granted', 1],
          ['share_with_care_team', 'granted', 1],
          ['research_deidentified', 'declined', 1],
          ['org_aggregate_reporting', 'declined', 1],
        ]);
        keycloakUp = true;
        expect(await activator.run(a.id)).toBe('active');
        expect(finalised).toEqual([mid?.provisionalSubject]);
        expect((await store.get(a.id))?.tx).toMatchObject({ status: 'active', activationStep: 3 });
        // Running again changes nothing.
        expect(await activator.run(a.id)).toBe('active');
      });

      it('cancels on a definite claim refusal, and waits on an unknown outcome', async () => {
        const activator = new Activator({
          store,
          clinical,
          keycloak: null,
          now: () => new Date(),
          audit: (action, tx) => enrolmentAudit(action, tx, 'test'),
        });
        const a = await consentPending();
        await post(`/${a.id}/consent`, { binding_hash: a.binding, decisions: decisions() });
        claimAnswer = 'down';
        try {
          expect(await activator.run(a.id)).toBe('waiting');
          expect((await store.get(a.id))?.tx.status).toBe('claiming');
          claimAnswer = 'refused';
          expect(await activator.run(a.id)).toBe('cancelling');
          expect((await store.get(a.id))?.tx.cancelReason).toBe('claim-refused');
        } finally {
          claimAnswer = 'done';
        }
        // The sweep finds work only in claiming or activating.
        await activator.sweep();
      });

      describe('ADR-0021 section 11: cancellation and cleanup', () => {
        const deleted: string[] = [];
        let keycloakUp = true;
        const cleaner = (now: () => Date = () => new Date()) =>
          new Cleaner({
            store,
            clinical,
            keycloak: {
              deleteProvisional: (subject) => {
                if (!keycloakUp) return Promise.resolve(false);
                deleted.push(subject);
                return Promise.resolve(true);
              },
            },
            now,
            audit: (action, tx) => enrolmentAudit(action, tx, 'test'),
          });

        it('after a decline: deletes the provisional user, revokes, releases, then cancelled', async () => {
          const a = await consentPending();
          await post(`/${a.id}/consent`, {
            binding_hash: a.binding,
            decisions: decisions('declined'),
          });
          const subject = (await store.get(a.id))?.tx.provisionalSubject;
          keycloakUp = false;
          try {
            // Keycloak unreachable: nothing further happens, and it is retried.
            expect(await cleaner().run(a.id)).toBe('waiting');
            expect((await store.get(a.id))?.tx.status).toBe('cancelling');
            expect(revoked).not.toContain(a.id);
          } finally {
            keycloakUp = true;
          }
          expect(await cleaner().run(a.id)).toBe('cancelled');
          expect(deleted).toContain(subject);
          expect(revoked).toContain(a.id);
          expect(released).toContain(a.id);
          expect((await store.get(a.id))?.tx.status).toBe('cancelled');
          expect(await cleaner().run(a.id)).toBe('cancelled');
        });

        it('a cancel during claiming: the clinical store decides between cleanup and activation', async () => {
          const claimingWithCancel = async () => {
            const a = await consentPending();
            await post(`/${a.id}/consent`, { binding_hash: a.binding, decisions: decisions() });
            expect((await post(`/${a.id}/cancel`, { binding_hash: a.binding })).statusCode).toBe(
              200,
            );
            expect((await store.get(a.id))?.tx).toMatchObject({
              status: 'claiming',
              cancelRequested: 'patient-cancelled',
            });
            return a;
          };
          // The release won: no claim can succeed any more, so it is cleaned up.
          const a = await claimingWithCancel();
          releaseAnswer = 'down';
          try {
            expect(await cleaner().run(a.id)).toBe('waiting');
            expect((await store.get(a.id))?.tx.status).toBe('claiming');
          } finally {
            releaseAnswer = 'released';
          }
          expect(await cleaner().run(a.id)).toBe('cancelled');
          expect((await store.get(a.id))?.tx).toMatchObject({
            status: 'cancelled',
            cancelReason: 'patient-cancelled',
          });
          // She did not decline: the invitation is released for the clinic, not revoked.
          expect(revoked).not.toContain(a.id);

          // The claim had already won: activation goes on; she leaves by account deletion.
          const b = await claimingWithCancel();
          releaseAnswer = 'claimed';
          try {
            expect(await cleaner().run(b.id)).toBe('activating');
          } finally {
            releaseAnswer = 'released';
          }
          expect((await store.get(b.id))?.tx).toMatchObject({
            status: 'activating',
            cancelRequested: null,
          });
          // Activation then runs as usual; a failing step is retried, never skipped.
          const activator = (consentsDown: boolean) =>
            new Activator({
              store,
              clinical: {
                ...clinical,
                consents: (r) =>
                  consentsDown
                    ? Promise.reject(new ClinicalUnavailableError())
                    : clinical.consents(r),
              },
              keycloak: { finalise: () => Promise.resolve(true) },
              now: () => new Date(),
              audit: (action, tx) => enrolmentAudit(action, tx, 'test'),
            });
          expect(await activator(true).run(b.id)).toBe('waiting');
          expect((await store.get(b.id))?.tx.activationStep).toBe(1);
          expect(await activator(false).run(b.id)).toBe('active');
        });

        it('waits rather than guesses: no Keycloak, a claim reported after cancelling, nothing to do', async () => {
          const a = await consentPending();
          await post(`/${a.id}/consent`, {
            binding_hash: a.binding,
            decisions: decisions('declined'),
          });
          // A provisional user exists but Keycloak is not configured: never marked cancelled.
          const noKeycloak = new Cleaner({
            store,
            clinical,
            keycloak: null,
            now: () => new Date(),
            audit: (action, tx) => enrolmentAudit(action, tx, 'test'),
          });
          expect(await noKeycloak.run(a.id)).toBe('waiting');
          // The clinical store reporting a won claim for a cancelled enrolment: it stops there.
          releaseAnswer = 'claimed';
          try {
            expect(await cleaner().run(a.id)).toBe('waiting');
          } finally {
            releaseAnswer = 'released';
          }
          expect((await store.get(a.id))?.tx.status).toBe('cancelling');
          expect(await cleaner().run(a.id)).toBe('cancelled');
          // Nothing to clean up: unknown, or an enrolment still under way.
          expect(await cleaner().run(uuidv7())).toBe('nothing');
          expect(await cleaner().run((await confirmed()).id)).toBe('nothing');
        });

        it('cancels a transaction past its deadline and cleans it up on the sweep', async () => {
          const a = await confirmed();
          const later = () => new Date(Date.now() + 61 * 60_000);
          for (let i = 0; i < 5 && (await store.get(a.id))?.tx.status !== 'cancelled'; i++)
            await cleaner(later).sweep();
          expect((await store.get(a.id))?.tx).toMatchObject({
            status: 'cancelled',
            cancelReason: 'deadline',
          });
          expect(released).toContain(a.id);
          // Nothing was redeemed, so there was no Keycloak user to delete.
          expect(revoked).not.toContain(a.id);
        });
      });

      it('refuses missing decisions, future times, another browser, or the wrong moment', async () => {
        const a = await consentPending();
        const partial: Record<string, unknown> = decisions();
        delete partial['research_deidentified'];
        expect(
          (await post(`/${a.id}/consent`, { binding_hash: a.binding, decisions: partial }))
            .statusCode,
        ).toBe(400);
        const future = decisions('granted', new Date(Date.now() + 3_600_000));
        expect(
          (await post(`/${a.id}/consent`, { binding_hash: a.binding, decisions: future }))
            .statusCode,
        ).toBe(400);
        expect(
          (await post(`/${a.id}/consent`, { binding_hash: secret(), decisions: decisions() }))
            .statusCode,
        ).toBe(404);
        const early = await confirmed();
        expect(
          (
            await post(`/${early.id}/consent`, {
              binding_hash: early.binding,
              decisions: decisions(),
            })
          ).statusCode,
        ).toBe(409);
      });

      it('lets Keycloak register a passkey only while the redeemed enrolment is live', async () => {
        const { id, binding } = await confirmed();
        const req = request();
        const ref = (await handoff(id, binding, req)).json<{ handoff_ref: string }>().handoff_ref;
        const subject = (await redeem(ref, req)).json<{ provisional_subject: string }>()
          .provisional_subject;
        const check = async (s: string) =>
          app.inject({
            method: 'POST',
            url: `/internal/v1/enrolment/transactions/${id}/registration-check`,
            headers: await asKeycloak(),
            payload: { subject: s },
          });
        expect((await check(subject)).json()).toEqual({ allowed: true });
        expect((await check(uuidv7())).statusCode).toBe(409);
        // She cancels from another tab: registration stops, and a retried redemption is refused.
        expect((await post(`/${id}/cancel`, { binding_hash: binding })).statusCode).toBe(200);
        expect((await check(subject)).statusCode).toBe(409);
        expect((await redeem(ref, req)).statusCode).toBe(403);
      });

      it('retries an unknown reservation at Continue: reserved, refused, or unreachable', async () => {
        // The clinic confirms, but the reservation's outcome is unknown (the API timed out).
        async function confirmedUnreserved() {
          const link = newLink();
          const binding = secret();
          const started = (await start(link.tokenHash, binding)).json<{
            transaction_id: string;
            code: string;
          }>();
          reserveAnswer = 'down';
          try {
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
            expect(res.statusCode).toBe(503);
          } finally {
            reserveAnswer = 'done';
          }
          expect(await store.isReserved(started.transaction_id)).toBe(false);
          return { id: started.transaction_id, binding };
        }
        const ok = await confirmedUnreserved();
        expect((await handoff(ok.id, ok.binding)).statusCode).toBe(201);
        expect(await store.isReserved(ok.id)).toBe(true);

        const refused = await confirmedUnreserved();
        reserveAnswer = 'refused';
        try {
          expect((await handoff(refused.id, refused.binding)).statusCode).toBe(409);
        } finally {
          reserveAnswer = 'done';
        }
        expect((await store.get(refused.id))?.tx.cancelReason).toBe('claim-refused');

        const down = await confirmedUnreserved();
        reserveAnswer = 'down';
        try {
          expect((await handoff(down.id, down.binding)).statusCode).toBe(503);
        } finally {
          reserveAnswer = 'done';
        }
        expect(await store.isReserved(down.id)).toBe(false);
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
