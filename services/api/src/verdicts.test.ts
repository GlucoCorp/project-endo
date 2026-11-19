import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AuditWriter, InMemoryAuditStore } from '@endo/audit';
import {
  InMemoryConsentStore,
  InMemoryIdempotentInvitationStore,
  InMemoryMembershipStore,
  type EpisodeEvidence,
  type NewVerdict,
  type VerdictStore,
} from '@endo/clinical-store';
import { DevKeyManager, EnvelopeSealer } from '@endo/crypto';
import {
  ServiceTokenSigner,
  ServiceTokenVerifier,
  generateServiceKeyPair,
  type ServiceClaims,
} from '@endo/service-kit';
import { signRuleset } from '@endo/verdict';
import { buildApi } from './app.ts';
import { RulesetRejectedError, VerdictService, loadRuleset, snapshotOf } from './verdicts.ts';

const ORG = '01900000-0000-7000-8000-00000000000a';
const IDENTITY_REF = '01900000-0000-7000-8000-0000000000e1';
const CLINICIAN_ID = '01900000-0000-7000-8000-0000000000c1';
const PATIENT = '01900000-0000-7000-8000-0000000000a1';
const OTHER = '01900000-0000-7000-8000-0000000000a2';
const EPISODE = '01900000-0000-7000-8000-0000000000e5';
const REAL = readFileSync(
  fileURLToPath(new URL('../../../clinical/rulesets/ruleset.1.0.0.json', import.meta.url)),
  'utf8',
);
/** TEST-ONLY numbers with no clinical standing (they exercise generation, nothing else). */
const TEST_RULESET = JSON.stringify({
  version: '0.0.1',
  approved_by: 'TEST-ONLY, no clinical standing',
  approved_on: '2026-11-15',
  definitions: {
    validity: 'any_submitted',
    adherence_daily: 'answered_weeks',
    intolerance: 'unbearable_weeks',
    benefit: 'q1_first_last_windows',
    modifiers: 'v1',
    empty_goal: 'not_met',
  },
  min_values_per_window: 1,
  thresholds: {
    min_checkins: 1,
    adherence_threshold: 0.5,
    intolerance_weeks: 2,
    baseline_window_weeks: 1,
    recent_window_weeks: 1,
    meaningful_improvement: { absolute_points: 2, relative: 0.3, combine: 'either' },
    minimal_change: 1,
    goal_met_threshold: 0.5,
  },
  benefit: { aggregate: 'mean' },
  goal: { partly_counts_as: 0.5, exclude_did_not_apply: true },
  adherence: { device_or_injection: 'share_of_yes' },
  modifiers: { side_effects_limiting_weeks: 3, barrier_share: 0.25, data_gaps_missing_weeks: 3 },
});

const evidence = (o: Partial<EpisodeEvidence> = {}): EpisodeEvidence => ({
  episodeId: EPISODE,
  orgId: ORG,
  patientId: PATIENT,
  status: 'active',
  startDate: '2026-08-01',
  reviewDate: '2026-10-24',
  reviewIntervalWeeks: 12,
  adherenceMode: 'daily',
  instrumentVersion: '1.0.0',
  timeZone: 'UTC',
  checkIns: [
    { weekIndex: 1, answers: { Q1: 8, Q3: 'yes', Q5: [], Q7: 7, Q8: ['none'] } },
    { weekIndex: 12, answers: { Q1: 3, Q3: 'yes', Q5: [], Q7: 7, Q8: ['none'] } },
  ],
  redFlagEvents: 0,
  ...o,
});

class FakeVerdicts implements VerdictStore {
  readonly recorded: NewVerdict[] = [];
  readonly ev: EpisodeEvidence | null;
  constructor(ev: EpisodeEvidence | null = evidence()) {
    this.ev = ev;
  }
  due() {
    return Promise.resolve(this.ev ? [{ episodeId: this.ev.episodeId, orgId: ORG }] : []);
  }
  evidence() {
    return Promise.resolve(this.ev);
  }
  record(v: NewVerdict) {
    const dup = this.recorded.some(
      (x) =>
        x.generatedBy === 'system' &&
        v.generatedBy === 'system' &&
        x.rulesetVersion === v.rulesetVersion,
    );
    if (!dup) this.recorded.push(v);
    return Promise.resolve(!dup);
  }
  list() {
    return Promise.resolve([]);
  }
}

describe('spec 18.5 the API verifies the rule set before it starts', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys = new Map([['clinical-2026', publicKey.export({ format: 'jwk' })]]);
  const sign = (text: string) =>
    JSON.stringify(
      signRuleset(JSON.parse(text), 'clinical-2026', privateKey.export({ format: 'jwk' })),
    );

  it('accepts a verified signature, and an unsigned rule set only outside deployment', () => {
    expect(loadRuleset(TEST_RULESET, sign(TEST_RULESET), keys, true)).toMatchObject({
      version: '0.0.1',
      signature: 'verified',
      check: { ok: true },
    });
    expect(loadRuleset(REAL, null, keys, false)).toMatchObject({
      signature: 'unsigned',
      check: { ok: false },
    });
    expect(() => loadRuleset(REAL, null, keys, true)).toThrow(RulesetRejectedError);
  });

  it('refuses a tampered rule set, a broken signature file and invalid JSON', () => {
    const sig = sign(TEST_RULESET);
    const tampered = TEST_RULESET.replace('"min_checkins":1', '"min_checkins":2');
    expect(() => loadRuleset(tampered, sig, keys, false)).toThrow(/bad_signature/);
    expect(() => loadRuleset(TEST_RULESET, '{', keys, false)).toThrow(/malformed/);
    expect(() => loadRuleset('{', null, keys, false)).toThrow(/JSON/);
    expect(loadRuleset('{"version":"x"}', null, keys, false).version).toBe('0.0.0');
  });
});

describe('REQ-004 snapshots: missing weeks stay missing', () => {
  it('places answers by week and counts weeks still open as missing', () => {
    const { snapshot, openWeeks } = snapshotOf(evidence(), '2026-10-21');
    expect(snapshot.weeks).toHaveLength(12);
    expect(snapshot.weeks[0]).toMatchObject({ Q1: 8 });
    expect(snapshot.weeks[5]).toBeNull();
    expect(openWeeks).toBe(1); // week 11 can still be completed
    expect(snapshotOf(evidence(), '2027-01-01').openWeeks).toBe(0);
  });
});

describe('REQ-004 generation in shadow mode', () => {
  const run = (store: FakeVerdicts, rulesetText: string) =>
    new VerdictService(
      store,
      loadRuleset(rulesetText, null, new Map(), false),
      () => new Date('2026-10-21T12:00:00Z'),
    );
  const req = {
    orgId: ORG,
    episodeId: EPISODE,
    by: 'on_demand' as const,
    requestedBy: CLINICIAN_ID,
    actor: { id: IDENTITY_REF, role: 'clinician' },
    requestId: randomUUID(),
  };

  it('generates nothing while the rule set is incomplete, and records why', async () => {
    const store = new FakeVerdicts();
    const r = await run(store, REAL).generate(req);
    expect(r).toMatchObject({ kind: 'recorded', outcome: 'not_generated' });
    expect(store.recorded[0]?.result).toEqual({
      outcome: 'not_generated',
      reason: 'ruleset_incomplete',
    });
    expect(store.recorded[0]?.rulesetDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(store.recorded[0]?.auditEvent).toMatchObject({
      action: 'verdict.generated',
      reason: 'verdict.ruleset_incomplete',
    });
  });

  it('with a complete rule set, stores the verdict, hash and trace; red flags win', async () => {
    const store = new FakeVerdicts(evidence({ redFlagEvents: 1 }));
    await run(store, TEST_RULESET).generate(req);
    const v = store.recorded[0]?.result;
    expect(v).toMatchObject({ outcome: 'generated', code: 'RED_FLAG', secondary: 'WORKING' });
    if (v?.outcome === 'generated') {
      expect(v.inputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(v.explanation).toMatchObject({
        as_of: '2026-10-21',
        open_weeks: 1,
        ruleset_signature: 'unsigned',
      });
    }
  });

  it('records snapshot_invalid rather than guessing, and refuses drafts, others and unknowns', async () => {
    const short = new FakeVerdicts(evidence({ reviewIntervalWeeks: 1, checkIns: [] }));
    const narrow = TEST_RULESET; // windows of 1 + 1 weeks: more than a 1-week episode
    expect(await run(short, narrow).generate(req)).toMatchObject({ outcome: 'not_generated' });
    expect(short.recorded[0]?.result).toEqual({
      outcome: 'not_generated',
      reason: 'snapshot_invalid',
    });
    expect(await run(new FakeVerdicts(null), TEST_RULESET).generate(req)).toEqual({
      kind: 'not_found',
    });
    expect(
      await run(new FakeVerdicts(evidence({ status: 'draft' })), TEST_RULESET).generate(req),
    ).toEqual({ kind: 'not_found' });
    expect(
      await run(new FakeVerdicts(), TEST_RULESET).generate({ ...req, patientId: OTHER }),
    ).toEqual({ kind: 'not_found' });
  });

  it('runs the schedule once per episode and rule set version', async () => {
    const store = new FakeVerdicts();
    const service = run(store, REAL);
    expect(await service.runSchedule(() => randomUUID())).toBe(1);
    expect(await service.runSchedule(() => randomUUID())).toBe(0);
    expect(store.recorded[0]).toMatchObject({ generatedBy: 'system', requestedBy: null });
    expect(store.recorded[0]?.auditEvent).toMatchObject({
      purpose_of_use: 'operations',
      actor: { role: 'system' },
    });
    expect(service.rulesetVersion).toBe('1.0.0');
  });
});

describe('REQ-004 on-demand route: shadow mode shows no verdict', () => {
  const setup = async (consent: boolean) => {
    const clinicKeys = await generateServiceKeyPair();
    const consents = new InMemoryConsentStore();
    if (consent)
      await consents.recordEnrolment(ORG, PATIENT, [
        {
          id: randomUUID(),
          purpose: 'share_with_care_team',
          status: 'granted',
          version: 1,
          chosenAt: new Date(),
          auditEvent: { id: randomUUID() },
        },
      ]);
    const store = new FakeVerdicts(evidence({ redFlagEvents: 1 }));
    const app = await buildApi({
      logLevel: 'silent',
      verifier: new ServiceTokenVerifier('api', {
        'bff-clinic': { publicJwk: clinicKeys.publicJwk, roles: ['clinician', 'org_admin'] },
      }),
      audit: new AuditWriter(new InMemoryAuditStore()),
      invitations: new InMemoryIdempotentInvitationStore(),
      memberships: new InMemoryMembershipStore().add(ORG, IDENTITY_REF, {
        clinicianId: CLINICIAN_ID,
        role: 'clinician',
        active: true,
      }),
      sealer: new EnvelopeSealer(new DevKeyManager('test'), 'kms/clinical'),
      relayOutbox: () => Promise.resolve(),
      now: () => new Date(),
      consents,
      verdicts: new VerdictService(
        store,
        loadRuleset(TEST_RULESET, null, new Map(), false),
        () => new Date('2026-10-21T00:00:00Z'),
      ),
    });
    const signer = new ServiceTokenSigner(clinicKeys.privateJwk, 'bff-clinic');
    const claims: ServiceClaims = {
      sub: IDENTITY_REF,
      role: 'clinician',
      org_id: ORG,
      patient_id: null,
    };
    const post = async (patient = PATIENT) =>
      app.inject({
        method: 'POST',
        url: `/v1/patients/${patient}/episodes/${EPISODE}/verdicts`,
        headers: { authorization: `Bearer ${await signer.sign(claims, 'api')}` },
      });
    return { post, store };
  };

  it('stores the attempt and answers only whether a verdict was generated', async () => {
    const { post, store } = await setup(true);
    const res = await post();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String) as unknown,
      outcome: 'generated',
      shadow: true,
    });
    expect(res.body).not.toContain('RED_FLAG');
    expect(store.recorded[0]).toMatchObject({
      generatedBy: 'on_demand',
      requestedBy: CLINICIAN_ID,
    });
  });

  it('needs her share_with_care_team consent, and the episode must be hers', async () => {
    expect((await (await setup(false)).post()).statusCode).toBe(403);
    expect((await (await setup(true)).post(OTHER)).statusCode).toBe(403);
  });
});
