# ADR-0028: Verdict engine, signed rule sets and shadow mode

- **Status:** accepted (decided under the product owner's delegation, 2026-11-15)
- **Requirements:** REQ-004; spec 7, 18.5, 22 (M3); RISK-C01, RISK-T01

## Context

Spec 7 defines a pure verdict engine, a signed rule set and golden cases, and M3 runs verdicts in shadow mode: generated and compared with clinicians' judgement, not shown in care. Every threshold is `TODO_CLINICAL`, and spec 7.2 leaves several steps undefined (Section 24 items 25 to 27). Engineers must not decide clinical logic (spec 0 rule 5).

## Decision

1. **`packages/verdict`** is a pure library (no I/O, clock or randomness): `evaluate(snapshot, ruleset)` runs spec 7.2 in order and returns the verdict, secondary result, modifiers, a trace with values and thresholds for every step, and the SHA-256 of the canonical snapshot. Red flags always win, even when the rest of the snapshot cannot be judged. Snapshots are validated (finite, in range, from the instrument's lists); a malformed one is refused, never guessed. Missing weeks are null, never imputed.
2. **Nothing has a default.** `parseRuleset` requires every threshold, approval metadata and no `TODO_CLINICAL` anywhere. Where spec 7.2 is undefined, the engine implements one named definition per step (`definitions.validity`, `adherence_daily`, `intolerance`, `benefit`, `modifiers`, `empty_goal`, documented in the package README) and the rule set must choose it explicitly, so a signed rule set is the clinical lead's decision on each. Another definition is a code change with a new name.
3. **Signing (18.5):** Ed25519 (Node `crypto`) over `endo-ruleset-v1\n` plus the canonical JSON of the rule set; `tools/sign-ruleset.mjs` signs (refusing an incomplete rule set) and writes `<rule set>.sig.json`; the API verifies at startup against `ENDO_RULESET_PUBLIC_KEYS`. Deployed environments refuse to start unsigned or with a bad signature; development may run unsigned and records that in each verdict.
4. **Shadow mode:** clinical migration 0010 `verdict` stores every attempt (append-only, `shadow` forced true by the database): the verdict, rule set version and digest, instrument version, input hash and explanation, or the reason none was generated (`ruleset_incomplete`, `snapshot_invalid`). Generation runs hourly for episodes due 3 days before review (once per episode and rule set version, via a cross-organisation lookup function that returns ids only) and on a clinician's request (`verdict.generate`, consent required). The on-demand response says only whether a verdict was generated, never what it is.
5. **Golden cases:** `runGoldenCases` reports pass, fail, or pending while the expected verdict is `TODO_CLINICAL`; expectations must be explicit; a case that throws fails alone.

## Consequences

- Until the clinical lead completes and signs the rule set, every attempt records `ruleset_incomplete`: the pipeline is exercised end to end, and no verdict exists.
- Comparing shadow verdicts with clinicians' judgement needs a reviewer view (M4) over the stored attempts.
- Weeks still inside their 7-day window at generation are counted as missing and reported (`open_weeks`) in the explanation; whether to wait for them is a clinical question for the rule set owners.
