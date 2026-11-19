# ADR-0027: Clinical content as JSON, with synthetic placeholders in development

- **Status:** accepted (decided under the product owner's delegation, 2026-11-15)
- **Requirements:** REQ-002, REQ-003, REQ-004; spec 0 rule 5, 6, 7.3, 18.5; RISK-C01, RISK-T01

## Context

Spec 6 and 7.3 name `clinical/instrument/checkin.v1.yaml` and `clinical/rulesets/ruleset.<version>.yaml`. Until M2 the services only scanned the rule set's text for `TODO_CLINICAL`. M2 must read the instrument's structure (question ids, answer types, option lists, red flags) to validate check-ins on the server, and needs a treatment catalogue and suggested goals, neither of which exists yet. M3 signs the rule set (18.5), which needs exact, canonical bytes.

No YAML parser is in the dependency tree, and every new dependency needs an ADR approved by the product owner (spec 0 rule 3). YAML parsing also has well-known ambiguities (implicit types, `no`/`off` booleans, duplicate keys) that matter for clinical values.

Engineers must not author clinical content (spec 0 rule 5; `clinical/README.md`), yet screens and flows must be built and tested before the clinical lead fills the catalogue and goals.

## Decision

1. Clinical content is JSON: `instrument/checkin.v1.json`, `rulesets/ruleset.<version>.json`, `treatments/catalogue.v1.json`, `goals/templates.v1.json`, later `golden/*.json`. The two YAML files were transcribed one to one (same keys, same `TODO_CLINICAL` markers) and removed. Notes that YAML held as comments are `_about` and `draft_notes` fields.
2. `@endo/config` `loadClinicalContent` parses and checks the files with Node's own `JSON.parse` and explicit checks (no schema library). In staging and production any `TODO_CLINICAL` refuses startup, as before.
3. In local, dev and test, an unfinished list (treatments, goals, side-effect options) is replaced by **obviously synthetic placeholders** (`packages/config/src/synthetic.ts`: "Synthetic daily tablet (placeholder)", code system `urn:endo:synthetic`). The content is marked `draft`, which the apps show. The API refuses the synthetic code system when deployed, and staging and production cannot start with unfinished content anyway.
4. Signatures (M3) cover canonical JSON (sorted keys, no whitespace; `canonicalJson`).

## Alternatives

- **Add a YAML parser (`yaml`, ISC).** Well maintained, but a new runtime dependency on the clinical path, with YAML's type ambiguities; needs product-owner approval. Can be revisited if clinicians find JSON hard to edit; the loader is the only place that changes.
- **Keep YAML and hand-write a subset parser.** Fragile, and a parser bug would silently change clinical values.
- **Hard-code the instrument structure in TypeScript.** Two sources of truth for clinician-owned content.

## Consequences

- Clinicians edit JSON (no comments). Review happens in pull requests with CODEOWNERS on `clinical/`, as before.
- The service image copies all four content folders (`Dockerfile`, `.dockerignore`).
- Spec 6 and 7.3 file names are superseded by this ADR; the spec text is otherwise unchanged.
