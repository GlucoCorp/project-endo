# Golden cases

At least 60 synthetic patients covering every verdict and boundary (spec 7.4), each with an expected verdict signed off by the clinical lead.

**Format (ADR-0027, ADR-0028):** `clinical/golden/*.json`, each an array of `{ "id", "description", "snapshot", "expected" }`. `snapshot` is the engine's input (`@endo/verdict` `Snapshot`: one entry per week, `null` for a missing week, and the red-flag count). `expected` is `"TODO_CLINICAL"` until the clinical lead sets `{ "code", "secondary", "modifiers" }`, all three explicit. `runGoldenCases` reports each case as pass, fail or pending; a pending case never counts as passing.

Engineers may write candidate synthetic snapshots; the expected verdict for each case is set by the clinical lead, never by an engineer. No case files exist yet: they follow the approved rule set.
