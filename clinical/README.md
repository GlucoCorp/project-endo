# clinical/

Clinician-owned content (spec 0 rule 5, 7, 18.5). **Engineers do not author anything in this folder.** Code reads it; humans with clinical authority decide it.

| Path                              | Contents                                                                      | Status                                |
| --------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| `instrument/checkin.v1.json`      | Weekly check-in questions, red-flag screen                                    | Spec drafts only, all `TODO_CLINICAL` |
| `rulesets/ruleset.<version>.json` | Verdict thresholds and guideline options                                      | Spec drafts only, all `TODO_CLINICAL` |
| `treatments/catalogue.v1.json`    | Treatments a clinician can choose (codes, adherence question)                 | Empty, `TODO_CLINICAL`                |
| `goals/templates.v1.json`         | Suggested goals she can choose                                                | Empty, `TODO_CLINICAL`                |
| `golden/*.json`                   | 60+ synthetic patients with expected verdicts signed off by the clinical lead | Format and runner only (M3)           |

JSON, not YAML, so no parser dependency is needed and signatures cover canonical bytes (ADR-0027). In development, empty or `TODO_CLINICAL` content is replaced by obviously synthetic placeholders (`packages/config/src/synthetic.ts`); staging and production refuse to start instead.

## Change control (spec 18.5)

1. Clinical lead approval (CODEOWNERS on this folder).
2. Updated rationale in `docs/clinical/`.
3. Regenerated golden test results.
4. Signed rule set; services verify the signature at startup (M3).

## Release gate

`pnpm check:clinical` lists every `TODO_CLINICAL` and `TODO_LICENCE`. Services refuse to start in staging or production while the active rule set contains any `TODO_CLINICAL`.
