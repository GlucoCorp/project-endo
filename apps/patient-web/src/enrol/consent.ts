import type { MessageKey } from '@endo/i18n';

/**
 * Spec 13.1: the four purposes, asked one per screen in this order, each with its own
 * explanation and version. Neither answer is pre-selected or favoured (spec 21.7 screen 2).
 *
 * The explanation texts are version 1 DRAFTS (TODO_LEGAL: data protection officer review before
 * real use). Changing a text's meaning means raising its version here, so what she agreed to is
 * always the text of the version recorded with her decision.
 */
export const PURPOSES = [
  'self_tracking',
  'share_with_care_team',
  'research_deidentified',
  'org_aggregate_reporting',
] as const;
export type Purpose = (typeof PURPOSES)[number];

export const VERSIONS: Readonly<Record<Purpose, number>> = {
  self_tracking: 1,
  share_with_care_team: 1,
  research_deidentified: 1,
  org_aggregate_reporting: 1,
};

export const text = (p: Purpose, part: 'title' | 'text' | 'grant' | 'decline'): MessageKey =>
  `consent.${p}.${part}`;

export interface Decision {
  readonly status: 'granted' | 'declined';
  readonly version: number;
  readonly decided_at: string;
}
export type Decisions = Partial<Record<Purpose, Decision>>;

/**
 * Records one answer. Declining self-tracking ends the questions at once (enrolment stops), so
 * the remaining purposes are recorded as declined: nothing is shared by default.
 */
export function answer(
  so: Decisions,
  purpose: Purpose,
  status: 'granted' | 'declined',
  now: Date,
): { decisions: Decisions; done: boolean } {
  const at = now.toISOString();
  const versions = new Map<Purpose, number>(Object.entries(VERSIONS) as [Purpose, number][]);
  const next = new Map<Purpose, Decision>(Object.entries(so) as [Purpose, Decision][]);
  const decide = (p: Purpose, s: 'granted' | 'declined') => {
    next.set(p, { status: s, version: versions.get(p) ?? 1, decided_at: at });
  };
  decide(purpose, status);
  const stop = purpose === 'self_tracking' && status === 'declined';
  if (stop) for (const p of PURPOSES) if (!next.has(p)) decide(p, 'declined');
  return {
    decisions: Object.fromEntries(next),
    done: stop || PURPOSES.every((p) => next.has(p)),
  };
}
