import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ROLES, type Role } from '@endo/domain';
import {
  ACTIONS,
  CONSENT_PURPOSES,
  can,
  type Action,
  type AuthzContext,
  type ConsentPurpose,
  type Resource,
  type Subject,
} from './index.ts';

/**
 * Spec 3.2 permission matrix, transcribed cell for cell.
 *   A = allowed (own data / own org)   C = allowed only with share_with_care_team, same org
 *   T = only with a valid time-boxed support ticket   - = denied
 * glucorp_platform_admin is not in the spec table: denied everything in the app (spec 3.1).
 */
type Cell = 'A' | 'C' | 'T' | '-';
const MATRIX: Record<Action, Record<Role, Cell>> = {
  //                         patient  clinician org_admin glucorp_support platform_admin
  'episode.read_own': {
    patient: 'A',
    clinician: '-',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'checkin.submit': {
    patient: 'A',
    clinician: '-',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'episode.create': {
    patient: '-',
    clinician: 'C',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'patient_data.read': {
    patient: '-',
    clinician: 'C',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'review_decision.record': {
    patient: '-',
    clinician: 'C',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'surgery_check.read': {
    patient: 'A',
    clinician: 'C',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  // Spec 13.1 (not a spec 3.2 row): only she sees or changes her own consent.
  'consent.read_own': {
    patient: 'A',
    clinician: '-',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'consent.update_own': {
    patient: 'A',
    clinician: '-',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  // REQ-001 (not a spec 3.2 row): a clinician invites a patient into their own organisation.
  'enrolment.create': {
    patient: '-',
    clinician: 'A',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'enrolment.read': {
    patient: '-',
    clinician: 'A',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'enrolment.confirm': {
    patient: '-',
    clinician: 'A',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'episode.confirm_own': {
    patient: 'A',
    clinician: '-',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'patient.list': {
    patient: '-',
    clinician: 'A',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'catalogue.read': {
    patient: '-',
    clinician: 'A',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'org.clinicians.manage': {
    patient: '-',
    clinician: '-',
    org_admin: 'A',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'org.dashboard.read': {
    patient: '-',
    clinician: 'A',
    org_admin: 'A',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'own_data.export': {
    patient: 'A',
    clinician: '-',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'own_data.delete': {
    patient: 'A',
    clinician: '-',
    org_admin: '-',
    glucorp_support: '-',
    glucorp_platform_admin: '-',
  },
  'support.phi_access': {
    patient: '-',
    clinician: '-',
    org_admin: '-',
    glucorp_support: 'T',
    glucorp_platform_admin: '-',
  },
  'system.hello': {
    patient: 'A',
    clinician: 'A',
    org_admin: 'A',
    glucorp_support: 'A',
    glucorp_platform_admin: '-',
  },
};

const ORG_A = '01900000-0000-7000-8000-00000000a000';
const ORG_B = '01900000-0000-7000-8000-00000000b000';
const PATIENT_P = '01900000-0000-7000-8000-0000000000c1';
const PATIENT_Q = '01900000-0000-7000-8000-0000000000c2';
const NOW = new Date('2026-11-07T12:00:00Z');
const ALL_CONSENTS: ReadonlySet<ConsentPurpose> = new Set(CONSENT_PURPOSES);

function subject(role: Role, overrides: Partial<Subject> = {}): Subject {
  const isOrgRole = role === 'clinician' || role === 'org_admin';
  return {
    id: '01900000-0000-7000-8000-000000000001',
    role,
    orgId: isOrgRole ? ORG_A : null,
    patientId: role === 'patient' ? PATIENT_P : null,
    active: true,
    ...overrides,
  };
}

const ownResource: Resource = { type: 'treatment_episode', orgId: ORG_A, patientId: PATIENT_P };

function ctx(overrides: Partial<AuthzContext> = {}): AuthzContext {
  return {
    now: NOW,
    consents: ALL_CONSENTS,
    supportTicket: {
      approved: true,
      grantedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
      patientId: PATIENT_P,
      orgId: null,
    },
    ...overrides,
  };
}

describe('Spec 3.2 permission matrix (REQ-001..REQ-011, RISK-I03, RISK-E01)', () => {
  it('covers every action and every role', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ACTIONS].sort());
    for (const row of Object.values(MATRIX))
      expect(Object.keys(row).sort()).toEqual([...ROLES].sort());
  });

  for (const action of ACTIONS) {
    for (const role of ROLES) {
      const cell = MATRIX[action][role];
      describe(`${action} × ${role} = ${cell}`, () => {
        if (cell === '-') {
          it('is denied even in the most favourable context', () => {
            expect(can(subject(role), action, ownResource, ctx()).allow).toBe(false);
          });
          return;
        }

        it('is allowed in the favourable context', () => {
          expect(can(subject(role), action, ownResource, ctx())).toEqual({ allow: true });
        });

        it('is denied for an inactive subject', () => {
          expect(can(subject(role, { active: false }), action, ownResource, ctx())).toEqual({
            allow: false,
            reason: 'authz.inactive_subject',
          });
        });

        if (cell === 'A' && role === 'patient' && action !== 'system.hello') {
          it("is denied on another patient's data", () => {
            const other = { ...ownResource, patientId: PATIENT_Q };
            expect(can(subject(role), action, other, ctx())).toMatchObject({
              reason: 'authz.not_own_resource',
            });
          });
        }

        if (
          (cell === 'A' || cell === 'C') &&
          (role === 'clinician' || role === 'org_admin') &&
          action !== 'system.hello'
        ) {
          it('is denied across organisations', () => {
            const other = { ...ownResource, orgId: ORG_B };
            expect(can(subject(role), action, other, ctx())).toMatchObject({
              reason: 'authz.org_mismatch',
            });
          });
        }

        if (cell === 'C') {
          it('is denied without share_with_care_team consent', () => {
            const consents = new Set(CONSENT_PURPOSES.filter((p) => p !== 'share_with_care_team'));
            expect(can(subject(role), action, ownResource, ctx({ consents }))).toMatchObject({
              reason: 'authz.no_consent',
            });
          });
        }

        if (cell === 'T') {
          it('is denied without a ticket', () => {
            expect(
              can(subject(role), action, ownResource, ctx({ supportTicket: undefined })),
            ).toMatchObject({
              reason: 'authz.no_support_ticket',
            });
          });
        }
      });
    }
  }
});

describe('support access tickets (spec 10.3, RISK-E01)', () => {
  const sup = subject('glucorp_support');
  const base = ctx().supportTicket!;
  const hour = 60 * 60 * 1000;

  it.each([
    ['unapproved', { ...base, approved: false }],
    ['expired', { ...base, expiresAt: new Date(NOW.getTime() - 1) }],
    ['not yet valid', { ...base, grantedAt: new Date(NOW.getTime() + 1) }],
    [
      'longer than 4 hours',
      {
        ...base,
        grantedAt: new Date(NOW.getTime() - hour),
        expiresAt: new Date(NOW.getTime() + 3 * hour + 1),
      },
    ],
    ['for another patient', { ...base, patientId: PATIENT_Q }],
    ['scoped to both patient and org', { ...base, orgId: ORG_A }],
    ['scoped to nothing', { ...base, patientId: null }],
    ['for another org', { ...base, patientId: null, orgId: ORG_B }],
  ])('denies a ticket that is %s', (_l, supportTicket) => {
    expect(can(sup, 'support.phi_access', ownResource, ctx({ supportTicket }))).toMatchObject({
      reason: 'authz.support_ticket_invalid',
    });
  });

  it('allows an org-scoped ticket for that org', () => {
    const supportTicket = { ...base, patientId: null, orgId: ORG_A };
    expect(can(sup, 'support.phi_access', ownResource, ctx({ supportTicket })).allow).toBe(true);
  });

  it('allows exactly 4 hours', () => {
    const supportTicket = {
      ...base,
      grantedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 4 * hour),
    };
    expect(can(sup, 'support.phi_access', ownResource, ctx({ supportTicket })).allow).toBe(true);
  });
});

describe('edge cases', () => {
  it('denies unknown actions', () => {
    expect(can(subject('clinician'), 'episode.delete_everything', ownResource, ctx())).toEqual({
      allow: false,
      reason: 'authz.unknown_action',
    });
  });

  it('denies a clinician with no organisation', () => {
    expect(
      can(subject('clinician', { orgId: null }), 'patient_data.read', ownResource, ctx()).allow,
    ).toBe(false);
  });

  it('denies clinician access to a resource with no patient', () => {
    const r = { ...ownResource, patientId: null };
    expect(can(subject('clinician'), 'patient_data.read', r, ctx())).toMatchObject({
      reason: 'authz.no_consent',
    });
  });

  it('denies a patient subject that has no patient record', () => {
    expect(
      can(subject('patient', { patientId: null }), 'episode.read_own', ownResource, ctx()).allow,
    ).toBe(false);
  });
});

describe('properties', () => {
  const arbRole = fc.constantFrom(...ROLES);
  const arbAction = fc.constantFrom(...ACTIONS);
  const arbId = fc.constantFrom(ORG_A, ORG_B, PATIENT_P, PATIENT_Q, null);
  const arbConsents = fc.subarray([...CONSENT_PURPOSES]).map((a) => new Set(a));

  it('never allows anything not in the matrix (deny by default)', () => {
    fc.assert(
      fc.property(
        arbRole,
        arbAction,
        arbId,
        arbId,
        arbId,
        arbId,
        arbConsents,
        (role, action, so, sp, ro, rp, consents) => {
          const d = can(
            { id: 'x', role, orgId: so, patientId: sp, active: true },
            action,
            { type: 't', orgId: ro, patientId: rp },
            { now: NOW, consents },
          );
          if (d.allow) expect(MATRIX[action][role]).not.toBe('-');
        },
      ),
    );
  });

  it('never allows a clinician or admin across organisations (RISK-I03)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Role>('clinician', 'org_admin'),
        arbAction.filter((a) => a !== 'system.hello'),
        arbConsents,
        (role, action, consents) => {
          const d = can(
            subject(role),
            action,
            { ...ownResource, orgId: ORG_B },
            { now: NOW, consents },
          );
          expect(d.allow).toBe(false);
        },
      ),
    );
  });

  it('withdrawing share_with_care_team removes all clinician access to patient data', () => {
    fc.assert(
      fc.property(arbAction, arbConsents, (action, consents) => {
        consents.delete('share_with_care_team');
        const d = can(subject('clinician'), action, ownResource, { now: NOW, consents });
        // Only actions that touch no individual patient's data survive withdrawal. Creating an
        // enrolment invitation is one: the patient does not exist yet (REQ-001).
        if (d.allow)
          expect([
            'org.dashboard.read',
            'system.hello',
            'enrolment.create',
            'enrolment.read',
            'enrolment.confirm',
            // REQ-002: the catalogue holds no patient data, and the patient list is filtered by
            // the store to patients whose current share_with_care_team is granted, so a patient
            // who withdraws disappears from it (services/api episodes routes test this).
            'catalogue.read',
            'patient.list',
          ]).toContain(action);
      }),
    );
  });
});
