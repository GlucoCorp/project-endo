import type {
  ConsentState,
  Episode,
  StoredCheckIn,
  StoredDecision,
  StoredRedFlag,
  StoredSurgeryCheck,
} from '@endo/clinical-store';

/** Everything of hers the export holds (REQ-009), already decrypted for her. */
export interface ExportInput {
  readonly patientId: string;
  readonly generatedAt: Date;
  readonly episodes: readonly {
    readonly episode: Episode;
    readonly treatmentDisplay: string | null;
    readonly goalText: string | null;
    readonly checkIns: readonly StoredCheckIn[];
    readonly redFlags: readonly StoredRedFlag[];
  }[];
  readonly decisions: readonly (StoredDecision & { readonly note: string | null })[];
  readonly surgeryChecks: readonly StoredSurgeryCheck[];
  readonly consents: readonly ConsentState[];
  readonly accessLog: readonly {
    readonly at: string;
    readonly role: string;
    readonly action: string;
    readonly outcome: string;
  }[];
}

const SYSTEM = 'https://fhir.glucorp.health/CodeSystem';
const ref = (type: string, id: string) => ({ reference: `${type}/${id}` });
const full = (type: string, id: string, resource: Record<string, unknown>) => ({
  fullUrl: `urn:uuid:${id}`,
  resource: { resourceType: type, id, ...resource },
});

const carePlanStatus = (s: Episode['status']) =>
  s === 'draft' ? 'draft' : s === 'closed' ? 'completed' : 'active';

/** One FHIR R4 answer per value: numbers, text, yes/no; a list becomes several answers. */
function answers(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((v) => answers(v));
  if (typeof value === 'number')
    return [Number.isInteger(value) ? { valueInteger: value } : { valueDecimal: value }];
  if (typeof value === 'boolean') return [{ valueBoolean: value }];
  if (typeof value === 'string') return [{ valueString: value }];
  return [];
}

/**
 * Her complete record as a FHIR R4 Bundle (spec 5.3 mapping): Patient (pseudonymous), CarePlan
 * and Goal per treatment, QuestionnaireResponse per weekly check-in, Flag per red-flag report,
 * Task per review decision (with the clinician's note), Consent per purpose, AuditEvent per
 * access, and pre-surgery checks as Basic resources with what the clinician saw.
 * Shadow verdicts are left out: they are not cleared for care (ADR-0028; Section 24 item 36).
 * Her name and email are in the identity vault, not here (Section 24 item 36).
 */
export function fhirExport(x: ExportInput): Record<string, unknown> {
  const entry: Record<string, unknown>[] = [
    full('Patient', x.patientId, {
      meta: { tag: [{ system: `${SYSTEM}/tag`, code: 'pseudonymous' }] },
    }),
  ];
  const subject = ref('Patient', x.patientId);
  for (const { episode: e, treatmentDisplay, goalText, checkIns, redFlags } of x.episodes) {
    const goalId = e.goal?.id;
    entry.push(
      full('CarePlan', e.id, {
        status: carePlanStatus(e.status),
        intent: 'plan',
        subject,
        period: { start: e.startDate, end: e.reviewDate },
        ...(e.previousEpisodeId ? { replaces: [ref('CarePlan', e.previousEpisodeId)] } : {}),
        ...(goalId ? { goal: [ref('Goal', goalId)] } : {}),
        activity: [
          {
            detail: {
              kind: 'MedicationRequest',
              code: {
                coding: [
                  {
                    system: e.treatmentSystem,
                    code: e.treatmentCode,
                    ...(treatmentDisplay ? { display: treatmentDisplay } : {}),
                  },
                ],
              },
              status: e.status === 'closed' ? 'completed' : 'in-progress',
              description: e.doseText,
            },
          },
        ],
      }),
    );
    if (goalId)
      entry.push(
        full('Goal', goalId, {
          lifecycleStatus: e.status === 'closed' ? 'completed' : 'active',
          description: { text: goalText ?? '' },
          subject,
        }),
      );
    for (const c of checkIns)
      entry.push(
        full('QuestionnaireResponse', c.id, {
          status: 'completed',
          questionnaire: `${SYSTEM.replace('CodeSystem', 'Questionnaire')}/weekly|${c.instrumentVersion}`,
          subject,
          basedOn: [ref('CarePlan', e.id)],
          authored: c.submittedAt.toISOString(),
          item: Object.entries((c.answers ?? {}) as Record<string, unknown>)
            .map(([linkId, v]) => ({ linkId, answer: answers(v) }))
            .filter((i) => i.answer.length > 0),
        }),
      );
    for (const r of redFlags)
      entry.push(
        full('Flag', r.id, {
          status: 'inactive',
          code: {
            coding: r.flags.map((f) => ({ system: `${SYSTEM}/red-flag`, code: f })),
          },
          subject,
          period: { start: r.shownAt.toISOString() },
        }),
      );
  }
  for (const d of x.decisions)
    entry.push(
      full('Task', d.id, {
        status: 'completed',
        intent: 'order',
        code: { coding: [{ system: `${SYSTEM}/review-decision`, code: d.decision }] },
        focus: ref('CarePlan', d.episodeId),
        for: subject,
        authoredOn: d.decidedAt.toISOString(),
        ...(d.note ? { note: [{ text: d.note }] } : {}),
      }),
    );
  for (const s of x.surgeryChecks)
    entry.push(
      full('Basic', s.id, {
        code: { coding: [{ system: `${SYSTEM}/record-type`, code: 'pre-surgery-check' }] },
        subject,
        created: s.acknowledgedAt.toISOString().slice(0, 10),
        extension: [
          {
            url: `${SYSTEM.replace('CodeSystem', 'StructureDefinition')}/pre-surgery-check`,
            valueString: JSON.stringify({ procedure: s.procedure, shown: s.snapshot }),
          },
        ],
      }),
    );
  for (const c of x.consents)
    entry.push({
      resource: {
        resourceType: 'Consent',
        status: c.status === 'granted' ? 'active' : 'inactive',
        scope: { coding: [{ system: `${SYSTEM}/consent-scope`, code: 'patient-privacy' }] },
        category: [{ coding: [{ system: `${SYSTEM}/consent-purpose`, code: c.purpose }] }],
        patient: subject,
        dateTime: c.decidedAt.toISOString(),
        policyRule: { text: `version ${String(c.version)}` },
      },
    });
  for (const a of x.accessLog)
    entry.push({
      resource: {
        resourceType: 'AuditEvent',
        type: { system: `${SYSTEM}/audit-action`, code: a.action },
        recorded: a.at,
        outcome: a.outcome === 'success' ? '0' : '4',
        agent: [{ type: { text: a.role }, requestor: true }],
        source: { observer: { display: 'Project Endo' } },
        entity: [{ what: subject }],
      },
    });
  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: x.generatedAt.toISOString(),
    entry: JSON.parse(JSON.stringify(entry)) as unknown,
  };
}
