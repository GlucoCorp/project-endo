/**
 * Obviously synthetic stand-ins for clinical content that is still `TODO_CLINICAL` (spec 0 rule 5).
 * Used only in local, dev and test, so screens and flows can be built and tested; staging and
 * production refuse to start while any clinical content is unfinished. None of this is clinical
 * advice, and every label says so.
 */
export const SYNTHETIC_TREATMENT_SYSTEM = 'urn:endo:synthetic';

export const SYNTHETIC_TREATMENTS = [
  {
    system: SYNTHETIC_TREATMENT_SYSTEM,
    code: 'SYNTH-DAILY',
    display: 'Synthetic daily tablet (placeholder)',
    adherenceMode: 'daily',
  },
  {
    system: SYNTHETIC_TREATMENT_SYSTEM,
    code: 'SYNTH-DEVICE',
    display: 'Synthetic device (placeholder)',
    adherenceMode: 'device_or_injection',
  },
] as const;

export const SYNTHETIC_GOALS = [
  { code: 'synthetic_goal_a', text: 'Synthetic goal A (placeholder)' },
  { code: 'synthetic_goal_b', text: 'Synthetic goal B (placeholder)' },
] as const;

export const SYNTHETIC_SIDE_EFFECTS = ['synthetic_effect_a', 'synthetic_effect_b'] as const;
