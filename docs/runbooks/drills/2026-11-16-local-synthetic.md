<!-- Produced by tools/restore-drill.mjs against the local test server (synthetic data from the integration suites). -->

# Restore drill: endo_drill_src

- Backup taken: 2026-11-16T01:10:53.907Z
- Drill run: 2026-11-16T01:10:54.064Z to 2026-11-16T01:11:12.428Z
- Scratch database: `endo_drill_20261116` (dropped after the drill)
- Result: **passed**

| Check                                                      | Result | Detail |
| ---------------------------------------------------------- | ------ | ------ |
| Ciphertext SHA-256 matches the manifest                    | pass   |        |
| Decrypted (auth tag verified) and restored with pg_restore | pass   |        |
| Row counts match for 37 tables                             | pass   |        |
| No shredded patient key came back (1 schema(s))            | pass   |        |
| No erased patient record came back (1 schema(s))           | pass   |        |
| No shredded identity key came back (1 schema(s))           | pass   |        |

Counts only; no data is copied into this report.
