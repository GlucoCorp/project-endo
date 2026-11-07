# @endo/crypto

**Purpose:** envelope encryption helpers wrapping KMS (spec 11.2). **No custom cryptography**: AES-256-GCM from `node:crypto` only.

**Owners:** security engineering (CODEOWNERS). Every change needs a named human security reviewer (spec 12.11).

## Public API

| Export                                       | What it does                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `KeyManager`, `KeyRef`, `DataKey`            | Cloud-neutral KMS interface (AWS KMS, Vault Transit)                                |
| `DevKeyManager`                              | In-memory stand-in for dev and test. Throws if constructed in staging or production |
| `PatientKeyStore`, `InMemoryPatientKeyStore` | Per-patient wrapped data keys; `destroy()` is the crypto-shred                      |
| `FieldCipher`                                | `encrypt(text, ctx)`, `decrypt(envelope, ctx)`, `shredPatient(id)`                  |

## Guarantees

- Ciphertext format `v1.<iv>.<ciphertext>.<tag>`, 96-bit random IV per call.
- Associated data binds each ciphertext to `{patientId, field, recordId}`; copying it elsewhere fails.
- Plaintext data keys are zeroed after each use.
- Errors never contain plaintext and do not say which check failed.

## Not yet built

- AWS KMS and Vault Transit `KeyManager` implementations (M0 infra slice).
- Postgres `PatientKeyStore` (M1).
- Data-key caching (needs an ADR on cache lifetime versus KMS cost).
