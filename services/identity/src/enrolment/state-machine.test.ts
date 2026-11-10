import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_LIFETIME_MS,
  ENROLMENT_STATUSES,
  isOverdue,
  startTransaction,
  transition,
  type ConsentChoice,
  type ConsentDecisions,
  type EnrolmentEvent,
  type EnrolmentTransaction,
  type EnrolmentStatus,
} from './state-machine.ts';

const MIN = 60_000;
const T0 = new Date('2026-11-10T09:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);
const SUBJECT = 'kc-subject-synthetic';
const choice = (status: 'granted' | 'declined', version = 1): ConsentChoice => ({
  status,
  version,
  decidedAt: at(4),
});
const ALL_GRANTED: ConsentDecisions = {
  self_tracking: choice('granted', 3),
  share_with_care_team: choice('granted', 2),
  research_deidentified: choice('declined'),
  org_aggregate_reporting: choice('declined'),
};

const start = () =>
  startTransaction({
    id: '01900000-0000-7000-8000-000000000e01',
    invitationId: '01900000-0000-7000-8000-000000000e02',
    orgId: '01900000-0000-7000-8000-00000000000a',
    now: T0,
  });

/** Applies events in order at the given minutes, failing the test on any refusal. */
function run(tx: EnrolmentTransaction, steps: [number, EnrolmentEvent][]): EnrolmentTransaction {
  for (const [minute, event] of steps) {
    const r = transition(tx, event, at(minute));
    if (!r.ok) throw new Error(`${event.type} refused: ${r.reason}`);
    tx = r.tx;
  }
  return tx;
}

const toConsentPending: [number, EnrolmentEvent][] = [
  [1, { type: 'confirm' }],
  [2, { type: 'redeem', provisionalSubject: SUBJECT }],
  [3, { type: 'credential-committed' }],
  [4, { type: 'callback', subject: SUBJECT, credentialCommitted: false }],
];
const PERSON = '01900000-0000-7000-8000-000000000e03';
const consent: EnrolmentEvent = {
  type: 'consent',
  decisions: ALL_GRANTED,
  personId: PERSON,
  patientId: '01900000-0000-7000-8000-000000000e04',
};
const claiming = () => run(start(), [...toConsentPending, [5, consent]]);

describe('REQ-001, RISK-S05 ADR-0021 enrolment state machine (section 10)', () => {
  it('starts awaiting confirmation, with a 15-minute state and 60-minute absolute deadline', () => {
    const tx = start();
    expect(tx.status).toBe('awaiting-confirmation');
    expect(tx.stateDeadline).toEqual(at(15));
    expect(tx.expiresAt.getTime() - T0.getTime()).toBe(ABSOLUTE_LIFETIME_MS);
  });

  it('walks the happy path to active, holding her decisions until claiming', () => {
    let tx = claiming();
    expect(tx).toMatchObject({
      status: 'claiming',
      stateDeadline: null,
      decisions: ALL_GRANTED,
      personId: PERSON,
    });
    tx = run(tx, [
      [6, { type: 'claim-result', result: 'unknown' }],
      [7, { type: 'claim-result', result: 'succeeded' }],
      [8, { type: 'activation-step-done', step: 1 }],
      [9, { type: 'activation-step-done', step: 2 }],
      [10, { type: 'activation-step-done', step: 3 }],
    ]);
    expect(tx).toMatchObject({ status: 'active', activationStep: 3 });
  });

  it('caps each state deadline by the absolute deadline', () => {
    // Confirm at 14, redeem at 28, commit at 42: 30 more minutes would pass the 60-minute limit.
    const tx = run(start(), [
      [14, { type: 'confirm' }],
      [28, { type: 'redeem', provisionalSubject: SUBJECT }],
      [42, { type: 'credential-committed' }],
    ]);
    expect(tx.stateDeadline).toEqual(at(60));
    expect(
      transition(tx, { type: 'callback', subject: SUBJECT, credentialCommitted: true }, at(60)),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses every step but cancel once a pre-claim deadline passes', () => {
    const tx = start();
    expect(isOverdue(tx, at(14))).toBe(false);
    expect(isOverdue(tx, at(15))).toBe(true);
    expect(transition(tx, { type: 'confirm' }, at(15))).toEqual({ ok: false, reason: 'expired' });
    expect(transition(tx, { type: 'cancel', reason: 'deadline' }, at(15))).toMatchObject({
      ok: true,
      tx: { status: 'cancelling', cancelReason: 'deadline', stateDeadline: null },
    });
  });

  it('has no deadline from claiming on: consent has been given', () => {
    const tx = claiming();
    expect(isOverdue(tx, at(600))).toBe(false);
    expect(transition(tx, { type: 'claim-result', result: 'succeeded' }, at(600)).ok).toBe(true);
  });

  it('accepts the callback only for the provisional subject', () => {
    const tx = run(start(), toConsentPending.slice(0, 3));
    expect(
      transition(
        tx,
        { type: 'callback', subject: 'someone-else', credentialCommitted: true },
        at(4),
      ),
    ).toEqual({ ok: false, reason: 'subject-mismatch' });
  });

  it('reconciles a callback that beats the commit notice, and ignores the late notice', () => {
    const redeemed = run(start(), toConsentPending.slice(0, 2));
    const early = { type: 'callback', subject: SUBJECT } as const;
    expect(transition(redeemed, { ...early, credentialCommitted: false }, at(3))).toEqual({
      ok: false,
      reason: 'credential-pending',
    });
    const r = transition(redeemed, { ...early, credentialCommitted: true }, at(3));
    expect(r).toMatchObject({ ok: true, tx: { status: 'consent-pending', stateDeadline: at(33) } });
    if (!r.ok) return;
    expect(transition(r.tx, { type: 'credential-committed' }, at(4))).toMatchObject({
      ok: true,
      changed: false,
    });
  });

  it('refuses consent unless all four decisions are present and well-formed', () => {
    const tx = run(start(), toConsentPending);
    const three = Object.fromEntries(
      Object.entries(ALL_GRANTED).filter(([purpose]) => purpose !== 'org_aggregate_reporting'),
    );
    const bad: unknown[] = [
      three,
      { ...ALL_GRANTED, extra_purpose: choice('granted') },
      { ...ALL_GRANTED, research_deidentified: { ...choice('granted'), status: 'maybe' } },
      { ...ALL_GRANTED, research_deidentified: choice('granted', 0) },
      { ...ALL_GRANTED, research_deidentified: choice('granted', 1.5) },
      { ...ALL_GRANTED, research_deidentified: { ...choice('granted'), decidedAt: '2026-11-10' } },
      // Decided in the future.
      { ...ALL_GRANTED, research_deidentified: { ...choice('granted'), decidedAt: at(9) } },
    ];
    for (const decisions of bad) {
      const r = transition(tx, { ...consent, decisions: decisions as ConsentDecisions }, at(5));
      expect(r).toEqual({ ok: false, reason: 'incomplete-consent' });
    }
  });

  it('keeps each decision with its version and time, unchanged', () => {
    expect(claiming().decisions).toEqual(ALL_GRANTED);
  });

  it('cancels on a self-tracking decline even before the other decisions are answered', () => {
    const tx = run(start(), toConsentPending);
    const onlyDecline = { self_tracking: choice('declined') } as unknown as ConsentDecisions;
    expect(transition(tx, { ...consent, decisions: onlyDecline }, at(5))).toMatchObject({
      ok: true,
      tx: { status: 'cancelling', cancelReason: 'declined' },
    });
    // A malformed decline is not a decline.
    const malformed = {
      self_tracking: { ...choice('declined'), version: 0 },
    } as unknown as ConsentDecisions;
    expect(transition(tx, { ...consent, decisions: malformed }, at(5))).toEqual({
      ok: false,
      reason: 'incomplete-consent',
    });
  });

  it('cancels at once when she declines self-tracking', () => {
    const tx = run(start(), toConsentPending);
    const r = transition(
      tx,
      { ...consent, decisions: { ...ALL_GRANTED, self_tracking: choice('declined') } },
      at(5),
    );
    expect(r).toMatchObject({ ok: true, tx: { status: 'cancelling', cancelReason: 'declined' } });
  });

  it('cancels outright in every pre-claim state, and repeats harmlessly', () => {
    const steps = [[0, null], ...toConsentPending] as const;
    let tx = start();
    for (const [minute, event] of steps) {
      if (event) tx = run(tx, [[minute, event]]);
      const r = transition(tx, { type: 'cancel', reason: 'patient-cancelled' }, at(minute));
      expect(r).toMatchObject({ ok: true, changed: true, tx: { status: 'cancelling' } });
      if (!r.ok) return;
      expect(transition(r.tx, { type: 'cancel', reason: 'deadline' }, at(minute))).toMatchObject({
        ok: true,
        changed: false,
        tx: { cancelReason: 'patient-cancelled' },
      });
    }
  });

  it('during claiming, records the cancel and lets the clinical store decide', () => {
    const requested = run(claiming(), [[6, { type: 'cancel', reason: 'clinician-revoked' }]]);
    expect(requested).toMatchObject({ status: 'claiming', cancelRequested: 'clinician-revoked' });
    // A second cancel keeps the first reason.
    expect(
      transition(requested, { type: 'cancel', reason: 'patient-cancelled' }, at(7)),
    ).toMatchObject({ ok: true, changed: false, tx: { cancelRequested: 'clinician-revoked' } });

    expect(run(requested, [[7, { type: 'cancel-resolved', result: 'released' }]])).toMatchObject({
      status: 'cancelling',
      cancelReason: 'clinician-revoked',
      cancelRequested: null,
    });
    expect(run(requested, [[7, { type: 'cancel-resolved', result: 'claimed' }]])).toMatchObject({
      status: 'activating',
      cancelRequested: null,
    });
    // A definite refusal of the claim itself also uses the requested reason.
    expect(run(requested, [[7, { type: 'claim-result', result: 'refused' }]])).toMatchObject({
      status: 'cancelling',
      cancelReason: 'clinician-revoked',
    });
    expect(transition(claiming(), { type: 'cancel-resolved', result: 'claimed' }, at(7))).toEqual({
      ok: false,
      reason: 'wrong-state',
    });
  });

  it('cancels with claim-refused when the claim is definitely refused', () => {
    expect(run(claiming(), [[6, { type: 'claim-result', result: 'refused' }]])).toMatchObject({
      status: 'cancelling',
      cancelReason: 'claim-refused',
    });
  });

  it('never cancels once the claim has succeeded: activation only moves forward', () => {
    const activating = run(claiming(), [[6, { type: 'claim-result', result: 'succeeded' }]]);
    expect(transition(activating, { type: 'cancel', reason: 'patient-cancelled' }, at(7))).toEqual({
      ok: false,
      reason: 'wrong-state',
    });
    const active = run(activating, [
      [7, { type: 'activation-step-done', step: 1 }],
      [7, { type: 'activation-step-done', step: 2 }],
      [7, { type: 'activation-step-done', step: 3 }],
    ]);
    expect(transition(active, { type: 'cancel', reason: 'deadline' }, at(8)).ok).toBe(false);
  });

  it('runs activation steps in order; repeats change nothing, skips are refused', () => {
    const activating = run(claiming(), [[6, { type: 'claim-result', result: 'succeeded' }]]);
    expect(transition(activating, { type: 'activation-step-done', step: 2 }, at(7))).toEqual({
      ok: false,
      reason: 'out-of-order',
    });
    const one = run(activating, [[7, { type: 'activation-step-done', step: 1 }]]);
    expect(transition(one, { type: 'activation-step-done', step: 1 }, at(8))).toMatchObject({
      ok: true,
      changed: false,
    });
    const active = run(one, [
      [8, { type: 'activation-step-done', step: 2 }],
      [9, { type: 'activation-step-done', step: 3 }],
    ]);
    expect(transition(active, { type: 'activation-step-done', step: 3 }, at(9))).toMatchObject({
      ok: true,
      changed: false,
    });
  });

  it('finishes cleanup once, idempotently', () => {
    const cancelling = run(start(), [[1, { type: 'cancel', reason: 'deadline' }]]);
    const cancelled = run(cancelling, [[2, { type: 'cleanup-done' }]]);
    expect(cancelled.status).toBe('cancelled');
    expect(transition(cancelled, { type: 'cleanup-done' }, at(3))).toMatchObject({
      ok: true,
      changed: false,
    });
    expect(transition(cancelled, { type: 'confirm' }, at(3))).toEqual({
      ok: false,
      reason: 'wrong-state',
    });
  });

  it('refuses every event from a state that does not accept it', () => {
    const accepts: Record<EnrolmentEvent['type'], EnrolmentStatus[]> = {
      confirm: ['awaiting-confirmation'],
      redeem: ['confirmed'],
      'credential-committed': ['redeemed', 'credential-committed', 'consent-pending'],
      callback: ['redeemed', 'credential-committed'],
      consent: ['consent-pending'],
      'claim-result': ['claiming'],
      cancel: [],
      'cancel-resolved': [],
      'activation-step-done': ['activating', 'active'],
      'cleanup-done': ['cancelling', 'cancelled'],
    };
    const events: EnrolmentEvent[] = [
      { type: 'confirm' },
      { type: 'redeem', provisionalSubject: SUBJECT },
      { type: 'credential-committed' },
      { type: 'callback', subject: SUBJECT, credentialCommitted: true },
      consent,
      { type: 'claim-result', result: 'succeeded' },
      { type: 'activation-step-done', step: 1 },
      { type: 'cleanup-done' },
    ];
    for (const status of ENROLMENT_STATUSES) {
      const tx: EnrolmentTransaction = {
        ...start(),
        status,
        provisionalSubject: SUBJECT,
        stateDeadline: status === 'claiming' ? null : at(15),
      };
      for (const event of events) {
        const r = transition(tx, event, at(1));
        if (!accepts[event.type].includes(status))
          expect(r, `${event.type} in ${status}`).toEqual({ ok: false, reason: 'wrong-state' });
      }
    }
  });
});
