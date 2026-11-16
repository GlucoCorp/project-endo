<!-- Produced by tools/restore-drill.mjs against the local test server (synthetic data from the integration suites). A second run with a wrong key failed at the auth-tag check, before anything was restored. -->

# Restore drill: endo_drill_src

- Backup taken: 2026-11-16T02:13:46.847Z
- Drill run: 2026-11-16T02:13:47.098Z to 2026-11-16T02:14:07.548Z
- Scratch database: `endo_drill_20261116` (dropped after the drill)
- Result: **passed**

| Check                                                | Result | Detail |
| ---------------------------------------------------- | ------ | ------ |
| Ciphertext SHA-256 matches the manifest              | pass   |        |
| Decrypted and the auth tag verified before restoring | pass   |        |
| Restored with pg_restore                             | pass   |        |
| Row counts match for 37 tables                       | pass   |        |
| No shredded patient key came back (1 schema(s))      | pass   |        |
| No erased patient record came back (1 schema(s))     | pass   |        |
| No shredded identity key came back (1 schema(s))     | pass   |        |

Counts only; no data is copied into this report.
