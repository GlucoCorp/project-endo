# ADR-0001: Record architecture decisions

- Status: accepted
- Date: 2026-11-07
- Requirements: all (spec 0 rule 3, 9; spec 23)

## Context

Project Endo is medical-grade software heading for IEC 62304 / IEC 81001-5-1 readiness. Reviewers, auditors and future engineers need to know why each technical choice was made, and every new dependency must be justified (spec 0 rule 3).

## Decision

- Architecture decisions live in `docs/adr/NNNN-kebab-title.md`, numbered sequentially, never renumbered.
- Each ADR has: Status, Date, Requirements/Risks, Context, Decision, Consequences, Alternatives considered.
- **Every new dependency** (runtime or dev) is added only with an ADR that records: why it is needed, alternatives (including "write it ourselves" and "standard library"), maintainer health, licence, and supply-chain risk. A dependency table at the end of each ADR records these.
- Superseding an ADR: write a new one, mark the old one `superseded by ADR-NNNN`. Do not edit accepted decisions in place except to fix typos or the status line.

## Consequences

- Dependency additions are slower, which is intended.
- ADR review is part of every PR that changes architecture or dependencies.

## Alternatives considered

- Wiki pages: drift from the code and are not reviewed in the same PR. Rejected.
