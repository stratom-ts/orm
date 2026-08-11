# ADR 0003: Portable Migration Coordination

- Status: Accepted
- Date: 2026-08-11
- Relates to: ADR 0001 (Canonical Relation Identity)

## Decision

Migration coordination identities are structured as a stable dialect identity,
database identity, and optional `applicationId`. The structured value is encoded
canonically before a dialect maps it to physical coordination primitives; generic
migration orchestration does not contain lock SQL.

PostgreSQL keeps the existing database-wide advisory key (`schm`/`orm\\0`) as the
legacy identity. During the compatibility window, an application-scoped run takes
that legacy key first, then a scoped key derived from SHA-256 of the canonical
identity (the first two signed 32-bit words form PostgreSQL's advisory key). It
releases acquired keys in reverse order. Omitting `applicationId` therefore retains
database-wide exclusion. Because the legacy key is held for the whole migration,
explicit application scopes do not run concurrently while this compatibility
protocol is active; coexistence of distinct scoped migrations is a future transition
after legacy acquisition is explicitly retired, not a promise of this release.

The scoped namespace is `stratom/migration` plus the canonical database and
application tuples. Application IDs and database/dialect identities must be stable,
non-empty strings without NULs or unpaired surrogates.

## Consequences

- Mixed-version deployments remain mutually excluded by the legacy key.
- Different dialects and databases cannot accidentally share a canonical scope.
- Future dialects choose their own physical coordination mechanism without adding
  dialect branches to migration orchestration.
