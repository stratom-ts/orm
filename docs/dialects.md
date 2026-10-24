# Dialect members

Stratom treats a dialect as one complete module of database semantics. PostgreSQL,
SQLite, future MySQL implementations, and custom implementations are all members of
the same `Dialect` interface. PostgreSQL and SQLite are statically registered production
members. Both exercise the reusable member, migration, lifecycle and integration contracts.

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

A member owns every facet below, including native failure classification. A capability may be explicitly unsupported, but
it must not fall through to PostgreSQL behavior or require a database-specific branch in
Client, Schema, Query, Migration, or Operations.

### Outward failure contract

The public boundary, rather than a member's private helper, determines the error callers
observe. Maintainers should preserve this mapping and the original cause where the
boundary supports one:

| Facet or boundary                                 | Outward failure or unsupported mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector selection and package/test registration | `SchemaError` for an unknown connector dialect, invalid member id, or duplicate registration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Identity and naming                               | Empty, NUL-containing, unpaired-surrogate, overlong, or colliding authored identifiers are `SchemaError` at registration or direct validation. Authored identifiers rejected while resolving a catalog request remain `SchemaError` through preview and execution. Physical naming failures during planning become `MigrationError` with stage `planning` and outcome `unchanged`. A naming profile that cannot fit its digest remains an `InvariantError`. Unrecognized preview failures preserve their thrown value and stack; execution reports them as `MigrationError` with `defect: true`.                                                     |
| Schema                                            | Invalid table metadata and direct PostgreSQL type/default validation are `SchemaError`. Unsupported physical types, defaults, generation, references, or whole-graph lowering fail as `MigrationError`. Invalid migration ownership declarations remain `SchemaError` through planning and execution when cleanup succeeds. If cleanup fails, execution reports a non-defect `MigrationError` with the original `SchemaError` as its cause and cleanup evidence.                                                                                                                                                                                     |
| Query and value mapping                           | Recognized query failures remain `QueryError`; insert/update value validation fails as `ValidationError`. Executor failures not recognized as expected errors and result-mapping defects propagate unchanged, including their original stack. Invalid mapper configuration discovered while creating a client is `SchemaError`. A member compiler must fail explicitly, but direct compiler calls have no additional tag-normalization promise.                                                                                                                                                                                                      |
| Catalog                                           | A successfully returned snapshot represents missing knowledge with `CatalogFact`, `CatalogCoverage`, and `CatalogCapability` tags (`unsupported`, `unavailable`, `unmanaged`, or `unknown` where allowed), not an exception or an invented absence. Concurrent PostgreSQL catalog changes are `MigrationError` with stage `introspection`, outcome `unchanged`, and `retryable: true`. Malformed PostgreSQL returned rows remain `InvariantError`; SQLite can report malformed metadata as unknown coverage with a diagnostic. Unrecognized preview introspection failures propagate unchanged; execution reports stage/outcome with `defect: true`. |
| Operations/provider                               | Recognized provider/session capability errors remain tagged expected errors; unrecognized provider, query, or run failures are not converted into `QueryError`. A migration execution boundary reports its stage/outcome and marks such defects with `defect: true`. Provider-release failures remain secondary evidence: they are attached to migration `cleanupFailures` when structured, or retained by the coordinator beside an object-valued preview defect without replacing its identity.                                                                                                                                                    |
| Migration                                         | Whole-plan inability is returned from `lower()` as capability issues. The public migrate builder exposes those deterministically in `MigrationError.capabilityIssues`, with stage `lowering`, outcome `unchanged`, and no physical actions. Preview preserves unrecognized planning/lowering defects by identity and stack. Execution reports stage/outcome with `defect: true` and the original thrown value as `cause`; expected `MigrationError` values remain non-defects. Successful execution returns only `applied` or `unchanged`.                                                                                                           |

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

Public table authoring supplies only ordered, role-tagged `namespace` intent. Schema
construction preserves omission as unresolved intent, and table/reference metadata
retains only structured relation and column targets; it does not carry PostgreSQL
`schema` shorthand or duplicate flat foreign-key addresses.

### Physical naming

`naming` generates and validates physical identifiers and creates collision registries.
The member owns maximum length, length units, comparison keys, and uniqueness scopes.
Generation accepts a semantic `PhysicalNameSeed`; it must be deterministic for the same
seed and Semantic Profile. Validation and registry collisions fail explicitly instead
of silently truncating or borrowing another member's policy.

### Schema lowering

`schema.lowerDesiredSchema()` receives the complete, canonically ordered and
reference-validated authored schema graph. It lowers the whole graph so cross-table
references and selected-member type overrides are resolved consistently. Each result
preserves the table's handle and canonical identity, canonical column and primary-key
members, physical column properties, and structured canonical foreign-key references.
Engine-specific create-table AST projection happens only inside the selected member's
migration lowering.

Package-supported members route that graph through the internal
`lowerDesiredSchemaGraph()` module. It owns structured identity lookup and diagnostics,
column ordering by comparison key then authored spelling, dependency-aware reference
type resolution, stable missing-target and cycle failures, and immutable result assembly.
A member supplies only narrow hooks for namespace validation, physical type selection,
reference-type compatibility, defaults, generation, and final physical column metadata.
Do not copy the graph algorithm into a member or widen `DialectSchema` with these hooks.

`inferColumnType()` maps logical Valibot intent to a physical type.
`normalizeDataType()` supplies catalog-comparison form, and
`normalizeDefaultValue()` may supply default-value comparison form. Unsupported type,
default, generation, or reference forms fail with `MigrationError`; they never degrade
to a convenient PostgreSQL or text default.

Schema analysis in `src/schemas/utils/analyzeSchema.ts` is shared and reports logical
facts such as effective output kind, constraints, formats, wrappers, transformations,
and composite branches. It does not choose physical storage. The member-owned
`src/dialects/postgres/infer.ts` and `src/dialects/sqlite/infer.ts` select that storage;
the corresponding `mapping.ts` files map query parameters and results while preserving
the proven JavaScript output. `postgresDialect.schema.inferColumnType()` and
`sqliteDialect.schema.inferColumnType()` are the direct inference entry points. The
public package exports both complete dialect constants from `stratom`; it does not
export the implementation helpers. Keep `schema.ts` as the facet assembly point and
`lowerDesiredSchema.ts` as each member's desired-graph lowering owner. The README
inference reference and the PostgreSQL and SQLite production profiles below describe
the shipped formats, transforms, composites, numeric limits, and output mappings.

Column wrappers track three separate permissions: omission on insert, JavaScript
`undefined`, and SQL `NULL`. Analysis reduces nested wrappers from the inside out:

| Wrapper                      | Insert omission | `allowsUndefined` analysis fact | SQL `NULL` |
| ---------------------------- | --------------- | ------------------------------- | ---------- |
| `optional` / `exactOptional` | added           | added                           | unchanged  |
| `undefinedable`              | removed         | allowed                         | unchanged  |
| `nullable`                   | unchanged       | unchanged                       | added      |
| `nullish`                    | added           | added                           | added      |
| `nonOptional`                | removed         | removed                         | unchanged  |
| `nonNullable`                | removed         | unchanged                       | removed    |
| `nonNullish`                 | removed         | removed                         | removed    |

An outer wrapper changes the permissions left by its inner schema. `allowsUndefined`
is an analysis fact; Valibot still validates an explicitly supplied value. In
particular, `exactOptional(x)` permits omission but sends an explicit `undefined`
through `x`, which can reject it. A bare union with `null()` is SQL-nullable but
required on insert. Omission alone does not make a column nullable. An omittable
`NOT NULL` column needs a non-null application default, database default, identity, or
other generated value. `undefinedable` does not make a required field omittable, and
an explicit `undefined` does not satisfy that insert field.

`InferSelect`, selected-column results, `InferInsert`, and `InferUpdate` follow
Valibot `InferOutput` and `InferInput` together with SQL nullability, omission,
defaults, and generation rules in `src/types/views.ts`.

Portable table structure and omission/default rules are checked by `defineTable()`;
this does not infer dialect storage. Direct `schema.inferColumnType()` and invalid
client mapping configuration fail with `SchemaError`. When desired-graph lowering
cannot select or lower a member's storage, the migration planning boundary reports
`MigrationError` with the original expected schema failure as its cause. Unexpected
defects retain their identity except at an execution boundary that must add stage and
database outcome, as described by ADR 0003. Inferred storage changes can add a type
change to the Migration Plan. After a supported Migration Plan executes, re-introspect
the catalog and build the next plan in the same Semantic Profile; it should contain no
steps when the observed catalog matches the desired schema. PostgreSQL does not add
automatic casts for legacy data, and SQLite rejects conversions its affinity rules
cannot prove lossless, so this convergence does not promise arbitrary data conversion.

### Query compilation and values

The complete Query facet is intentionally small:

```typescript
type DialectQuery = {
  resolve(
    handles: readonly TableHandle[],
    options?: { registrationDefault?: readonly NamespaceIdentifierInput[] },
  ): {
    compile(node: SqlAst): CompiledQuery
    findRelationMatches(relation, availableHandles?): readonly TableHandle[]
    findColumnMatches(handle, column): readonly string[]
  }
  mapParamValue?(dataType: string, value: unknown): unknown
  mapResultValue?(dataType: string, value: unknown): unknown
}
```

`query.resolve()` runs once for a client registry. Its optional registration default is
the same `createDatabase({ defaultNamespace })` input used by Migration planning. Its
client-scoped result is shared by
compilation, predicate parameter mapping, selected and returned result mapping, and
reference-target physical-type resolution. The member must apply one case-folding,
namespace-defaulting, and structured-identity policy across those methods. Agreement is
an enforced adapter invariant, proven by the reusable Dialect member contract: a member
whose compiler addresses a different database, relation, or column from its lookup
result fails the contract.

Relation and member lookup returns candidate sets so the shared boundary can preserve
its outward tags: zero semantic matches and multiple semantic matches are explicit
`QueryError` failures during query construction, or `SchemaError` failures when client
creation cannot resolve referenced-column physical types. They never select a first
match. `compile()` remains synchronous and performs no database work. A compiled query
may carry a member-owned session assertion; shared operation execution evaluates it
against the pinned session identity before issuing SQL. PostgreSQL uses this to reject
an authored database-plus-schema relation when its database differs from the executing
session.

The current `SqlAst` scope is select, insert, update, and delete. Select supports
structured inner/left/right joins, column and `*` projections, aliased scalar and
aggregate expressions (`count`, `min`, `max`, `sum`, string functions, `now`, and
`date_trunc`), composable comparison predicates, grouping, having, ordering, limit,
and offset. Writes support multi-row values with `default`, structured predicates,
full-table opt-in, and `returning` all or named columns. A member must reject an AST form
it cannot implement explicitly; it must not reinterpret another member's namespace
conventions.

PostgreSQL query relations accept omission, schema-only, or ordered database-plus-schema
namespaces. An explicit registration default wins over the session context: omitted
relations use its schema in SQL, while a database-plus-schema default also preserves its
database execution check. Without that default, omission stays unqualified in SQL so the
pinned session's `search_path` and `current_schema()` choose the same effective schema
observed by migration identity.
There is no implicit `public` equivalence: omitted and explicit `public` agree only when
resolved session evidence names `public`. When synchronous mapping provisionally
matches omission to an explicit schema, the compiled query carries that schema as an
execution precondition. PostgreSQL operation sessions probe `current_schema()` with
their database/backend identity, and shared execution rejects a mismatch before SQL.

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

The current acquisition, decoding, consistency, and assembly stages are documented in
the [catalog observation guide](catalog-stages.md).

### Operations and connector adaptation

Each member provides `classifyDriverError(cause)`. It walks native cause chains and
returns `kind` (`uniqueViolation`, `foreignKeyViolation`, `notNullViolation`,
`checkViolation`, `transient`, or `unknown`), `retryable`, and only reliable native
`constraint`, `table`, or `columns` fields. Unknown failures return `unknown` and
`false`; diagnostics are never inferred from message text. Native session adapters use
their member's classifier when wrapping SQL failures as `DriverError`. The shared
operation boundary applies the selected member's classifier to recognized
`DriverError` values from custom providers while preserving unrecognized failures.

`operations.createSessionProvider(connector)` adapts the exact selected db0 connector to
exclusive physical operation sessions. `operations.compile()` compiles structured ping,
transaction, rollback, and savepoint commands. A custom provider can replace only the
first responsibility; the selected member still compiles lifecycle commands and owns
all other facets.

PostgreSQL and SQLite delegate their identical lifecycle SQL to
`compileCommonOperationCommand()`. Keep the member-level compiler wrapper: it preserves
the member interface and is the replacement seam for an engine with different lifecycle
syntax. Do not put connector/session behavior in the common compiler.

An `OperationSessionProvider` must advertise `nativeTransactions: true`, implement
`open()` and `close()`, and return sessions with `query`, `run`, `cancel`, and
`release('reuse' | 'discard')`. Each session exposes non-empty `database` and
`physicalSession` identity strings and may expose a dialect-neutral writable namespace
context. PostgreSQL includes its database-plus-current-schema context for Query and
migration identity. It freshly proves that evidence at every physical-session lease and,
after stateful cleanup, before reuse. Reuse compares the full database, physical-session,
and ordered namespace role/spelling evidence to the lease identity. A changing or
unprovable identity is an error and the session is discarded.

`OperationSession.run()` and `Executor.run()` return `Promise<number | undefined>`.
For insert, update, delete, and upsert statements without `RETURNING`, providers must
return the driver's affected-row count as a nonnegative safe integer. Zero means no rows
were affected. Statements without a meaningful count, such as lifecycle commands or
DDL, may return `undefined`; their callers ignore the result. Custom
`operationSessionProvider` implementations must now supply DML counts. A missing,
negative, fractional, non-finite, or unsafe DML count is a provider defect: the write
rejects with `InvariantError` after execution error handling, without converting it to
`QueryError` or inventing a count. The statement may already have executed.

PostgreSQL uses native `rowCount`, mapping `null` to `undefined`. SQLite converts native
`changes` (number or bigint) to the numeric contract; writes reject counts outside the
safe integer range. Counts follow the engine's affected-row semantics, including matched
updates that assign the existing value. Conflict `DO NOTHING` reports zero for a skipped
row, and conflict `DO UPDATE` counts the affected row. SQLite counts direct statement
changes, excluding trigger and foreign-key cascade changes. Writes return rows by
default; `returningNone()` selects `{ rowCount }` on root and transaction clients.

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
`migration.catalog` supplies both planning and authoritative execution observations.
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

The public `db.migrate().dryRun()` method is a non-executable projection of that same
whole-plan lowering result. It preserves action grouping and source-step provenance,
copies SQL and parameter counts, and replaces every bound parameter with
`[REDACTED]`. It never exposes executable session assertions or parameter values.
SQL literals embedded by an adapter are verbatim and are outside parameter redaction.
`dryRun()` resolves and validates the same Semantic Profile as execution and performs no
DDL.

PostgreSQL value mapping uses the analyzed schema output when one is available.
`bigint` and `int8` results become JavaScript numbers only for number output within
the safe integer range. Bigint output maps integer-valued `bigint`, `numeric`, and
`decimal` values exactly; a numeric value such as `42.000` becomes `42n`.
Unsafe JavaScript numbers and fractional values fail with `QueryError` before a
lossy numeric conversion. PostgreSQL numeric result strings remain strings unless
the schema output is bigint, including a number schema with an explicit numeric
physical type. Context-free mapping retains the driver's numeric representation.

PostgreSQL selects `date` for `isoDate`, `time` for `isoTime` and
`isoTimeSecond`, `timestamp` for `isoDateTime` and `isoDateTimeSecond`, and
`timestamptz` for `isoTimestamp`. These schemas return strings. `date()` and a
proven `toDate()` output select `timestamptz` and return JavaScript `Date` values.
The operation's native query reads temporal columns as text before logical result
mapping. Local timestamps therefore retain their wall-clock fields regardless of
the JavaScript host timezone, and ISO timestamp strings retain submillisecond digits.
Results use `T` between date and time and a `Z` or colon-separated timezone offset.
PostgreSQL stores at most six fractional second digits and may change the spelling
of an input offset to the session timezone. Minute and second schemas cannot
represent finer nonzero stored precision; result mapping rejects such values
instead of discarding it. JavaScript `Date` results retain only milliseconds.
Validation transformations run on input only; result mapping uses the proven output
kind and does not rerun the input pipeline.

A reference inherits physical storage while its proven authored temporal format
controls PostgreSQL result mapping. A minute-time target can return `03:04`, while
a transformed and revalidated `isoTimeSecond()` reference returns `03:04:00`.
Both columns still use `time`. The same rule applies to minute and second
`timestamp` strings. `date` supports `isoDate()`, and `timestamptz` supports
`isoTimestamp()`. Explicit `text` and `varchar` storage preserve stored spelling.
References without proven temporal output formats retain target-based mapping.

Client creation rejects incompatible temporal formats, ambiguous native temporal
representations, and reference changes between ISO strings and Date output with
`SchemaError`, before opening a session or issuing SQL. To own an unsupported
contract, provide both effective mapping directions through column `mapParam` and
`mapResult`, client `mapParamValue` and `mapResultValue`, or one of each.
Column hooks take precedence independently in each direction. A single hook does
not bypass validation. Result mapping still rejects finer nonzero native precision
with `QueryError` instead of truncating seconds or fractions.

## SQLite production profile

SQLite requires the exact db0 0.4.0 `node-sqlite` connector and SQLite >=3.37. Node 22.5
through 22.12 requires the `--experimental-sqlite` flag. SQLite manages ordinary permanent
non-STRICT rowid tables in `main`.

Clients and operation providers created from one `node-sqlite` connector share exclusive
ownership of its native session. While one Client has an active operation or transaction,
an operation from another Client using that connector fails with an already-leased error.
Closing another Client does not close the active session; the owned native session is
disposed after the last provider closes. Separate connector objects that return an
already-owned native `DatabaseSync` cannot open a session, and closing them does not
dispose that instance.

SQLite validates built-in value mappings when a client is created, before it opens a
session or issues SQL. Compatibility follows SQLite affinity rules, including `INT`
precedence over `TEXT` or `REAL` in unusual declared type names.

| Logical schema output                | Supported physical affinities with built-in mapping |
| ------------------------------------ | --------------------------------------------------- |
| String                               | TEXT, BLOB                                          |
| Number, boolean                      | INTEGER, REAL, NUMERIC, BLOB                        |
| Bigint                               | INTEGER, NUMERIC, BLOB                              |
| Date, JSON object/array/tuple/record | All affinities                                      |

Numbers must be finite, and integral numbers must be safe JavaScript integers.
Bigints use SQLite's signed 64-bit integer range. Boolean values use `0` and `1`.
Dates use ISO text, and JSON-shaped schemas use bracketed JSON text. These text forms
remain text even with numeric affinity. Nullable wrappers preserve SQL NULL.
Homogeneous enum and picklist outputs follow their primitive output kind.
All six ISO temporal validators infer `TEXT` and return the stored string. `date()`
and proven `toDate()` output infer `DATETIME` and return `Date`; `DATETIME` is a
declared SQLite type whose values are stored as ISO text. Compatible explicit
declared types follow the same logical string or Date mapping.

SQLite references preserve exact temporal TEXT spelling and Date output under the
same rules. SQLite does not apply PostgreSQL temporal formatting: TEXT keys
`03:04` and `03:04:00` differ. Use matching stored strings for foreign keys.
A local reference change from ISO string output to Date requires paired mapping
hooks.

Inference follows transformations from left to right. A known conversion selects
storage from its output, so `pipe(string(), toNumber())` accepts a string on insert
and reads as a number. `parseJson()` requires a following supported structured
schema, for example `pipe(string(), parseJson(), object({ enabled: boolean() }))`.
A later supported schema can recover output inference after an unknown
transformation. Output constraints after a conversion apply to the converted value;
input string length, UUID format, and numeric bounds do not carry across it.

Built-in mapping rejects numeric or boolean schemas with TEXT affinity, strings with
numeric affinity, bigint with REAL or TEXT affinity, and unknown or mixed output kinds.
Composite branch output facts come from shared schema analysis; each member's `infer.ts`
selects compatible storage and its `mapping.ts` preserves the result identity. SQLite
maps compatible number unions through the inferred `INTEGER` or `REAL` logical type
even when the selected declared type differs. PostgreSQL keeps native temporal
formats only when every branch has one compatible result representation; mixed ISO
minute and second formats need explicit `text` storage to retain their exact strings.
A selected physical type does not
make mixed JavaScript outputs compatible without both mapping directions.
Known conversions use their effective output kind for built-in mapping. Unknown
output and bare `parseJson()` require a selected `physicalType` for inference and
both explicit parameter and result hooks for value mapping. A physical type alone
does not establish a mapping contract. The hooks must preserve the transformed value
in both directions.

For an unsupported combination, both effective mapping directions must come from
existing column hooks (`mapParam`, `mapResult`) or client hooks (`mapParamValue`,
`mapResultValue`). Column hooks take precedence independently in each direction.
The application owns the type and value preservation contract for these overrides.
One custom direction still requires a compatible built-in mapping in the other.
Reference columns retain their target's logical schema and validate their selected
physical storage under the same policy.
Validation also checks wrappers and pipeline actions on the authored reference schema.

SQLite's value limits remain in force after conversions: numbers must be finite,
integral numbers must be safe JavaScript integers, and bigints must fit signed
64-bit range. Inferred storage changes can add a type-change step to an existing
database migration. Select the previous `physicalType` to keep that storage when
required.

Mapper construction owns this check because client mapping hooks are available there.
Pure desired-schema lowering validates physical SQL type syntax and reference storage
compatibility. It does not establish a built-in value mapping contract.

SQLite defaults support native literals, portable date/time defaults, and a constant
expression subset with scalar core/date functions, arithmetic, parentheses and CAST to
`INTEGER`, `REAL`, `NUMERIC`, `TEXT` or `BLOB`. Validation checks syntax and function
argument counts before DDL, with a limit of 256 tokens and 24 parser levels. SQL
whitespace is space, tab, carriage return, line feed or form feed. `format()` and
`unixepoch()` are excluded because they require SQLite 3.38.

`abs()` operands must be proven safe from minimum-integer overflow. Supported operands
include literals, integer addition/subtraction whose summed literal magnitudes are below
2^63, and complete calls returning text, blobs, real numbers or bounded/nonnegative
integers, such as `lower()`, `round()`, `length()` and validated `abs()` calls. CAST to
`REAL`, `TEXT` or `BLOB` is allowed inside `abs()`. Other arithmetic and unproven
`INTEGER`/`NUMERIC` casts or `min()`/`max()`/`coalesce()` operands fail before DDL.
Queries use the same ASCII identifier folding and main-database addressing as planning.

Whole-plan lowering emits legal direct CREATE/DROP TABLE, CREATE/DROP INDEX, safe
ADD COLUMN and unconstrained DROP COLUMN operations. Changes to types, nullability,
foreign keys, unique constraints and restricted column drops coalesce with every
touching change into one rebuild action per existing table. The action retains all
observed columns, defaults, PK/unique/FK constraints and simple indexes unless the plan
explicitly authorizes their removal. Additive ownership retains objects absent from the
desired handle. Replacement names are deterministic and reserved against live and
planned names; data copies use explicit projections and preserve hidden rowids, exact
INTEGER PRIMARY KEY aliases and AUTOINCREMENT high-water marks.

Conversions are accepted only when SQLite affinity rules prove them lossless for every
stored value: unchanged affinity, INTEGER/NUMERIC interchange, or a change to no-affinity
BLOB storage. Rowid alias conversions are rejected. New required columns need a proven
non-NULL constant default; required-column backfill expressions and lossy conversions
remain unsupported. Existing NULL values prevent SET NOT NULL before any DDL.
Destructive table/column drops and unique-index drops that remove a candidate key
require complete main-namespace dependency evidence,
provided by explicit `completeNamespace` migration ownership. Retained incoming FKs
prevent the drop; an FK whose source column is itself dropped does not. A unique-index
drop can use scoped evidence when the same candidate key remains in the final table.
Nonunique index drops do not require complete namespace coverage.

Execution records the current FK policy, disables it before BEGIN IMMEDIATE, and
prepares inside the writer transaction. This prevents DROP TABLE from cascading into
retained children during a rebuild. FK and integrity checks and desired-state convergence
run before commit. Rollback restores schema, data and sequence state; known commit or
rollback outcomes restore the prior FK and busy-timeout policies. Uncertain outcomes
discard the session and retain primary and cleanup failures separately.

STRICT, WITHOUT ROWID, attached databases, temporary objects, virtual/shadow tables,
generated columns, cross-database FKs, checks, triggers, views, rich constraint clauses,
partial/expression indexes and incomplete preservation evidence are unsupported. An
initialized empty temp schema is accepted only after its object inventory is proven empty.

## Registering and testing a member

Every package-supported member uses this source shape:

```text
src/dialects/<member>/
├── dialect.ts          # complete defineDialect(...) assembly only
├── index.ts            # intentional package exports only
├── identity.ts         # <member>Identity
├── naming.ts           # <member>Naming
├── schema.ts           # <member>Schema
├── query.ts            # <member>Query
├── catalog.ts          # <member>Catalog
├── operations.ts       # <member>Operations
├── operationSession.ts # advanced connector/session adaptation
└── migration/index.ts  # member migration lowering and execution exports
```

Files used only by one engine keep descriptive names and do not need a matching file in
other members. Do not add empty forwarding modules to make engine-specific implementations
look alike. The shared files above are composition points: each exports the complete facet
named with the member code prefix. `dialect.ts` imports those facets and passes them to
`defineDialect()` with the member's lowering and execution functions. It contains no
implementation helpers or public re-exports.

Equivalent default behavior has the same owner in each member: `normalize.ts` owns
comparison forms for types, default expressions, and primitive default values;
`validate.ts` owns safe validation and SQL formatting; and `schema.ts` assembles the
schema facet. Engine-specific parser and compatibility modules remain where their separate
responsibilities justify them.

Use `postgres` and `sqlite` as code prefixes and PostgreSQL and SQLite in prose. The exact
db0 connector selector remains `postgresql`. Complete facet constants and classifier facet
symbols use a member prefix and lower camel case, such as `postgresCatalog` and
`sqliteClassifyDriverError`. Functions shared across a member's concern modules use a verb,
member prefix, and subject, such as `compilePostgresQuery` and
`serializeSqliteObservation`. Other constants use upper snake case; policy constants add
the member and descriptive subject, such as `POSTGRES_IDENTITY_POLICY` and
`SQLITE_IDENTITY_POLICY`. Identifier-quoting helpers use `quoteIdentifier` when private to
a file and `quoteSqliteIdentifier` when shared across SQLite migration modules. Export
complete catalog facets; keep their introspection implementations private to `catalog.ts`.
File-private helpers can use concise descriptive names, as can helpers within a tightly
scoped engine-specific migration implementation. Use `const` unless a binding is
reassigned, use `let` for reassignment, and do not use `var`.

Each member `index.ts` exports its complete Dialect and advanced operation-session provider
factory. The package root exposes those exports symmetrically. Do not expose dialect
implementation helpers; use the complete Dialect facets or the public database interface.

Package-supported members are statically imported and listed in `productionDialects` in
`src/dialects/resolve.ts` by their exact db0 `SQLDialect` id. `createDialectRegistry()`
validates the complete list. The architecture suite derives member directories from that
registration and enforces the manifest, shared facet files, facet symbols, and explicit
public index. Do not add a runtime plugin registry or database-specific logic to Client,
Schema, Query, Migration, or Operations.

Before registering a new member:

1. Implement every `Dialect` facet in the source shape above and assemble it only in
   `dialect.ts` with `defineDialect()`.
2. Add the complete member to `productionDialects` and confirm its exact connector id.
3. Declare every reusable contract capability and register all required contract shards.
4. Add native integration coverage for connector selection, queries, transaction routing,
   Migration Plan equality, execution, post-migration state, and cleanup. Document engine
   and connector version limits in this guide.
5. Export only the complete member and advanced session-provider factory from `index.ts`.
6. Run architecture and public-interface tests, typecheck, lint, formatting, build, the
   unit suite, and the applicable native integration profile.

The private `registerDialectForTest()` seam exists only for isolated contract tests. It
is deliberately not a package export. A test adapter registers shared behavior through
`tests/unit/dialects/dialectContractKit.ts`. Fixed runners own the identity, naming,
desired-schema, query, catalog, operation-session, coordination, migration, and lifecycle
scenarios and assertions. Adapters supply typed Dialect inputs, narrow physical-query
observations where required, and independent semantic expected results. They cannot
replace a shared scenario with an adapter-authored test.

Keep member-specific unit specs flat in `tests/unit/dialects/`, named
`<member><Concern>.test.ts` (for example, `postgresSchema.test.ts` and
`sqliteDesiredSchema.test.ts`). `Schema` covers direct type inference and normalization;
`DesiredSchema` covers lowering a registered table graph. Keep shared core behavior in its
shared test file, and name engine-specific fixtures with their member prefix. Use short
database and facet suite titles, leaving the behavior description in each test title; for
example, `describe('PostgreSQL schema')` and `describe('SQLite query')`. Name member
fixtures with the same prefix, such as `postgresSharedFixtures.ts` and
`sqliteContractFixtures.ts`.
To run one concern, pass its file to Vitest, for example:
`pnpm exec vitest run --config vitest.unit.config.ts tests/unit/dialects/postgresDesiredSchema.test.ts`.

See [Dialect consistency status](dialect-consistency-status.md) for the current audit
reassessment, intentional engine differences, and test-profile exceptions.

Create one exhaustive capability declaration for the complete member. It assigns each
facet to one named isolated shard. Register the complete member once; the aggregate
accepts one descriptor for every declared shard, and each descriptor accepts all and only
its owned facet inputs. A supported facet needs a supported input, while an unsupported
facet needs a non-blank reason. Composite Query and operation-session inputs also carry
their top-level `state: 'supported'` declaration. This makes a missing applicable input,
malformed declaration, or omitted whole shard a type or registration error.

PostgreSQL and SQLite production registrations use the same shard keys:
`semantic`, `coordination`, and `operation-session`. Keep aggregate test files limited to the exhaustive capability
declaration and registration of imported shard descriptors. Put case data and runtime
construction in member `*Fixtures.ts` files; member `*Shards.ts` files export descriptors.
Generic controlled providers return empty rows for lifecycle-only scenarios; SQL
scenarios supply their row observations explicitly. Generic query-addressing helpers
receive their compiler explicitly. PostgreSQL-only catalog observations and native
connectors live in PostgreSQL-named fixture files.

Catalog inputs state the exact expected evidence for namespaces, relation owners,
generated identity, and rich objects, so one catalog can mix supported and unsupported
evidence. Operation-session inputs separately declare the common lifecycle and controlled
failure-path suites. Coordination accepts only the shared semantic runtime factory or an
unsupported reason. Migration accepts a lowering and Semantic Profile validation case plus
an explicit supported or unsupported lowering-limit case.

An adapter can register facets in several test files when their fixtures differ. Reuse its
complete capability declaration and export descriptors from each focused fixture file;
only the aggregate calls `registerDialectContractMember()`. Supply
`lifecycle: { state: 'supported', input: createRuntime }` once. That runner performs
exactly one public connector-selected smoke for query routing, transaction routing,
Migration Plan equality, execution, post-migration state, and cleanup. Its expected plan
and post-state are supplied independently of the Dialect under test. Detailed checks stay
in the fixed facet runners.

The complete registration shape is:

```typescript
import { registerDialectContractMember } from './dialectContractKit'
import type { DialectContractMemberCapabilities } from './dialectContractKit'
import {
  exampleCoordinationContractShard,
  exampleOperationSessionContractShard,
} from './exampleSharedShards'

const exampleCapabilities = {
  identity: { state: 'supported', shard: 'semantic' },
  naming: { state: 'supported', shard: 'semantic' },
  desiredSchema: { state: 'supported', shard: 'semantic' },
  query: { state: 'supported', shard: 'semantic' },
  catalog: { state: 'supported', shard: 'semantic' },
  operationSession: { state: 'supported', shard: 'operation-session' },
  coordination: { state: 'supported', shard: 'coordination' },
  migration: { state: 'supported', shard: 'semantic' },
  lifecycle: { state: 'supported', shard: 'semantic' },
} as const satisfies DialectContractMemberCapabilities

registerDialectContractMember('ExampleDB', exampleCapabilities, {
  semantic: {
    identity: { state: 'supported', input: identityInput },
    naming: { state: 'supported', input: namingInput },
    desiredSchema: { state: 'supported', input: desiredSchemaInput },
    query: {
      state: 'supported',
      core: { state: 'supported', input: queryInput },
      scenarios: queryCompilerScenarios,
      valueMapping: { state: 'supported', input: valueMappingInput },
    },
    catalog: { state: 'supported', input: catalogInput },
    migration: {
      state: 'supported',
      input: {
        lowering: migrationLoweringInput,
        unsupportedLowering: {
          state: 'unsupported',
          reason: 'ExampleDB lowers every shared Migration Plan case',
        },
      },
    },
    lifecycle: { state: 'supported', input: createLifecycleRuntime },
  },
  coordination: exampleCoordinationContractShard,
  'operation-session': exampleOperationSessionContractShard,
})
```

Leaving out either imported descriptor rejects the member because its declared shard has
no registration. A one-shard member uses the same aggregate API with one `complete`
descriptor; it cannot call a shard-only registration function.

The minimal test member in `tests/unit/helpers/extensionContractDialect.ts` demonstrates the
extension boundary. It supplies every Dialect facet, is selected only by its connector,
and requires no edits to the architectural consumers.
