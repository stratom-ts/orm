# ADR 0002: Structured Migration Plan Targets

- Status: Accepted
- Date: 2026-08-10
- Relates to: ADR 0001 (Canonical Relation Identity)

## Context

Migration Plan steps addressed their targets with an optional `schema` string plus
`table`, `column`, or `index` names. That shape is PostgreSQL-specific: it cannot
represent a MySQL database, a SQLite attached-database alias, or a catalog plus schema
pair, and an omitted `schema` hid which namespace the step really resolved to. The
`create_schema` step named a PostgreSQL object rather than portable namespace intent.

ADR 0001 already resolves every relation to a role-tagged canonical identity before
lookup, comparison, and ordering. Plans then projected that identity back into a lossy
schema string, which reintroduced the representation the ADR removed and made the plan
unusable as the input to a dialect-neutral lowering seam.

The package has not shipped, so there is no persisted or external plan consumer to keep
compatible. No plan version discriminator, projector, or deprecation window is added.

## Decision

A Migration Plan step addresses exactly one structured target:

- `namespace` - role-tagged canonical namespace segments;
- `relation` - a canonical relation identity;
- `column` - a canonical relation identity plus a canonical column identifier;
- `index` - a canonical relation identity plus a canonical index identifier.

Foreign-key payloads carry the same structure: a referenced canonical relation identity
and canonical column identifier, plus optional referential actions.

`create_schema` becomes `ensure_namespace` and carries a namespace target, so a dialect
whose namespace is a database or attachment alias needs no PostgreSQL-shaped field.

Canonical order is package-wide semantic phase order, then structured target order:
namespace segments by role and comparison key, then the relation comparison key, then the
addressed member comparison key. An adapter that folds identifier case lets distinct
authored targets share comparison keys, so authored spellings break every remaining tie,
in the same precedence: namespace segment spellings, then the relation spelling, then the
member spelling. Ordering is structural and needs no identity module.

Planning stays pure, synchronous, and all-or-no-plan, is independent of destructive
`allow()` policy, and returns the resolved semantic profile (identity adapter, writable
namespace context, and registration default) beside the plan. The profile travels with
the plan's registrations rather than inside the public plan, because a plan a caller can
read is not a plan a caller can execute.

Before any DDL runs, whole-plan lowering rejects a plan whose profile differs from the
profile the executing run resolves in any of those three fields, and rejects a
target-only `create_table` step with no registered desired table.

Physical SQL fields such as a PostgreSQL `schema` clause are produced by dialect
lowering, never carried by the plan.

## Consequences

- One plan shape can describe PostgreSQL, MySQL, and SQLite namespaces without loss.
- Steps no longer need re-resolution during execution: targets are already canonical.
- Equivalent desired schemas and catalogs still produce deep-equal plans, but equality is
  promised only within one resolved semantic profile. Different profiles legitimately
  produce different targets, physical types, and generated names.
- The planning catalog carries canonical identities instead of `schema`/`name` strings,
  removing the projection that failed for dialects without a schema role.
- The consequence in ADR 0001 that plan steps retain their previous shape is superseded.
