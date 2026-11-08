# ADR-0009: Envelope encryption with per-patient data keys behind `KeyManager`

- Status: accepted
- Date: 2026-11-07
- Requirements/Risks: spec 2.4, 11.2, REQ-009; RISK-I01

## Context

Spec 11.2: field-level envelope encryption (AES-256-GCM via KMS-generated data keys) for free-text and identity fields; per-patient data keys enabling crypto-shredding; never implement crypto primitives; KMS behind an interface so AWS and Kenya/Rwanda (Vault) are a deployment choice (8.1, 17.3).

## Decision

- `KeyManager` interface: `generateDataKey(keyRef)`, `unwrapDataKey(keyRef, wrapped)`, matching KMS `GenerateDataKey`/`Decrypt` and Vault Transit `datakey`/`decrypt`.
- `KeyRef` names the spec 11.1 keys (`kms/identity`, `kms/clinical`, ...).
- `FieldCipher`:
  - one wrapped data key per patient in `PatientKeyStore`, created on first encrypt, never on decrypt;
  - AES-256-GCM from `node:crypto`, random 96-bit IV per value;
  - associated data = `["v1", patientId, field, recordId]`, so ciphertext moved to another patient, column or row fails;
  - format `v1.<iv>.<ciphertext>.<tag>` (base64url);
  - plaintext data keys zeroed after each use;
  - errors are generic and never include data.
- Crypto-shredding: `shredPatient(id)` deletes the wrapped key; afterwards decrypt and encrypt both fail with `KeyDestroyedError`.
- `DevKeyManager` (in-memory random master keys) refuses to construct in staging/production.

## Consequences

- Each field operation currently unwraps the data key via KMS. A short-lived in-memory cache will need its own ADR (cache lifetime versus KMS cost and exposure).
- AWS KMS and Vault Transit implementations come with the infrastructure slice.

## Alternatives considered

- Database-level column encryption (pgcrypto): keys reach the database; no per-patient crypto-shredding. Rejected.
- Libsodium bindings: native build step and an extra dependency for what `node:crypto` already provides. Rejected.

## Dependencies

None added (`node:crypto` only).
