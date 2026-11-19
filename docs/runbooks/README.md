# Runbooks

Operations runbooks (spec 12.5, 12.8, 12.10, 23). Each is written before the capability it covers goes to staging, and reviewed after every incident or drill.

| Runbook                                        | Covers                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| [deploy.md](deploy.md)                         | Releases: checks, signed images, migrations, rollout, smoke tests                   |
| [rollback.md](rollback.md)                     | Rolling back a release; forward-only migrations                                     |
| [key-rotation.md](key-rotation.md)             | One row per secret type (spec 12.5)                                                 |
| [incident-response.md](incident-response.md)   | Severity, roles, 72 h GDPR / Kenya DPA, HIPAA 60 days, templates (spec 12.10)       |
| [backups.md](backups.md)                       | Point-in-time recovery, encrypted daily dumps (`tools/backup.mjs`), retention       |
| [restore.md](restore.md)                       | Quarterly drill (`tools/restore-drill.mjs`), production restore with erasure replay |
| [erasure.md](erasure.md)                       | REQ-009 deletion: what the jobs process does, the Keycloak operator step, checks    |
| [staff-provisioning.md](staff-provisioning.md) | Staff accounts, first admin, invitations (REQ-010)                                  |
| [access-requests.md](access-requests.md)       | Just-in-time access for GluCorp staff (spec 10.3)                                   |

Drill reports: [drills/](drills/).
