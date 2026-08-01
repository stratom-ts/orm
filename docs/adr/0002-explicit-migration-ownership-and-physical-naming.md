# ADR 0002: Explicit Migration Ownership and Physical Naming

- Status: Accepted
- Date: 2026-08-01

## Context

Registering one table previously made every catalog table in the same PostgreSQL schema
a drop candidate. Removing a handle therefore looked like deletion intent, and granting a
destructive execution permission could approve an unrelated drop. Unnamed indexes also
used a shared readable recipe before a dialect was selected. PostgreSQL can truncate that
recipe and index names occupy a schema-wide namespace shared with other relation objects.

## Decision

Migration ownership is separate from query registration. A registered table handle owns
only its exact canonical relation identity and has complete member shape by default. An
explicit relation declaration may select additive shape. Complete shape removes undeclared
columns and indexes. Extra unique and foreign-key constraints fail as an explicit capability
limit until semantic constraint-drop steps exist. Additive shape creates and validates
declared members while preserving undeclared members.

Dropping a relation requires either an exact absent-relation tombstone or an explicit
complete-namespace declaration. Complete namespaces may have no registered relations and
therefore express an intentionally empty desired namespace. Destructive `allow()` calls
remain execution permissions only and never create ownership.

Physical names are allocated after canonical identity resolution by an internal,
adapter-owned profile. The semantic seed is serialized as canonical JSON tuples and hashed
with 64-bit FNV-1a over UTF-8. Every generated name includes the 16-digit lowercase digest.
Only its readable prefix may be truncated, in the profile's declared length unit and at a
Unicode scalar boundary. Explicit names are never truncated.

Name collision checks use adapter scope. PostgreSQL indexes and primary/unique backing
indexes use the schema-wide relation namespace; PostgreSQL foreign-key/check constraints
use the owning relation. The SQLite profile remains a fixture, not a production dialect,
and proves database-wide index scope. A table-local fixture proves scope is not shared
policy.

Unnamed catalog indexes and currently represented constraints are adopted by a unique
semantic definition only when the catalog proves supported simple semantics and validity.
Partial, expression, included-column, non-default method/order/opclass/collation, invalid,
`NULLS NOT DISTINCT`, NOT VALID, and deferrable objects fail as unsupported drift. PK and
unique constraints are checked through their backing indexes. Transitional catalog facts
must state semantic completeness, validity, and complete relation/constraint reservation
arrays explicitly; unknown facts fail closed. Legacy physical names do not cause rename-only
drift. Multiple semantic matches are ambiguous and fail planning. New objects use the
generated name in both planning and AST lowering.

## Consequences

- Shared schemas are safe by default, and removing a handle alone cannot drop its table.
- Users relying on schema-wide cleanup must opt into `completeNamespace` explicitly.
- PostgreSQL `CREATE INDEX` no longer uses `IF NOT EXISTS`; planning preflights names and
  cannot silently accept a conflicting object.
- Generated names change from the legacy readable-only recipe and always carry a digest.
- Current catalog snapshots prove namespaces only through the writable default or observed
  tables. A complete empty custom namespace can be claimed and ensured, but an already
  existing empty custom namespace is not distinguishable from an absent one. Planning may
  therefore retain an idempotent `create_schema` step until catalog evidence work adds an
  explicit namespace-existence fact. The claim still governs all observed relations in the
  exact canonical namespace and no others.
- PostgreSQL 14 compatibility for the PostgreSQL 15 `indnullsnotdistinct` catalog key is
  covered through version-safe `to_jsonb(pg_index)` query and normalization tests. A live
  PostgreSQL 14 versus 15+ integration matrix remains a residual test gap for #33.
