import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { importJWK, jwtVerify } from 'jose';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type ReminderEpisode,
  type ReminderStore,
  type Subscription,
} from '@endo/clinical-store';
import { DevKeyManager, EnvelopeSealer, FieldCipher, InMemoryPatientKeyStore } from '@endo/crypto';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  generateServiceKeyPair,
  type ServiceClaims,
} from '@endo/service-kit';
import { buildApi } from './app.ts';
import {
  ReminderService,
  endpointHash,
  isAllowedPushEndpoint,
  localTime,
  vapidAuthorization,
  vapidPublicKey,
  weekToRemind,
} from './reminders.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const PATIENT = '01900000-0000-7000-8000-0000000000a1';
const EPISODE = '01900000-0000-7000-8000-0000000000e5';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/SYNTHETIC_PHI_MARKER-device-7f3a';
const vapidKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const VAPID = {
  privateJwk: vapidKeys.privateKey.export({ format: 'jwk' }),
  subject: 'https://glucorp.example',
};
const kms = new DevKeyManager('test');
const keys = new InMemoryPatientKeyStore();
const cipherFor = () => new FieldCipher(kms, keys);

describe('spec 15 push endpoints: known push services only, over HTTPS', () => {
  it('accepts the major push services and nothing else', () => {
    for (const ok of [
      ENDPOINT,
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/x',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ])
      expect(isAllowedPushEndpoint(ok)).toBe(true);
    for (const bad of [
      'http://fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://evil.example/fcm.googleapis.com',
      'https://notify.windows.com/x',
      'https://169.254.169.254/latest',
      'not a url',
    ])
      expect(isAllowedPushEndpoint(bad)).toBe(false);
  });

  it('signs a VAPID token for the endpoint’s origin, with the operator contact, under 24 hours', async () => {
    const now = new Date('2026-11-15T18:00:00Z');
    const auth = await vapidAuthorization(ENDPOINT, VAPID, now);
    const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(auth);
    expect(m?.[2]).toBe(vapidPublicKey(VAPID.privateJwk));
    expect(Buffer.from(m?.[2] ?? '', 'base64url')).toHaveLength(65);
    const pub = await importJWK(vapidKeys.publicKey.export({ format: 'jwk' }), 'ES256');
    const { payload } = await jwtVerify(m?.[1] ?? '', pub, { currentDate: now });
    expect(payload.aud).toBe('https://fcm.googleapis.com');
    expect(payload.sub).toBe('https://glucorp.example');
    expect((payload.exp ?? 0) - now.getTime() / 1000).toBeLessThanOrEqual(24 * 3600);
  });
});

describe('spec 15 when to remind', () => {
  const ep = (o: Partial<ReminderEpisode> = {}): ReminderEpisode => ({
    episodeId: EPISODE,
    patientId: PATIENT,
    startDate: '2026-11-01',
    reviewIntervalWeeks: 12,
    timeZone: 'UTC',
    doneWeeks: [],
    remindedWeeks: [],
    ...o,
  });
  it('picks the first open week not done and not reminded', () => {
    expect(weekToRemind(ep(), '2026-11-07')).toBe(1);
    expect(weekToRemind(ep(), '2026-11-06')).toBeNull();
    expect(weekToRemind(ep({ doneWeeks: [1] }), '2026-11-07')).toBeNull();
    expect(weekToRemind(ep({ remindedWeeks: [1] }), '2026-11-07')).toBeNull();
    expect(weekToRemind(ep(), '2026-11-14')).toBe(1);
    expect(weekToRemind(ep({ doneWeeks: [1] }), '2026-11-14')).toBe(2);
  });
  it('reads her local date and hour', () => {
    expect(localTime(new Date('2026-11-15T15:30:00Z'), 'Africa/Nairobi')).toEqual({
      date: '2026-11-15',
      hour: 18,
    });
    expect(localTime(new Date('2026-11-15T23:30:00Z'), 'Africa/Nairobi')).toEqual({
      date: '2026-11-16',
      hour: 2,
    });
  });
});

class FakeReminders implements ReminderStore {
  subs: Subscription[] = [];
  readonly claimed = new Set<string>();
  readonly removed: string[] = [];
  episodesList: ReminderEpisode[] = [];
  subscribe(s: Parameters<ReminderStore['subscribe']>[0]) {
    this.subs = this.subs.filter((x) => x.patientId !== s.patientId);
    this.subs.push({
      id: s.id,
      patientId: s.patientId,
      endpointEncrypted: s.endpointEncrypted,
      remindHour: s.remindHour,
      timeZone: s.timeZone,
    });
    return Promise.resolve();
  }
  unsubscribe(_o: string, patientId: string) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.patientId !== patientId);
    return Promise.resolve(before - this.subs.length);
  }
  remove(_o: string, id: string) {
    this.removed.push(id);
    this.subs = this.subs.filter((s) => s.id !== id);
    return Promise.resolve();
  }
  orgs() {
    return Promise.resolve(this.subs.length ? [ORG] : []);
  }
  subscriptions() {
    return Promise.resolve(this.subs);
  }
  episodes() {
    return Promise.resolve(this.episodesList);
  }
  claim(_o: string, _p: string, e: string, w: number) {
    const k = `${e}:${String(w)}`;
    if (this.claimed.has(k)) return Promise.resolve(false);
    this.claimed.add(k);
    return Promise.resolve(true);
  }
}

describe('spec 15 the sender', () => {
  const setup = async (status: number | Error, endpoint = ENDPOINT, hour = 18) => {
    const store = new FakeReminders();
    const id = randomUUID();
    store.subs = [
      {
        id,
        patientId: PATIENT,
        endpointEncrypted: await cipherFor().encrypt(endpoint, {
          patientId: PATIENT,
          field: 'push_subscription.endpoint',
          recordId: id,
        }),
        remindHour: hour,
        timeZone: 'UTC',
      },
    ];
    store.episodesList = [
      {
        episodeId: EPISODE,
        patientId: PATIENT,
        startDate: '2026-11-01',
        reviewIntervalWeeks: 12,
        timeZone: 'UTC',
        doneWeeks: [],
        remindedWeeks: [],
      },
    ];
    const calls: { url: string; init: RequestInit }[] = [];
    const service = new ReminderService(
      store,
      cipherFor,
      VAPID,
      ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return status instanceof Error
          ? Promise.reject(status)
          : Promise.resolve(new Response(null, { status }));
      }) as unknown as typeof fetch,
      () => new Date('2026-11-07T18:05:00Z'),
    );
    return { store, service, calls, id };
  };

  it('sends one empty push at her hour, with VAPID and a TTL, and never twice for a week', async () => {
    const { service, calls } = await setup(201);
    expect(await service.run()).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(calls[0]?.url).toBe(ENDPOINT);
    const h = calls[0]?.init.headers as Record<string, string>;
    expect(h['authorization']).toMatch(/^vapid t=/);
    expect(h['ttl']).toBe('86400');
    expect(calls[0]?.init.body).toBeUndefined();
    expect(await service.run()).toEqual({ sent: 0, removed: 0, failed: 0 });
  });

  it('waits for her hour; removes gone subscriptions; counts failures', async () => {
    expect(await (await setup(201, ENDPOINT, 9)).service.run()).toEqual({
      sent: 0,
      removed: 0,
      failed: 0,
    });
    const gone = await setup(410);
    expect(await gone.service.run()).toEqual({ sent: 0, removed: 1, failed: 0 });
    expect(gone.store.removed).toEqual([gone.id]);
    expect(await (await setup(500)).service.run()).toEqual({ sent: 0, removed: 0, failed: 1 });
    expect(await (await setup(new TypeError('down'))).service.run()).toEqual({
      sent: 0,
      removed: 0,
      failed: 1,
    });
    // An endpoint that is not (or no longer) allowed is removed, never contacted.
    const odd = await setup(201, 'https://evil.example/x');
    expect(await odd.service.run()).toEqual({ sent: 0, removed: 1, failed: 0 });
    expect(odd.calls).toHaveLength(0);
  });
});

describe('spec 15 her reminder routes', () => {
  const setup = async () => {
    const patientKeys = await generateServiceKeyPair();
    const store = new FakeReminders();
    const logs: string[] = [];
    const app = await buildApi({
      logLevel: 'info',
      logStream: { write: (l) => logs.push(l) },
      verifier: new ServiceTokenVerifier('api', {
        'bff-patient': { publicJwk: patientKeys.publicJwk, roles: ['patient'] },
      }),
      audit: new AuditWriter(new InMemoryAuditStore()),
      invitations: new InMemoryIdempotentInvitationStore(),
      memberships: new InMemoryMembershipStore(),
      sealer: new EnvelopeSealer(kms, 'kms/clinical'),
      relayOutbox: () => Promise.resolve(),
      now: () => new Date(),
      consents: new InMemoryConsentStore(),
      reminders: { store, cipherFor },
    });
    const signer = new ServiceTokenSigner(patientKeys.privateJwk, 'bff-patient');
    const claims: ServiceClaims = {
      sub: randomUUID(),
      role: 'patient',
      org_id: ORG,
      patient_id: PATIENT,
    };
    const post = async (url: string, payload: object) =>
      app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${await signer.sign(claims, 'api')}` },
        payload,
      });
    return { post, store, logs };
  };

  it('stores her endpoint encrypted, refuses unknown push services, and removes on request', async () => {
    const { post, store, logs } = await setup();
    const res = await post('/v1/me/push-subscriptions', {
      endpoint: ENDPOINT,
      time_zone: 'Africa/Nairobi',
      remind_hour: 19,
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('SYNTHETIC_PHI_MARKER');
    expect(store.subs[0]?.endpointEncrypted).not.toContain('SYNTHETIC_PHI_MARKER');
    expect(store.subs[0]).toMatchObject({ remindHour: 19, timeZone: 'Africa/Nairobi' });
    expect(
      (
        await post('/v1/me/push-subscriptions', {
          endpoint: 'https://evil.example/x',
          time_zone: 'UTC',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await post('/v1/me/push-subscriptions', { endpoint: ENDPOINT, time_zone: 'Mars/Base' }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await post('/v1/me/push-subscriptions', {
          endpoint: ENDPOINT,
          time_zone: 'UTC',
          remind_hour: 23,
        })
      ).statusCode,
    ).toBe(400);
    expect((await post('/v1/me/push-subscriptions/remove', {})).json()).toEqual({ removed: 1 });
    expect(logs.join('\n')).not.toContain('SYNTHETIC_PHI_MARKER');
    expect(endpointHash(ENDPOINT)).toMatch(/^[0-9a-f]{64}$/);
  });
});
