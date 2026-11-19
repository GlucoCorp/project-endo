# @endo/verdict

**Purpose:** the verdict engine (spec 7; REQ-004). A pure, deterministic library: no I/O, no clock, no randomness. It takes an episode snapshot and a rule set and returns a verdict with an explanation trace and an input hash. Also rule set signing and verification (spec 18.5) and the golden-case runner (spec 7.4).

**Owners:** clinical engineering, with the clinical lead for every rule set value. Security-critical: 90% coverage and a named human reviewer (CLAUDE.md).

## Public API

| Export                                    | What it does                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `evaluate(snapshot, ruleset)`             | Spec 7.2 in its fixed order; red flags always win (RED_FLAG with the rest as `secondary`); every step in the trace |
| `parseRuleset(json)`                      | Checks a rule set; lists every missing, `TODO_CLINICAL` or out-of-range value. Nothing has a default               |
| `inputHash(snapshot)`, `canonical(value)` | SHA-256 of the canonical snapshot; canonical JSON (sorted keys)                                                    |
| `signRuleset`, `verifyRuleset`            | Ed25519 over `endo-ruleset-v1\n` + canonical JSON; verified against pinned public keys                             |
| `runGoldenCases(cases, ruleset)`          | Pass, fail, or pending while the expected verdict is `TODO_CLINICAL`                                               |
| `SnapshotError`                           | A malformed snapshot (wrong number of weeks, overlapping windows) is refused, never guessed                        |

## What the engine does not decide

Every threshold and every choice spec 7.2 leaves open (Section 24 items 25 to 27: what counts as valid, how the benefit windows are aggregated and compared, how "partly" and "didn't apply" count, device adherence, the modifiers) is a rule set value from the clinical lead. While any is missing the services generate no verdict at all (shadow mode records why). Tests use a rule set marked TEST-ONLY whose numbers have no clinical standing.
