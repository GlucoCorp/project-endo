import { isDeployedEnvironment, type EnvironmentName } from './load.ts';

/** Marker for clinical content that has not been signed off (spec 0 rule 5, 7.3). */
export const CLINICAL_TODO_MARKER = 'TODO_CLINICAL';

export class ClinicalNotReadyError extends Error {
  readonly occurrences: number;

  constructor(env: EnvironmentName, occurrences: number) {
    super(
      `Refusing to start in ${env}: active clinical rule set contains ${occurrences} ` +
        `${CLINICAL_TODO_MARKER} marker(s). Clinical sign-off is required (spec 7.3).`,
    );
    this.name = 'ClinicalNotReadyError';
    this.occurrences = occurrences;
  }
}

/**
 * Startup gate: in staging or production, refuse to run if the active rule set still contains any
 * `TODO_CLINICAL` marker. In dev and test the placeholders are allowed so work can proceed.
 *
 * This is a plain text scan on purpose: it cannot be fooled by a parser quirk, and any occurrence
 * (value, comment or key) blocks release. Signature verification of the rule set is separate
 * (spec 18.5, milestone M3).
 *
 * REQ-004, RISK-C01
 */
export function assertClinicalReleaseReady(env: EnvironmentName, rulesetText: string): void {
  if (!isDeployedEnvironment(env)) {
    return;
  }
  const occurrences = rulesetText.split(CLINICAL_TODO_MARKER).length - 1;
  if (occurrences > 0) {
    throw new ClinicalNotReadyError(env, occurrences);
  }
}
