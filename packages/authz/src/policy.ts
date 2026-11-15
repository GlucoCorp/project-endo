import type { Role } from '@endo/domain';

/**
 * Pure authorisation policies (spec 3.2, 10.4). No I/O, no clock: the caller supplies `now` and
 * the consent state it loaded. Deny by default (spec 2.5): anything not explicitly allowed below
 * is denied.
 *
 * RISK-I03 (cross-organisation leak), RISK-E01 (support staff accessing PHI).
 */

/** Consent purposes, spec 13.1. */
export const CONSENT_PURPOSES = [
  'self_tracking',
  'share_with_care_team',
  'research_deidentified',
  'org_aggregate_reporting',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/**
 * One action per row of the spec 3.2 matrix, plus `enrolment.create` (REQ-001) and `system.hello`
 * for the M0 walking skeleton.
 */
export const ACTIONS = [
  'episode.read_own', // View own episodes and check-ins
  'checkin.submit', // Submit check-in
  'episode.create', // Create treatment episode
  'patient_data.read', // View a patient's episodes, check-ins, verdicts
  'review_decision.record', // Record review decision
  'surgery_check.read', // View pre-surgery check
  'org.clinicians.manage', // Manage clinicians in org
  'org.dashboard.read', // View aggregate org dashboard (de-identified)
  'own_data.export', // Export own data
  'own_data.delete', // Delete own data
  'support.phi_access', // Access PHI for support
  'enrolment.create', // REQ-001: clinician invites a patient to their own organisation
  'enrolment.read', // REQ-001: clinician lists their organisation's open invitations
  'enrolment.confirm', // REQ-001, ADR-0021: clinician confirms the patient in front of them by code
  'consent.read_own', // Spec 13.1: she sees her consent decisions
  'consent.update_own', // Spec 13.1: she grants or withdraws a purpose, effective immediately
  'episode.confirm_own', // REQ-002: she sets her goal and confirms her own draft episode
  'patient.list', // REQ-002: clinician lists own-organisation patients who share with the care team
  'catalogue.read', // REQ-002: clinician reads the treatment catalogue to draft an episode
  'reminders.manage_own', // Spec 15: she turns her weekly reminder on or off on a device
  'verdict.generate', // REQ-004: clinician asks for a (shadow) verdict on a consented patient's episode
  'system.hello', // M0 walking skeleton: authenticated, no health data
] as const;
export type Action = (typeof ACTIONS)[number];

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

export interface Subject {
  readonly id: string;
  readonly role: Role;
  /** Organisation the subject acts within. `null` for patients and GluCorp staff. */
  readonly orgId: string | null;
  /** For `patient` subjects: their own pseudonymous PatientRecord id. */
  readonly patientId: string | null;
  readonly active: boolean;
}

export interface Resource {
  readonly type: string;
  readonly orgId: string | null;
  /** The patient whose data this is, if any. */
  readonly patientId: string | null;
}

/** Just-in-time support approval (spec 3.2, 10.3). Maximum 4 hours, enforced here. */
export interface SupportTicket {
  readonly approved: boolean;
  readonly grantedAt: Date;
  readonly expiresAt: Date;
  /** Scope: exactly one of these is set. */
  readonly patientId: string | null;
  readonly orgId: string | null;
}

export interface AuthzContext {
  readonly now: Date;
  /** Purposes the resource's patient has currently granted (revoked ones excluded). */
  readonly consents: ReadonlySet<ConsentPurpose>;
  readonly supportTicket?: SupportTicket | undefined;
}

export type DenyReason =
  | 'authz.unknown_action'
  | 'authz.inactive_subject'
  | 'authz.role_not_permitted'
  | 'authz.not_own_resource'
  | 'authz.org_mismatch'
  | 'authz.no_consent'
  | 'authz.no_support_ticket'
  | 'authz.support_ticket_invalid';

export type Decision =
  { readonly allow: true } | { readonly allow: false; readonly reason: DenyReason };

const ALLOW: Decision = Object.freeze({ allow: true });
const deny = (reason: DenyReason): Decision => Object.freeze({ allow: false, reason });

const MAX_SUPPORT_TICKET_MS = 4 * 60 * 60 * 1000;

function ownPatientData(s: Subject, r: Resource): Decision {
  if (s.role !== 'patient') return deny('authz.role_not_permitted');
  if (s.patientId === null || r.patientId === null || s.patientId !== r.patientId) {
    return deny('authz.not_own_resource');
  }
  return ALLOW;
}

function sameOrg(s: Subject, r: Resource): boolean {
  return s.orgId !== null && r.orgId !== null && s.orgId === r.orgId;
}

/** Clinician access to a patient's data: same organisation and `share_with_care_team` consent. */
function clinicianWithCareTeamConsent(s: Subject, r: Resource, c: AuthzContext): Decision {
  if (s.role !== 'clinician') return deny('authz.role_not_permitted');
  if (!sameOrg(s, r)) return deny('authz.org_mismatch');
  if (r.patientId === null || !c.consents.has('share_with_care_team'))
    return deny('authz.no_consent');
  return ALLOW;
}

function supportAccess(s: Subject, r: Resource, c: AuthzContext): Decision {
  if (s.role !== 'glucorp_support') return deny('authz.role_not_permitted');
  const t = c.supportTicket;
  if (!t) return deny('authz.no_support_ticket');
  const durationMs = t.expiresAt.getTime() - t.grantedAt.getTime();
  const now = c.now.getTime();
  const inWindow = now >= t.grantedAt.getTime() && now < t.expiresAt.getTime();
  const scopeOk =
    (t.patientId !== null && t.orgId === null && t.patientId === r.patientId) ||
    (t.orgId !== null && t.patientId === null && t.orgId === r.orgId);
  if (
    !t.approved ||
    !inWindow ||
    durationMs <= 0 ||
    durationMs > MAX_SUPPORT_TICKET_MS ||
    !scopeOk
  ) {
    return deny('authz.support_ticket_invalid');
  }
  return ALLOW;
}

/**
 * `can(subject, action, resource, context) -> Allow | Deny(reason)` (spec 10.4).
 *
 * `glucorp_platform_admin` is denied every application action: break-glass access happens at the
 * infrastructure layer with two-person approval (spec 3.1), never through the app.
 */
export function can(
  subject: Subject,
  action: string,
  resource: Resource,
  context: AuthzContext,
): Decision {
  if (!isAction(action)) return deny('authz.unknown_action');
  if (!subject.active) return deny('authz.inactive_subject');

  switch (action) {
    case 'episode.read_own':
    case 'consent.read_own':
    case 'consent.update_own':
    case 'episode.confirm_own':
    case 'reminders.manage_own':
    case 'checkin.submit':
    case 'own_data.export':
    case 'own_data.delete':
      return ownPatientData(subject, resource);

    case 'episode.create':
    case 'verdict.generate':
    case 'patient_data.read':
    case 'review_decision.record':
      return clinicianWithCareTeamConsent(subject, resource, context);

    case 'surgery_check.read':
      return subject.role === 'patient'
        ? ownPatientData(subject, resource)
        : clinicianWithCareTeamConsent(subject, resource, context);

    case 'org.clinicians.manage':
      if (subject.role !== 'org_admin') return deny('authz.role_not_permitted');
      return sameOrg(subject, resource) ? ALLOW : deny('authz.org_mismatch');

    case 'org.dashboard.read':
      if (subject.role !== 'clinician' && subject.role !== 'org_admin')
        return deny('authz.role_not_permitted');
      return sameOrg(subject, resource) ? ALLOW : deny('authz.org_mismatch');

    case 'support.phi_access':
      return supportAccess(subject, resource, context);

    // REQ-001: no patient exists yet, so no consent applies; organisation membership does.
    case 'enrolment.create':
    case 'enrolment.read':
    case 'enrolment.confirm':
    // REQ-002: organisation-level reads; the patient list itself is filtered to patients who
    // share with the care team, and each patient's data is still checked per patient.
    case 'patient.list':
    case 'catalogue.read':
      if (subject.role !== 'clinician') return deny('authz.role_not_permitted');
      return sameOrg(subject, resource) ? ALLOW : deny('authz.org_mismatch');

    case 'system.hello':
      return subject.role === 'glucorp_platform_admin' ? deny('authz.role_not_permitted') : ALLOW;
  }
}
