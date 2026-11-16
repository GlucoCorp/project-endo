import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type MonthlyCounts,
} from '@endo/clinical-store';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  generateServiceKeyPair,
  type ServiceClaims,
} from '@endo/service-kit';
import { buildApi } from './app.ts';
import { suppress } from './routes/dashboard.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const REF = randomUUID();
const row = (month: string, started: number, due: number, onTime: number): MonthlyCounts => ({
  month,
  episodesStarted: started,
  reviewsDue: due,
  reviewsOnTime: onTime,
});

describe('REQ-011 small-cell suppression', () => {
  it('hides counts under 10 and anything that would reveal one', () => {
    const r = suppress([
      row('2026-10-01', 12, 20, 20),
      row('2026-11-01', 9, 15, 12),
      row('2026-12-01', 30, 25, 10),
    ]);
    expect(r.months).toEqual([
      { month: '2026-10-01', episodes_started: 12, reviews_due: 20, reviews_on_time: 20 },
      // 9 started: hidden. 3 late: on time hidden too (20 - 17 would give them away).
      { month: '2026-11-01', episodes_started: null, reviews_due: 15, reviews_on_time: null },
      { month: '2026-12-01', episodes_started: 30, reviews_due: 25, reviews_on_time: 10 },
    ]);
    // One month hidden in a series: its total is hidden as well (no subtraction).
    expect(r.totals).toEqual({ episodes_started: null, reviews_due: 60, reviews_on_time: null });
    const two = suppress([row('a', 3, 0, 0), row('b', 4, 0, 0), row('c', 20, 0, 0)]);
    expect(two.totals.episodes_started).toBe(27);
    expect(two.months[0]?.reviews_on_time).toBeNull(); // nothing due: hidden, not zero
  });
});

describe('REQ-011 the dashboard route', () => {
  async function setup() {
    const keys = await generateServiceKeyPair();
    const asked: unknown[] = [];
    const app = await buildApi({
      logLevel: 'silent',
      verifier: new ServiceTokenVerifier('api', {
        'bff-clinic': { publicJwk: keys.publicJwk, roles: ['clinician', 'org_admin'] },
        'bff-patient': { publicJwk: keys.publicJwk, roles: ['patient'] },
      }),
      audit: new AuditWriter(new InMemoryAuditStore()),
      invitations: new InMemoryIdempotentInvitationStore(),
      memberships: new InMemoryMembershipStore().add(ORG, REF, {
        clinicianId: randomUUID(),
        role: 'clinician',
        active: true,
      }),
      sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
      relayOutbox: () => Promise.resolve(),
      now: () => new Date('2026-11-16T10:00:00Z'),
      consents: new InMemoryConsentStore(),
      dashboard: {
        reporting: {
          monthly: (...args) => {
            asked.push(args);
            return Promise.resolve([row('2026-11-01', 14, 11, 11)]);
          },
        },
      },
    });
    const clinic = new ServiceTokenSigner(keys.privateJwk, 'bff-clinic');
    const patient = new ServiceTokenSigner(keys.privateJwk, 'bff-patient');
    const get = async (url: string, claims: ServiceClaims, s = clinic) =>
      app.inject({ url, headers: { authorization: `Bearer ${await s.sign(claims, 'api')}` } });
    return { get, asked, patient };
  }
  const C: ServiceClaims = { sub: REF, role: 'clinician', org_id: ORG, patient_id: null };

  it('shows its own organisation counts, never verdicts in shadow mode', async () => {
    const { get, asked } = await setup();
    const res = await get(`/v1/orgs/${ORG}/dashboard`, C);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({
      basis: 'org_aggregate_reporting',
      min_cell: 10,
      months: [{ month: '2026-11-01', episodes_started: 14, reviews_due: 11, reviews_on_time: 11 }],
      verdict_distribution: { status: 'unavailable_shadow_mode' },
      median_weeks_on_ineffective_treatment: { status: 'unavailable_shadow_mode' },
    });
    expect(asked).toEqual([[ORG, '2026-11-16', 12, 7]]);
  });

  it('refuses another organisation and patients', async () => {
    const { get, patient } = await setup();
    expect((await get(`/v1/orgs/${randomUUID()}/dashboard`, C)).statusCode).toBe(403);
    expect((await get('/v1/orgs/nope/dashboard', C)).statusCode).toBe(403);
    expect(
      (
        await get(
          `/v1/orgs/${ORG}/dashboard`,
          { sub: randomUUID(), role: 'patient', org_id: ORG, patient_id: randomUUID() },
          patient,
        )
      ).statusCode,
    ).toBe(403);
  });
});
