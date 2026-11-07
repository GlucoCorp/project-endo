# @endo/domain

**Purpose:** shared domain types, value objects and invariants (spec 5, 8.2). No I/O.

**Owners:** platform engineering.

## Public API

| Export                       | What it does                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `uuidv7(nowMs?)`             | Time-ordered UUIDv7 using the platform CSPRNG (spec 5.1: all IDs are UUIDv7) |
| `isUuidV7(v)`, `isUuid(v)`   | Validate opaque IDs at boundaries                                            |
| `OpaqueId`                   | Branded string type for IDs that reveal nothing about the person             |
| `ROLES`, `Role`, `isRole(v)` | Roles from spec 3.1                                                          |

Entities from spec 5.1 are added here as they are built (M1 onwards).
