# ADR 0001: Canonical Relation Identity

- Status: Accepted
- Date: 2026-07-27

## Context

Migration registration, catalog lookup, diagnostics, and Migration Plan ordering used
`schema.relation` strings. Dots are legal in quoted identifiers, so this encoding can
merge distinct relations. A shared omitted-schema fallback to PostgreSQL `public` also
cannot represent PostgreSQL session defaults or SQLite database aliases correctly.

## Decision

A canonical relation identity is a fully resolved, role-tagged tuple. Each ordered
namespace segment records its role, original spelling, and adapter-produced comparison
key; the relation records its spelling and comparison key separately.

Equality compares namespace roles and comparison keys positionally, then the relation
comparison key. Sorting performs the same tuple comparison with locale-independent
UTF-16 code-unit ordering. Dotted strings are display only and are not used for
registration, lookup, comparison, or ordering.

Omitted namespaces resolve once before migration lookup or planning. An explicit
registration default takes precedence over the selected dialect/session writable
default. There is no shared `public` fallback. PostgreSQL omission equals explicit
`public` only when the resolved context names `public`.

PostgreSQL identities contain database, schema, and relation. SQLite identities contain
database alias and relation.

## Consequences

- Legal dots, quotes, case differences, and Unicode sequences cannot collide through
  serialization.
- Catalog and desired relations compare under one resolved session context.
- Existing PostgreSQL Migration Plan steps retain their current shape but project the
  resolved schema, making omitted and explicit defaults equal.
- Dialect identifier comparison remains private to the canonical identity module rather
  than becoming a callback bag for migration callers.
