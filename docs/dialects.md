# Dialect members

Stratom treats a dialect as one complete module of database semantics. PostgreSQL,
future SQLite and MySQL implementations, and custom implementations are all members of
the same `Dialect` interface. PostgreSQL is currently the only production-supported
member. The SQLite-shaped member in the test suite is a contract fixture, not production
SQLite support.

Applications always select a member with the db0 connector:

```typescript
const db = createDatabase({
  connector: postgresql({ url: process.env.DATABASE_URL! }),
  schemas: [User],
})
```

`connector.dialect` is the sole dialect selector. There is no separate dialect argument,
dialect option, or configuration that can override it. An explicit
`operationSessionProvider` is an advanced connector-adaptation seam: it may replace how
physical sessions are opened, used, cancelled, released, and closed, but it does not
select or replace any Dialect behavior. Query compilation, catalog observation, schema
lowering, and migration behavior still come from the member selected by
`connector.dialect`.

## The complete interface

A member owns all seven facets below. A capability may be explicitly unsupported, but
it must not fall through to PostgreSQL behavior or require a database-specific branch in
Client, Schema, Query, Migration, or Operations.

### Outward failure contract

The public boundary, rather than a member's private helper, determines the error callers
observe. Maintainers should preserve this mapping and the original cause where the
boundary supports one:

| Facet or boundary                                 | Outward failure or unsupported mechanism                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector selection and package/test registration | `SchemaError` for an unknown connector dialect, invalid member id, or duplicate registration.                                                                                                                                                                                                                                                            |
| Identity and naming                               | Invalid authored registrations are `SchemaError`; failures reached while planning or lowering a migration are normalized to `MigrationError` at the applicable planning/lowering stage. Internal invariant errors are not a promised application-facing dialect contract.                                                                                |
| Schema                                            | Invalid table metadata is `SchemaError`. Unsupported physical types, defaults, generation, references, or whole-graph lowering fail as `MigrationError`.                                                                                                                                                                                                 |
| Query and value mapping                           | Invalid query construction and query/session execution fail as `QueryError`; insert/update value validation fails as `ValidationError`. Invalid mapper configuration discovered while creating a client is `SchemaError`. A member compiler must fail explicitly, but direct compiler calls have no additional tag-normalization promise.                |
| Catalog                                           | A successfully returned snapshot represents missing knowledge with `CatalogFact`, `CatalogCoverage`, and `CatalogCapability` tags (`unsupported`, `unavailable`, `unmanaged`, or `unknown` where allowed), not an exception or an invented absence. Introspection failures reached through migration become `MigrationError` with stage `introspection`. |
| Operations/provider                               | Invalid provider or session capability and query/run failures become `QueryError`. During migration, session failures become `MigrationError` with stage `sessionCleanup`; a secondary release failure is retained in `cleanupFailures` rather than replacing the primary error.                                                                         |
| Migration                                         | Whole-plan inability is returned from `lower()` as capability issues. The public migrate builder exposes those as `MigrationError` with stage `lowering` and outcome `unchanged`. Runtime failures carry the member-observed stage and outcome; successful execution returns only `applied` or `unchanged`.                                              |

Do not use an exception to mean “catalog evidence unavailable,” and do not return a
partial migration program beside capability issues. Conversely, a connector/session
failure is not catalog capability evidence and must follow the query or migration error
path above.

### Identity and namespace

`identity.id` is the stable identity-adapter key used by a Migration Plan's Semantic
Profile. `identity.create()` combines the member's identifier comparison rules with the
session's writable namespace context and an optional registration default. It produces
canonical relation identities: ordered, role-tagged namespace segments plus a relation
identifier. These structures, rather than dotted strings, are the inputs to equality,
registration, lookup, and ordering.

The member validates its namespace shape and resolves omitted namespaces exactly once.
There is no shared `public` fallback. Invalid or incompatible identity input fails
explicitly with a tagged schema, migration, or invariant error at the boundary that
consumes it.

### Physical naming

`naming` generates and validates physical identifiers and creates collision registries.
The member owns maximum length, length units, comparison keys, and uniqueness scopes.
Generation accepts a semantic `PhysicalNameSeed`; it must be deterministic for the same
seed and Semantic Profile. Validation and registry collisions fail explicitly instead
of silently truncating or borrowing another member's policy.

### Schema lowering

`schema.lowerDesiredSchema()` receives the complete, canonically ordered and
reference-validated authored schema graph. It lowers the whole graph so cross-table
references and selected-member type overrides are resolved consistently, returning one
physical create-table AST per authored table while preserving its handle and canonical
identity.

`inferColumnType()` maps logical Valibot intent to a physical type.
`normalizeDataType()` supplies catalog-comparison form, and
`normalizeDefaultValue()` may supply default-value comparison form. Unsupported type,
default, generation, or reference forms fail with `MigrationError`; they never degrade
to a convenient PostgreSQL or text default.

### Query compilation and values

`query.compile()` accepts Stratom's dialect-neutral query/DDL AST and returns
parameterized SQL plus ordered parameters. Optional `mapParamValue()` and
`mapResultValue()` convert values at the selected member boundary. Compilation must
honour structured relation input and must reject unsupported AST behavior explicitly;
it must not reinterpret another member's namespace conventions.

### Catalog observation

`catalog.introspectCatalog()` receives an executor and a scoped `CatalogRequest`. The
request identifies the relations, absent relations, and complete namespaces for which
evidence is needed. The returned snapshot includes its source dialect/version, the
resolved request, writable namespace context, observations, coverage, diagnostics, and
capability evidence.

Evidence is never inferred from missing rows. Facts are tagged `present`, `absent`, or a
no-evidence state. Sets have `complete` or `partial` coverage (or a no-evidence state).
Capabilities are either `supported` with a fidelity, `unsupported` by the engine or
adapter with a reason, or `unavailable` because of permission or version evidence. A
member may therefore omit a feature without pretending that the corresponding database
objects are absent.

### Operations and connector adaptation

`operations.createSessionProvider(connector)` adapts the exact selected db0 connector to
exclusive physical operation sessions. `operations.compile()` compiles structured ping,
transaction, rollback, and savepoint commands. A custom provider can replace only the
first responsibility; the selected member still compiles lifecycle commands and owns
all other facets.

An `OperationSessionProvider` must advertise `nativeTransactions: true`, implement
`open()` and `close()`, and return sessions with `query`, `run`, `cancel`, and
`release('reuse' | 'discard')`. Each session exposes non-empty `database` and
`physicalSession` identity strings. Those values must identify the same database and
physical backend for the entire lease. A changing or unprovable identity is an error and
the session is discarded.

One root operation exclusively owns one pinned session. Root operations are FIFO; close
stops new work, drains accepted work and its releases, then closes the provider once.
Calls on one physical session are serialized. Nested transaction work reuses the pinned
session, while savepoint commands serialize within it. Cancellation is forwarded to the
active session. Uncertain state, failed
migration cleanup, or an explicit discard request selects `discard`; otherwise release
uses `reuse`. Release and provider-close cleanup occur after queued work. A release
failure never replaces an existing primary failure: migration errors retain it in
`cleanupFailures` as `sessionCleanup` evidence.

### Migration planning, lowering, and execution

`migration.planning` binds the member's identity, naming, and schema policies.
`migration.catalog` supplies both dry-run and authoritative execution observations.
Generic planning produces a stable, canonically ordered Migration Plan whose Migration
Targets are structured canonical namespace, relation, column, or index identities.

`migration.lower()` receives the entire planned migration plus the Semantic Profile
resolved for execution. Lowering is pure and all-or-nothing: it returns one complete
`MigrationProgram`, or capability issues with codes, messages, and source step indexes.
It rejects a mismatched Semantic Profile before DDL and does not partially lower a plan.

`migration.execute()` owns physical coordination and execution. A supporting member
must report successful completion as `applied` or `unchanged`. Failures use
`MigrationError` with the observed stage and one of `unchanged`, `rolledBack`, `applied`,
`partial`, or `unknown`; retryability and cleanup failures remain explicit. Members that
cannot implement a migration capability return deterministic lowering issues or tagged
errors rather than running a partial approximation.

## Registering and testing a member

Package-supported members are statically registered in `src/dialects/resolve.ts` by
their db0 `SQLDialect` id. Adding support consists of implementing one complete member
and adding that dispatcher registration. Do not add a runtime plugin registry or
database-specific logic to Client, Schema, Query, Migration, or Operations.

The private `registerDialectForTest()` seam exists only for isolated contract tests. It
is deliberately not a package export. Maintainers can adapt their member to the reusable
`tests/dialects/dialectMemberContract.ts` suite, and connector/session adaptations to
`tests/dialects/operationSessionProviderContract.ts`. The member contract exercises the
observable `createDatabase({ connector, ... })` lifecycle and accepts explicit catalog
no-evidence and unsupported migration capabilities. The provider contract verifies
identity, serialized lifecycle and shutdown, cancellation, discard, cleanup
preservation, and—when its migration scenarios are supplied—`applied` and `unchanged`
outcome preservation.

The minimal test member in `tests/helpers/extensionContractDialect.ts` demonstrates the
extension boundary. It supplies every Dialect facet, is selected only by its connector,
and requires no edits to the architectural consumers.
