# ADR-0032: OpenBao Transit as the key manager

- **Status:** accepted (decided under the product owner's delegation, 2026-11-16)
- **Requirements:** spec 11.1, 11.2, 17.3; RISK-I01; ADR-0009 (KeyManager interface), ADR-0014 (OpenBao)

## Context

Every service refuses to start in staging and production with the development key manager. The zero-cost self-hosted stack (ADR-0014, ADR-0023) runs OpenBao, whose Transit engine keeps master keys inside OpenBao and wraps data keys for us.

## Decision

1. `OpenBaoKeyManager` in `@endo/crypto` implements `KeyManager` over the Vault-compatible HTTP API with `fetch` (no new dependency): `datakey/plaintext/<key>` mints a 256-bit data key; `decrypt/<key>` unwraps it. The wrapped form is the Transit ciphertext (`vault:v1:...`).
2. One Transit key per logical key (`kms/clinical` to `endo-clinical`, and so on), so a key wrapped for one store never unwraps as another (verified against OpenBao 2.7.2).
3. Keys are created `aes256-gcm96`, not exportable, not deletable (`infra/modules/platform/openbao.tf`, Job `openbao-transit-setup`). Crypto-shredding stays per patient: we delete her wrapped key, never a Transit key.
4. The token is read from a file on every call, so OpenBao Agent or a Kubernetes-auth sidecar can rotate it. https is required except on loopback. Errors never carry OpenBao's response body.
5. Services use it when `ENDO_KMS_OPENBAO_ADDR` and `ENDO_KMS_OPENBAO_TOKEN_FILE` are set; otherwise the development stand-in, which refuses staging and production (fail closed).

## Consequences

- OpenBao is on the path of every encryption and decryption of a data key: its availability is the services' availability for health data. The shared and production profiles need OpenBao in server mode with integrated storage and an unseal procedure (still to build: the module refuses that profile today).
- Transit key rotation (`transit/keys/<k>/rotate`) adds a version; old ciphertexts keep decrypting.
