# stratom

A schema-first ORM with dialect-neutral authoring and PostgreSQL and SQLite lowering:
[Valibot](https://valibot.dev/) schemas, desired-state migrations, and a typed
query builder. Transport is [db0](https://db0.unjs.io/); app code uses stratom
only.

## Features

- **Schema-defined tables** — `defineTable(name, columns, options)` with Valibot `column` / `reference`
- **db0 connector** — `createDatabase({ connector, schemas })` owns the connection lifecycle
- **Desired-state migrations** — `db.migrate().plan()` / `.dryRun()` / `.execute()` with safe defaults, allowlist, and advisory lock
- **Typed CRUD** — `db.from(Table).select|insert|update|delete` with column refs
- **Transactions** — callback API; nested calls use savepoints
- **Tagged errors** — `SchemaError`, `ValidationError`, `QueryError`, `MigrationError`, `DriverError`, and `InvariantError`, with guards for caught values

See [application and physical column names](docs/column-names.md) for `column({ name })`,
query output rules, and migration behavior.

## Installation

```bash
pnpm add stratom valibot db0
# plus the driver required by your connector (e.g. pg for PostgreSQL)
```

Stratom is ESM only and requires Node >=22.5.

## Test profiles

`pnpm test:unit` runs deterministic semantic contracts, compiler and planning checks,
and injected-failure scenarios for both dialects. It opens no native database and
needs no database service or experimental SQLite flag.

`pnpm test:integration:sqlite` runs native SQLite connector, query, migration,
physical lifecycle, database-file, and writer-lock scenarios. It needs Node >=22.5
and SQLite >=3.37, with no external service. Node 22.5 through 22.12 requires
`--experimental-sqlite`. The pinned pnpm needs a newer Node, so install dependencies
on Node 24 before switching to the minimum runtime and running Vitest directly:

```bash
NODE_OPTIONS=--experimental-sqlite node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/sqlite
```

The integration and coverage Vitest configurations build `stratom` once before
their workers run. Each native profile, including a direct Vitest invocation,
imports that fresh build in its package smoke test. The unit profile does not
build the package.

On PowerShell, set `$env:NODE_OPTIONS='--experimental-sqlite'` first, then run the
`node` command without the `NODE_OPTIONS=...` prefix. This environment variable
passes the flag to Vitest's worker processes.

On Windows, the integration configuration exposes garbage collection in test workers.
Node 22 SQLite statements can retain file handles after their database closes.
File cleanup collects unreachable statements before deleting temporary databases.
Connections still close explicitly, and cleanup errors still fail the tests.

`pnpm test:integration:postgres` runs native PostgreSQL scenarios. It needs a running
PostgreSQL service and `POSTGRESQL_URL`. The repeatable suite uses Docker Compose
and an isolated schema per test. Docker Desktop provides Compose on Windows and
macOS; Docker Engine with Compose is also supported on Linux. Copy the example
environment file, start the health-checked service, and run the dedicated command:

```bash
cp .env.example .env
docker compose up -d --wait
pnpm test:integration:postgres
docker compose down -v
```

On PowerShell, use `Copy-Item .env.example .env` for the first command.
`pnpm test:integration` runs both native profiles; `pnpm test` runs units followed
by both native profiles. These aggregate commands require both profiles' native
prerequisites and fail with a setup message when PostgreSQL is unavailable.
`pnpm test:coverage` measures units and both native profiles in one report, with
the same native prerequisites as `pnpm test`. CI runs units and both native
profiles on Node 24 and the minimum supported Node 22.5.0; only the
SQLite integration job needs the experimental flag on the minimum runtime.

## Quick start

```typescript
import postgresql from 'db0/connectors/postgresql'
import { createDatabase, defineTable, column } from 'stratom'
import { boolean, number, pipe, string } from 'valibot'

const User = defineTable(
  'users',
  {
    id: pipe(number(), column({ generation: { kind: 'identity', mode: 'byDefault' } })),
    email: pipe(string(), column({ unique: true })),
    fullName: string(),
    active: pipe(
      boolean(),
      column({ databaseDefault: { kind: 'literal', value: true } }),
    ),
  },
  { primaryKey: 'id' },
)

const db = createDatabase({
  connector: postgresql({ url: process.env.DATABASE_URL! }),
  schemas: [User],
})

await db.migrate().execute()

const user = await db
  .insert(User)
  .values({ email: 'a@b.com', fullName: 'Ada Lovelace' })
  .returning([User.id, User.email])
  .executeTakeFirstOrThrow()

await db.close()
```

## Defining tables

`defineTable(name, columns, options)` builds a table handle from a table name, a
map of Valibot column schemas, and table-level options. The handle is what you
register with `createDatabase` and pass to every query method; it also exposes a typed
column reference per property (`User.email`) for use in `where` / `select` /
`orderBy` / joins.

```typescript
const Membership = defineTable(
  'memberships',
  {
    orgId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    userId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    role: pipe(
      string(),
      column({ databaseDefault: { kind: 'literal', value: 'member' } }),
    ),
  },
  {
    namespace: [{ role: 'schema', spelling: 'public' }],
    primaryKey: ['orgId', 'userId'], // single column or composite
    indexes: [
      { columns: ['userId'] }, // non-unique
      {
        name: 'memberships_org_role_uidx',
        columns: ['orgId', 'role'],
        unique: true,
      },
    ],
  },
)
```

Qualified relations use ordered, role-tagged `namespace` intent. Omitting `namespace`
keeps the relation unresolved during Schema construction; the connector-selected
Dialect member resolves it from the registration default or session context.

`primaryKey` and every index `columns` entry are constrained to the table's own
column names, so a typo is a compile error:

```typescript
defineTable(
  'users',
  { id: pipe(number(), column({ physicalType: { postgresql: 'integer' } })) },
  {
    primaryKey: 'ide', // ✗ Type error: not assignable to 'id'
  },
)
```

> **Reserved column names.** `getSchema` and `getTableMetadata` are methods on
> the table handle and cannot be column names — `defineTable` throws a
> `SchemaError` if one collides. Use `User.getSchema()` for the Valibot schema
> and `User.getTableMetadata()` for table metadata.

### Inferring column types from the schema

Schema construction records logical Valibot value intent; it does not import a
dialect or infer a physical type. During migration, the selected adapter lowers
the complete registered graph and infers physical storage from the Valibot schema.
PostgreSQL and SQLite use their own type and mapping rules, including length and
range refinements. This example shows PostgreSQL storage:

```typescript
import { defineTable } from 'stratom'
import {
  boolean,
  date,
  integer,
  maxLength,
  maxValue,
  minValue,
  nullable,
  number,
  pipe,
  string,
  uuid,
} from 'valibot'

const Event = defineTable(
  'events',
  {
    id: pipe(string(), maxLength(36)), // → varchar(36)
    title: pipe(string(), maxLength(120)), // → varchar(120)
    description: string(), // → text
    attendees: pipe(number(), integer(), minValue(0), maxValue(100000)), // → integer
    isPublic: boolean(), // → boolean
    startsAt: date(), // → timestamptz
    endedAt: nullable(date()), // → timestamptz, NULL allowed
  },
  { primaryKey: 'id' },
)
```

The row type is inferred too — `InferSelect<typeof Event>` gives
`{ id: string; title: string; description: string; attendees: number; isPublic: boolean; startsAt: Date; endedAt: Date | null }`.

For a PostgreSQL UUID primary key, validate the string with `uuid()`:

```typescript
const User = defineTable('users', { id: pipe(string(), uuid()) }, { primaryKey: 'id' })

await db.insert(User).values({ id: crypto.randomUUID() }).execute()
```

This selects PostgreSQL `uuid` storage. It does not generate UUID values or add a
database default; the application supplies each value.

Inference rules depend on the selected dialect. The table shows both the physical
storage selected by `postgresDialect.schema.inferColumnType` and
`sqliteDialect.schema.inferColumnType`, and the JavaScript value returned by the
built-in query mapper. Physical overrides can change storage; they do not change a
column's inferred JavaScript output. Both dialects reject an override that cannot
return that output, such as `date()` in PostgreSQL `text`, unless the column or client
supplies both parameter and result mapping hooks. The direct facet methods are
available through the exported `postgresDialect` and `sqliteDialect` constants.

| Schema or output                                                     | PostgreSQL storage                          | SQLite declared type                        | JavaScript output  |
| -------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------- | ------------------ |
| `string()`                                                           | `text`                                      | `TEXT`                                      | `string`           |
| `maxLength(n)` string, n ≤ 255; otherwise string                     | `varchar(n)` / `text`                       | `TEXT`                                      | `string`           |
| `uuid()` string format                                               | `uuid`                                      | `TEXT`                                      | `string`           |
| `ip()` / `ipv4()` / `ipv6()`                                         | `inet`                                      | `TEXT`                                      | `string`           |
| `mac48()`; `mac()` / `mac64()`                                       | `macaddr`; `macaddr8`                       | `TEXT`                                      | `string`           |
| `decimal()` string format                                            | `numeric`                                   | `TEXT`                                      | `string`           |
| `number()`                                                           | `double precision`                          | `REAL`                                      | `number`           |
| `integer()`                                                          | `integer`                                   | `INTEGER`                                   | `number`           |
| `boolean()`                                                          | `boolean`                                   | `BOOLEAN`                                   | `boolean`          |
| Integer number with int16 bounds                                     | `smallint`                                  | `INTEGER`                                   | `number`           |
| Integer number with a bound outside int32                            | `bigint`                                    | `INTEGER`                                   | `number`           |
| `safeInteger()` without bounds                                       | `bigint`                                    | `INTEGER`                                   | `number`           |
| `bigint()` without two signed-int64 bounds                           | `numeric`                                   | `BIGINT`                                    | `bigint`           |
| `date()`                                                             | `timestamptz`                               | `DATETIME`                                  | `Date`             |
| `isoDate()`                                                          | `date`                                      | `TEXT`                                      | `string`           |
| `isoTime()` / `isoTimeSecond()`                                      | `time`                                      | `TEXT`                                      | `string`           |
| `isoDateTime()` / `isoDateTimeSecond()`                              | `timestamp`                                 | `TEXT`                                      | `string`           |
| `isoTimestamp()`                                                     | `timestamptz`                               | `TEXT`                                      | `string`           |
| Proven `toDate()` output                                             | `timestamptz`                               | `DATETIME`                                  | `Date`             |
| Proven `toNumber()` output                                           | `double precision` / integer width          | `REAL` / `INTEGER`                          | `number`           |
| Proven `toBoolean()` output                                          | `boolean`                                   | `BOOLEAN`                                   | `boolean`          |
| Proven `parseBoolean()` output                                       | `boolean`                                   | `BOOLEAN`                                   | `boolean`          |
| Proven `toString()` output                                           | `text`                                      | `TEXT`                                      | `string`           |
| Object, array, record output                                         | `jsonb`                                     | `JSON`                                      | structured value   |
| Compatible same-output unions, variants, and intersections           | widened by output family                    | widened compatible storage                  | shared output type |
| Incompatible output identities, such as Date/string or number/bigint | requires explicit storage and both mappings | requires explicit storage and both mappings | custom mapped type |
| String / number / bigint choices                                     | see choice rules below                      | `TEXT` / `INTEGER` or `REAL` / `BIGINT`     | choice primitive   |
| Boolean choices                                                      | `boolean`                                   | `BOOLEAN`                                   | `boolean`          |

Pipeline actions such as `maxLength`, `integer`, the six ISO format validators, and
known conversions refine an input schema or its output. Enum and picklist constructors
are schemas; their actual options determine storage and output.

PostgreSQL `numeric` does not convert a number schema's values automatically. The
driver returns decimal strings, so a number schema with a `numeric` or `decimal`
override is rejected unless paired mapping hooks convert its values. A bigint output
stored as PostgreSQL `numeric` is returned as an integer-valued `bigint` exactly; a number output stored
as PostgreSQL `bigint` converts only within JavaScript's safe integer range and
otherwise raises `QueryError`. SQLite requires finite numbers and safe integral
JavaScript numbers, and limits bigint values to signed 64-bit range. SQLite `NUMERIC`
affinity does not provide arbitrary precision.

SQLite keeps UUID, IP, MAC, decimal, and ISO temporal strings as `TEXT` with their
authored spelling. PostgreSQL native UUID, network, MAC, numeric, and temporal storage
can canonicalize or otherwise change string spelling. Its ISO temporal types preserve local
wall fields and supported precision within engine limits: PostgreSQL keeps at most six
fractional digits, JavaScript `Date` keeps milliseconds, and minute/second mapper pairs
reject finer nonzero precision. `timestamptz` instant spelling may change with the
session time zone.

An explicit PostgreSQL temporal override must match a proven ISO string format:
`isoDate()` uses `date`, `isoTime()` and `isoTimeSecond()` use `time`,
`isoDateTime()` and `isoDateTimeSecond()` use `timestamp`, and `isoTimestamp()` uses
`timestamptz`. Native types may include precision, such as `time(0)`. Use `text` or
`varchar` to preserve the authored string, or provide both parameter and result mapping
hooks for another storage type. Plain strings remain valid in any temporal type.

| Valibot schema                     | Insert omission                                                       | SQL NULL allowed              |
| ---------------------------------- | --------------------------------------------------------------------- | ----------------------------- |
| `optional(x)` / `exactOptional(x)` | yes                                                                   | follows `x`                   |
| `undefinedable(x)`                 | no; the required insert value cannot be omitted or set to `undefined` | follows `x`                   |
| `nullable(x)`                      | follows `x`                                                           | yes                           |
| `nullish(x)`                       | yes                                                                   | yes                           |
| `nonOptional(x)`                   | no                                                                    | follows nullable state of `x` |
| `nonNullable(x)`                   | no                                                                    | no                            |
| `nonNullish(x)`                    | no                                                                    | no                            |
| `union([x, null()])`               | no                                                                    | yes                           |

Wrappers reduce from the inside out. `optional` and `exactOptional` add omission while
preserving nullability; `undefinedable` removes omission, allows undefined in the
wrapped schema, and preserves nullability; `nullable` adds SQL NULL while preserving
omission; and `nullish` adds both. Schema analysis records `allowsUndefined` for both
`optional` and `exactOptional`, but an explicitly present `undefined` with
`exactOptional(x)` is still checked by `x` during Valibot validation. The `non*`
wrappers remove the named permission: `nonOptional` removes omission and `undefined`,
`nonNullable` removes SQL NULL and omission while retaining whether `undefined` is
allowed, and `nonNullish` removes omission, `undefined`, and SQL NULL. A bare null-union
is nullable but remains required on insert. Omittable `NOT NULL` columns need a
non-null application default, database default, or generated value in both dialects.
`undefinedable` alone does not make a required field omittable; accepting `undefined`
is not enough to satisfy a missing insert field.

`InferSelect`, selected-column result types, `InferInsert`, and `InferUpdate` follow
Valibot `InferOutput`/`InferInput` plus SQL nullability, omission, defaults, and
generation rules. A selected or returned column uses its mapped output type.

For PostgreSQL strings, a selected `physicalType.postgresql` override wins first.
Otherwise, a recognized format selects native storage before `minLength`, `maxLength`,
or `length` can select length-based storage. Strings without a recognized format use
`varchar(n)` through a maximum length of 255 and `text` above that length; the length
validators still run.
Format inference works through `optional`, `exactOptional`, `undefinedable`,
`nullable`, `nullish`, `nonOptional`, `nonNullable`, and `nonNullish`, including
nested pipes. A reference inherits the target column's selected physical type,
including inferred native storage or an explicit `text` or `varchar(n)` override.
An override for SQLite does not suppress PostgreSQL inference.

PostgreSQL references can declare a different temporal output precision without
changing inherited storage. For example, this child returns `03:04:00` while the
parent returns `03:04`, with SQL `time` storage for both:

```typescript
const Parent = defineTable(
  'time_parent',
  { time: pipe(string(), isoTime()) },
  { primaryKey: 'time' },
)
const Child = defineTable(
  'time_child',
  {
    time: pipe(
      reference(Parent, 'time'),
      transform((value) => `${value}:00`),
      string(),
      isoTimeSecond(),
    ),
  },
  { primaryKey: 'time' },
)
```

This also supports minute/second datetime strings with `timestamp` storage.
`date` supports `isoDate()`, and `timestamptz` supports `isoTimestamp()`.
Incompatible temporal formats, ambiguous native representations, and reference
changes between strings and Date raise `SchemaError` at client creation before
SQL. Unsupported contracts require paired column `mapParam`/`mapResult` or client
`mapParamValue`/`mapResultValue` hooks, including mixed column/client pairs.
Column hooks take precedence in each direction. Native result mapping rejects
finer nonzero seconds or fractions with `QueryError`. It never reruns write
transforms. Explicit PostgreSQL `text`/`varchar` storage and SQLite TEXT preserve
stored spelling. SQLite TEXT keys `03:04` and `03:04:00` differ.

Repeated validators and validators for the same native storage are compatible.
For example, `ip()` with `ipv4()` selects `inet`, and `mac()` with `mac64()` selects `macaddr8`.
Different native storage targets, such as `uuid()` with `ip()` or `mac48()` with
`mac64()`, raise `SchemaError` in PostgreSQL inference regardless of order.
Use one format or select storage explicitly with
`column({ physicalType: { postgresql: 'text' } })` to resolve the storage conflict.
All authored Valibot validators still run.

PostgreSQL returns UUID values in canonical lowercase form. Native IP and MAC storage
can also change spelling, including IPv6 compression and MAC case or separators.
`macaddr8` expands a six-byte MAC address to eight bytes.
Decimal-validated `numeric` values remain JavaScript strings by default, preserving
precision without conversion to JS numbers. PostgreSQL can remove leading decimal zeros.

Existing PostgreSQL `text` or `varchar` columns with these validators now request
native storage. Pin their current storage with a selected `physicalType.postgresql`
override when needed. Review and apply data conversions separately before removing
that override. Inference does not provide automatic casts for legacy data.

The defaults favour safe, unsurprising types: a JS `number` is a double, so
`number()` maps to `double precision` (not `real`, which would lose precision),
and integer widths only narrow/widen when an `integer()` or `safeInteger()`
constraint and bounds justify it. PostgreSQL uses `numeric` for an unbounded
`bigint()` schema; two bounds within signed 64-bit range allow `bigint` storage.
Known Valibot conversions such as `toNumber()`, `toBoolean()`, `parseBoolean()`,
`toDate()`, and `toString()` select storage from their output. Pipeline analysis
follows transformations in order. This PostgreSQL example accepts a string on insert
and returns a number on select:

```typescript
import postgresql from 'db0/connectors/postgresql'
import { createDatabase, defineTable } from 'stratom'
import { number, pipe, string, toNumber } from 'valibot'

const Count = defineTable(
  'counts',
  {
    id: number(),
    value: pipe(string(), toNumber()),
  },
  { primaryKey: 'id' },
)
const db = createDatabase({
  connector: postgresql({ url: process.env.DATABASE_URL! }),
  schemas: [Count],
})
await db.migrate().execute()
await db.insert(Count).values({ id: 1, value: '42' }).execute()
const row = await db.from(Count).executeTakeFirstOrThrow() // row.value is 42
console.log(row.value)
await db.close()
```

`parseJson()` needs a following supported structured schema, such as
`pipe(string(), parseJson(), object({ enabled: boolean() }))`, to establish its
output type. A later supported schema can also recover output inference after an
unknown transformation. Unknown transformation output without that recovery
requires an explicit selected `physicalType` and both parameter and result mapping
hooks on either dialect. Known conversions clear facts from the input type, so old
string lengths, string formats, or numeric bounds do not narrow the converted output. Later constraints
apply to that output. Repeated same-kind validation schemas retain and combine applicable
facts, including nested pipes that do not transform the value.

An unbounded PostgreSQL `safeInteger()` output uses `bigint`; PostgreSQL converts
that storage back to a JS number only when the value is safe. Two bounds can narrow
`safeInteger()` storage to `smallint` or `integer` when they prove the range.
Unbounded `bigint()` uses `numeric` and returns JS `bigint`; it uses PostgreSQL
`bigint` only when both bounds prove the signed 64-bit range. SQLite still requires
finite numbers, safe integral JS numbers, and bigints within signed 64-bit range. A change to inferred storage can produce a type
change migration step for an existing database. Set the selected `physicalType` to
pin the previous storage when needed. A schema type with no sensible selected-adapter
mapping (for example, a mixed string/number union) throws `MigrationError` during desired-schema
lowering rather than silently becoming text.

Compatible unions, object variants, and object intersections infer one storage type.
PostgreSQL widens integer widths and `varchar` lengths across branches, and uses
`text` when a string branch has no length bound. JSON-shaped branches use `jsonb`.
SQLite uses `INTEGER` or `REAL` for compatible number branches, `TEXT` for strings,
`BIGINT` for bigint, `DATETIME` for Date, and `JSON` for JSON-shaped branches.
JSON-shaped composites must produce values that JSON serialization preserves, including
all nested fields and array slots. Inference uses the final output after later structured
stages convert nested values, apply defaults, or project fields away. Nested Date and
bigint values, undefined array items, symbol or unknown record keys, and untyped
passthrough fields such as `looseObject()` cannot use the built-in JSON mapping because
reads would lose their declared output identity. Supply a selected
`physicalType` and both parameter and result mappings on the column, or both client
mapping hooks, to own that conversion. A physical type or only one mapping direction
does not establish the contract. This restriction applies to JSON composites; it does not
change standalone JSON schema mapping.
`union([string(), null()])` accepts SQL NULL but still requires a value on insert.
Mixed JavaScript output identities, such as number with bigint or Date with string,
need both parameter and result mappings in addition to a selected physical type.
PostgreSQL rejects inferred native storage for a union of minute- and second-precision
ISO time formats, because one result conversion cannot preserve both formats. Select
`physicalType.postgresql: 'text'` to retain their exact string spelling.

PostgreSQL choice inference uses every actual enum or picklist value. Integer-number
choices must be safe JavaScript integers; non-finite and unsafe numeric choices
need an explicit PostgreSQL physical type. Inferred `bigint` storage for a number
choice returns a JavaScript number only while it remains safe. Bigint choices
return JavaScript bigints from either `bigint` or `numeric` storage, including
values outside signed int64 in `numeric`. Mixed or unsupported choice outputs
require `column({ physicalType: { postgresql: '...' } })`. PostgreSQL does not
create native ENUM types. Numeric TypeScript enum reverse-mapping entries are
filtered before storage is inferred. SQLite keeps its own INTEGER, REAL, and BIGINT
choice rules and rejects bigint choices outside signed int64.

Use `physicalType` when you need exact
adapter-selected storage and tagged database defaults/generation when database
behavior is intended:

```typescript
const Event = defineTable(
  'events',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid', sqlite: 'blob' } })),
    label: pipe(
      string(),
      column({ databaseDefault: { kind: 'literal', value: 'now()' } }),
    ), // PostgreSQL stores the text "now()", not an expression
    createdAt: pipe(
      date(),
      column({
        databaseDefault: {
          kind: 'portableExpression',
          expression: 'currentTimestamp',
        },
      }),
    ),
    sequence: pipe(
      number(),
      column({
        physicalType: { postgresql: 'integer' },
        generation: { kind: 'identity', mode: 'byDefault' },
      }),
    ),
  },
  { primaryKey: 'id' },
)
```

`databaseDefault` supports tagged literals, portable expressions, and
dialect-tagged expressions. `generation` supports identity, computed, and
dialect-tagged intent; the selected adapter either lowers the requested form or
throws `MigrationError`. `physicalType` is keyed by dialect id, so an override
for another adapter is never selected accidentally.

#### Dialect member contract

See the [Dialect maintainer guide](docs/dialects.md) for the complete member,
connector/session, capability-evidence, registration, and reusable test contracts.

`createDatabase({ connector, ... })` selects exactly one complete `Dialect` member from
`connector.dialect`. Callers do not select identity, migration, query, or operation
adapters separately. Each supported member owns these cohesive facets:

- `identity`: identifier comparison and writable-namespace resolution;
- `naming`: generated physical names, validation, and collision scope;
- `schema`: whole-graph lowering plus physical type/default normalization;
- `query`: AST compilation and parameter/result value mapping;
- `catalog`: scoped catalog observation with explicit supported, unsupported, or
  unavailable capability evidence;
- `operations`: connector session adaptation and structured ping, transaction, and
  savepoint command compilation; and
- `migration`: planning policies, whole-plan lowering, and physical execution.

Whole-graph schema lowering preserves every table handle and canonical identity while
returning canonical lowered tables whose columns retain physical properties and
structured references. The selected migration member alone projects those tables into
its physical DDL AST. Unsupported type mappings and
migration capabilities fail explicitly with `MigrationError`; catalog capabilities use
the structured unsupported/unavailable states instead of falling back to PostgreSQL.
Adding package-supported database behavior is therefore local to one complete member and
one dispatcher registration. PostgreSQL and SQLite are production members.

SQLite uses the exact db0 0.4.0 `node-sqlite` connector and SQLite version 3.37 or
later. Node 22.5 through 22.12 needs `--experimental-sqlite`.
SQLite manages ordinary permanent non-STRICT rowid tables in `main`,
with simple PK/unique/FK constraints, column indexes, portable defaults and AUTOINCREMENT.
Migrations use legal direct operations or atomic table rebuilds that preserve retained
data, rowids and sequence state. Unproven conversions, required-column backfills,
opaque dependencies, attached databases and unsupported table/index forms fail closed.
Destructive table/column drops and unique-index drops that remove a candidate key need
complete incoming dependency evidence through explicit `completeNamespace` migration
ownership. See the [SQLite profile](docs/dialects.md#sqlite-production-profile) for the
supported limits.

The Query facet first creates one client-scoped resolution of registered relations and
members. `createDatabase({ defaultNamespace })` is supplied to that resolution and to
Migration planning, so compilation, predicate parameter mapping, selected/returned
result mapping, and referenced-column physical-type resolution all consume the same
case-folding and namespace policy. Zero and multiple semantic matches are tagged
failures; compilation is synchronous and non-executing. The supported AST covers select/insert/update/delete,
structured joins and comparison predicates, projections and returning, grouping,
aggregates and the documented scalar functions, ordering, limit, and offset.
PostgreSQL accepts omitted, schema-only, and database-plus-schema relation identities:
an explicit registration default takes precedence: an omitted relation is schema-qualified
from that default, while a database-plus-schema default is also checked against the
pinned session before SQL. Without a registration default, omission remains unqualified
for `search_path`/`current_schema()`, while an explicit database is checked against the
pinned session before SQL. Omission is equivalent to
an explicit schema only when the pinned session's resolved namespace evidence names
that schema; a mismatch is rejected before SQL. This preserves `public` behavior on a
public session without introducing a shared or unconditional `public` default. PostgreSQL
operation sessions freshly prove their complete database, physical-session, and ordered
current-schema namespace evidence for every lease and again before reuse; any mismatch
or failed proof discards the session.

A tagged literal string is always a literal, while a tagged expression is
always an expression. By-default identity columns may be omitted on insert or
explicitly supplied; always identity and computed columns are non-insertable.

Valibot defaults, such as `optional(string(), 'new')`, are application defaults
applied during validation. They are not database defaults and do not satisfy a
foreign key using `SET DEFAULT`.

Wrapping a non-nullable `x` in `optional(x)` keeps the column `NOT NULL` in both
dialects. It needs a non-null `column({ databaseDefault })`, identity generation, or
a Valibot optional default so every insert has a value. Use `nullable(x)` or
`nullish(x)` when the stored value itself may be `NULL`.

## Relations

`reference(target, key, options?)` marks a column as a foreign key. The target
is another table handle (or its raw schema). Construction retains only the
structured target relation/column identity. Whole-graph lowering resolves the
target first, so the reference inherits that target's selected-adapter physical
type without copying a PostgreSQL type:

```typescript
import { reference } from 'stratom'

const Post = defineTable(
  'posts',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    authorId: reference(User, 'id', { onDelete: 'cascade' }),
    title: pipe(string(), maxLength(200)),
  },
  { primaryKey: 'id' },
)
```

For circular declarations, pass a local Valibot schema and a deferred target:

```typescript
import type { ReferenceTarget } from 'stratom'

const Person = defineTable(
  'people',
  {
    id: string(),
    teamId: nullable(reference(string(), (): ReferenceTarget => Team, 'id')),
  },
  { primaryKey: 'id' },
)
const Team = defineTable(
  'teams',
  {
    id: string(),
    ownerId: reference(string(), (): ReferenceTarget => Person, 'id'),
  },
  { primaryKey: 'id' },
)
```

`reference(localSchema, () => target, key, options?)` validates values with the
local schema. It retains that schema's input, output, and column options. The
callback supplies the target handle or raw schema during complete-graph lowering.
The target's selected physical type is inherited as with eager references.
The local schema must have a compatible input/output type and storage family.
The callback runs once per graph, including when one declaration is reused.
Its first resolved relation identity stays fixed for that declaration. A later
resolution to another identity fails before planning or execution can use it.
Missing, ambiguous, non-key, or incompatible targets also fail during lowering.
The local schema does not inherit the target's Valibot validators.

TypeScript needs an explicit callback return type for mutually circular
initializers. `ReferenceTarget` works when the local schema defines the value
contract. When the callback has a concrete return type, its column keys and
input/output types also constrain the reference.

The target must be a single-column primary key or independently unique through
`unique: true` or a one-column unique index. A member of a composite primary key
is not a candidate key by itself. Registered table cycles are supported.

## Querying

Reads start from `db.from(Table)`; the default execute path is `select *`.

```typescript
// select specific columns with a filter, ordering, and a limit
const rows = await db
  .from(User)
  .select([User.id, User.email])
  .where(User.email, 'eq', 'a@b.com')
  .orderBy(User.fullName, 'asc')
  .limit(10)
  .execute()

// object shorthand for equality filters
const actives = await db.from(User).where({ active: true }).execute()

// a single row (throws if none)
const one = await db.from(User).where(User.id, 'eq', user.id).executeTakeFirstOrThrow()
```

### Joins and aggregates

```typescript
import { countAll, eq, gt, sum } from 'stratom'

const withAuthors = await db
  .from(Post)
  .innerJoin(User, eq(Post.authorId, User.id))
  .select([Post.title, User.email])
  .execute()

const stats = await db
  .from(User)
  .select((b) => [User.active, b.as(countAll(), 'total'), b.as(sum(User.id), 'idSum')])
  .groupBy(User.active)
  .having(() => gt(User.id, 0))
  .execute()
```

### Inserting, updating, deleting

```typescript
import { excluded } from 'stratom'

// bulk insert (returns all inserted rows by default)
await db
  .insert(User)
  .values([
    { email: 'a@b.com', fullName: 'A' },
    { email: 'c@d.com', fullName: 'C' },
  ])
  .execute()

// PostgreSQL and SQLite upsert using an authored candidate key
await db
  .insert(User)
  .values({ email: 'a@b.com', fullName: 'Updated' })
  .onConflict([User.email])
  .doUpdate({ fullName: excluded(User.fullName) })
  .returning([User.id, User.fullName])
  .execute()

// Ignore a conflicting row
await db
  .insert(User)
  .values({ email: 'a@b.com', fullName: 'Unchanged' })
  .onConflict([User.email])
  .doNothing()
  .execute()

// update requires where(...) or .all()
await db.update(User).set({ fullName: 'Ada L.' }).where(User.id, 'eq', user.id).execute()

// delete returns the deleted rows by default
const deleted = await db
  .delete(User)
  .where(User.id, 'eq', user.id)
  .returning([User.id])
  .execute()

// Report the native affected-row count for insert, update, delete, or upsert
const result = await db
  .update(User)
  .set({ fullName: 'Ada L.' })
  .where(User.id, 'eq', user.id)
  .returningNone()
  .execute() // { rowCount: 1 }, or { rowCount: 0 } when no row matches
```

`onConflict(...)` accepts only an exact authored candidate key: the primary key, a
`unique: true` column, or a unique table index. Composite keys must use the authored
column order. `doUpdate(...)` follows the normal update writable-column rules. Its
values can be validated literals or `excluded(Table.column)` references to insertable
columns on the same table handle. Bulk values and all returning and first-row terminals
remain available after choosing `doNothing()` or `doUpdate(...)`.

Initial upsert support does not accept constraint or index names, partial predicates,
expression indexes, an update `WHERE` clause, arbitrary SQL expressions, MySQL replace,
or SQL `MERGE`.

### Raw SQL execution

Use the scoped `db.sql` tag for SQL, including with `schemas: []`. It starts
execution immediately and returns `Promise<unknown[]>`, with provider values and
no table-specific decoding. Each ordinary interpolation binds a driver-ready
value using the selected dialect's placeholders.

```typescript
import { array, number, object, parse } from 'valibot'

const rows = await db.sql`select 1 as value`
const validated = parse(array(object({ value: number() })), rows)

const email = 'ada@example.com'
const users = await db.sql`select "id" from "users" where "email" = ${email}`

// Quote each identifier part, including embedded quotes and literal dots.
const relation = db.sql.id('public', 'users')
const filter = db.sql.fragment`"email" = ${email}`
await db.sql`select * from ${relation} where ${filter}`
const query = db.sql.fragment`select * from ${relation} where ${filter}`
await db.execute(query)
const nativeRows = await db.execute(db.from(User).compile())

await db.transaction(async (trx) => {
  await trx.sql`update "users" set "email" = ${email} where "id" = ${user.id}`
})
```

Fragments compose without execution; their parameters are numbered in final SQL
order. Use `db.sql.id(...parts)` for dynamic identifiers. Strings interpolated
without this helper always bind as values. Braces are literal SQL; db0's raw brace
interpolation is not supported. The tag uses Stratom's operation session rather
than db0's SQL tag, preserving session guards, FIFO ordering, transaction ownership,
and close draining. Use managed transactions for transaction and savepoint control.

`execute()` rejects plain `{ sql, params }` objects at both the type and runtime
boundaries. Builder `compile()` output retains its session guard and mapped
parameters without mapping them again. The explicit `db.sql.unsafe(text)` escape
hatch creates an executable fragment from trusted SQL text. It does not bind or
escape that text; never concatenate untrusted input into it.

SQL template values need driver-ready representations. For SQLite, encode booleans,
dates, and JSON explicitly when needed:

```typescript
await sqliteDb.sql`insert into "events" ("active", "stamp", "payload")
  values (${active ? 1 : 0}, ${stamp.toISOString()}, ${JSON.stringify(payload)})`
```

Validate `unknown[]` results in caller code when needed. Validation failures occur
outside Stratom's execution boundary. Inside transactions, use `trx.sql` or
`trx.execute` with the callback's scoped client.

Writes without returned rows produce `[]` with the built-in providers. Use write
builders for affected-row counts. SQL templates do not apply schema validation,
write-builder full-table checks, or Migration Plan destructive-change policy.

### Transactions

The callback commits on success and rolls back on throw; nested calls use
savepoints.

```typescript
await db.transaction(async (trx) => {
  const u = await trx
    .insert(User)
    .values({ email: 'e@f.com', fullName: 'Grace' })
    .executeTakeFirstOrThrow()
  await trx
    .insert(Post)
    .values({ id: crypto.randomUUID(), authorId: u.id, title: 'Hello' })
    .execute()
})
```

## Migrations

Migrations diff your registered handles against the live database. Destructive
steps are refused unless explicitly allowed.

```typescript
const plan = await db.migrate().plan()
const preview = await db.migrate().dryRun()
await db.migrate().execute()
await db.migrate().allow('dropColumn', 'dropTable', 'dropIndex').execute()
```

A Migration Plan describes portable semantic intent. Every step names one structured
target built from canonical relation identity, so namespaces, relations, columns, and
indexes stay unambiguous across dialects:

```typescript
{
  kind: 'add_column',
  target: {
    kind: 'column',
    relation: {
      namespace: [
        { role: 'database', identifier: { spelling: 'app', comparisonKey: 'app' } },
        { role: 'schema', identifier: { spelling: 'public', comparisonKey: 'public' } },
      ],
      relation: { spelling: 'users', comparisonKey: 'users' },
    },
    column: { spelling: 'email', comparisonKey: 'email' },
  },
  dataType: 'text',
  notNull: true,
}
```

Steps are ordered by semantic phase (`ensure_namespace`, relations, columns, types and
nullability, indexes, constraints, then destructive cleanup) and then by structured
target order. Execution order and SQL are separate concerns the dialect owns.

`dryRun()` returns the selected dialect's ordered lowered actions without executing
them. Actions retain their source step indexes and can contain zero, one, or many SQL
statements, including actions coalesced from multiple steps. Every bound parameter is
shown as `[REDACTED]`, with one marker per value; parameter values are never included.
SQL text is emitted verbatim, so literal values authored directly into SQL are not
redacted. `dryRun()` performs the same profile validation and whole-plan lowering as
execution, but it does not apply destructive execution permissions or run DDL.

### Errors

| Origin                        | Tags                                                             | Who acts                                                                  |
| ----------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Caller input or configuration | `SchemaError`, `ValidationError`, `QueryError`, `MigrationError` | Change the input, query, or migration configuration.                      |
| Database, driver, or db0      | `DriverError`                                                    | Handle `kind` and `retryable`, or report the dependency failure upstream. |
| Stratom bug                   | `InvariantError` or an unwrapped exception                       | Report the defect to Stratom.                                             |

Catch values are `unknown`. Use `isErrorTag` to narrow one tag, or `isStratomError`
to inspect the full union. Both guards work when two copies of Stratom are loaded.
These examples use the live `db` and `User` from the quick start:

```typescript
import { isErrorTag } from 'stratom'
import { flatten, getDotPath } from 'valibot'

// A missing row can become a 404 without confusing it with another query failure.
const user = await db.from(User).where(User.id, 'eq', -1).executeTakeFirst()
if (user === undefined) console.log('User not found')

// A unique constraint rejected an insert: handle the conflict by kind.
try {
  await db.insert(User).values({ email: 'a@b.com', fullName: 'Another user' }).execute()
} catch (error: unknown) {
  if (isErrorTag(error, 'DriverError') && error.kind === 'uniqueViolation') {
    console.log('Email is already in use', error.constraint)
  } else throw error
}

// Transience is a recovery hint. Decide whether replay is safe before retrying.
try {
  await db.from(User).execute()
} catch (error: unknown) {
  if (isErrorTag(error, 'DriverError') && error.retryable) {
    console.log('Potentially transient failure; check replay safety', error.code)
  } else throw error
}

// Row validation runs when values(...) is called, before execute().
try {
  const payload = JSON.parse('{"email": 7, "fullName": "Ada"}')
  await db.insert(User).values(payload).execute()
} catch (error: unknown) {
  if (isErrorTag(error, 'ValidationError')) {
    console.log(error.operation, error.table, flatten(error.issues))
    console.log(error.issues.map((issue) => getDotPath(issue)))
  } else throw error
}

// A blocked migration describes where it stopped and why.
try {
  await db.migrate().execute()
} catch (error: unknown) {
  if (isErrorTag(error, 'MigrationError')) {
    console.log(
      error.stage,
      error.capabilityIssues?.map((issue) => issue.code),
    )
  } else throw error
}
```

`db.update(User).set(...)` also validates literal values synchronously. Deferred
update expressions can fail validation when the query executes. Query execution can
throw `QueryError` for invalid query use or a missing required row, and `DriverError`
for SQL rejected below Stratom. Migration planning and execution use `MigrationError`
for expected failures. During migration execution, a defect that needs stage and
database outcome context is a `MigrationError` with `defect: true`; its `cause`
retains the original thrown value and stack. Planning and previews preserve defects
unchanged when cleanup succeeds. If cleanup also fails, previews report the original
cause and ordered cleanup failures in a structured migration error. Recognized query and
driver failures retain their tags and expose cleanup evidence directly.

`DriverError.retryable` describes a potentially transient failure, not permission to replay
a write. An INSERT or COMMIT can succeed before its response is lost. Callers must use
idempotency or transaction recovery to decide whether retry is safe. Retry a transaction
as a whole when its failure requires that recovery. Migration outcomes of `unknown` remain
non-retryable. Error JSON retains native fields, cause chains, cleanup evidence, and stacks.

For a caller error report, include the tag, operation, relevant inputs, and the
structured fields such as `ValidationError.issues` or `MigrationError.stage`,
`outcome`, and `capabilityIssues`. For a dependency failure, include
`DriverError.dialect`, `kind`, `retryable`, `code`, `sql`, and the native `cause` and
its original stack. For a suspected Stratom bug, include the stack, reproduction,
and any `InvariantError` message or `MigrationError` defect `cause`. Inspect SQL
before sharing it: bound values are separate, but SQL text can contain authored
literals or sensitive identifiers.

## Query tracing

Wrap a client to trace physical SQL attempts using Node diagnostics channels:

```ts
import { tracingChannel } from 'node:diagnostics_channel'
import { createDatabase, withTracing, QUERY_CHANNEL } from 'stratom'
import type { QueryEvent } from 'stratom'

const original = createDatabase({ connector, schemas: [User] })
const db = withTracing(original)
const channel = tracingChannel(QUERY_CHANNEL) // stratom.query, distinct from db0.query
const subscribers = {
  start(data: unknown) {
    const event = data as QueryEvent
    console.log(event.source, event.query)
  },
  asyncEnd(data: unknown) {
    const event = data as QueryEvent
    console.log(event.durationMs, event.outcome, event.error)
  },
}
channel.subscribe(subscribers)
try {
  await original.from(User).execute() // No events.
  await db.transaction(async (trx) => {
    await trx.from(User).execute() // Traced, including nested transaction savepoints.
  })
} finally {
  channel.unsubscribe(subscribers)
  await original.close() // Shares lifecycle with db.
}
```

Only operations through the returned client emit events. Lazy builders retain the
client that created them. Other wrappers and clients remain independent; wrapping
an already traced client returns it unchanged (including its original options).
Wrapping opens no provider or connection. Both views share FIFO coordination,
transaction guards, close draining, and closed-client rejection.

The lifecycle follows [db0's ordering](https://db0.unjs.io/guide/tracing): success
emits `start` ? `end` ? `asyncStart` ? `asyncEnd`; failure emits `start` ? `end` ?
`error` ? `asyncStart` ? `asyncEnd`. `end` marks promise creation, not SQL completion.
Use `asyncEnd` for the one completion event per physical attempt. All phases share
one `QueryEvent` context. `query` is SQL exactly as sent to the pinned session;
`params` contains ordered bindings; `method` is `query` or `run`; `source` is listed
below. Completion adds `durationMs` and `outcome` (`success` or `error`); failures
also expose `error`, the original physical rejection before driver classification
or migration context. `QueryEvent`, `QuerySource`, and `TracingOptions` are exported.
Result rows and affected-row counts are never exposed (the Node trace context's
`result` is undefined). The payload is distinct from db0's payload.

Sources are selected by the caller's structured operation, without SQL parsing:

- `query`: application SQL, including raw SQL and query builders.
- `lifecycle`: ping, transaction/savepoint commands, and session settings.
- `catalog`: migration catalog acquisition, preconditions, integrity and convergence checks.
- `coordination`: PostgreSQL advisory locks/unlocks; SQLite busy-timeout policy and
  migration `BEGIN IMMEDIATE`, which acquires migration ownership. SQLite migration
  commit/rollback and foreign-key settings are `lifecycle`.
- `ddl`: migration action statements, including SQLite rebuild data-copy statements.

Bound parameters default to `'[REDACTED]'` per position, retaining order and count.
Use `withTracing(original, { queryParameters: 'include' })` to expose values. The
parameter array is copied and frozen; included objects retain their references.
Never mutate the shared event context. SQL literals and error objects can contain
secrets and cannot be redacted automatically. Values are never interpolated into
traced SQL. Diagnostics channels are process-wide: any subscriber can read events.

Duration uses a monotonic clock around the physical session call, excluding queue
wait and synchronous subscriber execution. Untraced calls do no snapshot or timing
work; traced calls without subscribers also skip payload and timing work.
Compilation, validation/session guards, provider open/release/close/cancel, and
provider-private bootstrap/identity/cleanup SQL produce no traces. Aborting before
SQL execution produces no event; cancellation that makes a provider reject produces
a failed attempt. A successful SQL call stays successful even if the migration later fails.

Subscribers follow [Node diagnostics channel semantics](https://nodejs.org/api/diagnostics_channel.html#diagnostics_channelsubscribename-onmessage).
They run synchronously; thrown exceptions trigger `uncaughtException` and may terminate
the process. Async handlers are not awaited and their rejected promises are not
contained by Stratom. Handle failures within subscribers and keep them short.
Stratom installs no process error handlers and provides no observer-isolation guarantee.

Tracing uses `process.getBuiltinModule('node:diagnostics_channel')`, available on
supported Node versions (>=22.5). It checks individual lifecycle channels for
subscribers, including on Node versions without `TracingChannel.hasSubscribers`.
If runtime capability lookup or tracing channels are unavailable, `withTracing`
returns the original client unchanged and emits no events. OpenTelemetry integration
is not included.

## Typed subqueries

Use `scalar(query)`, `inQuery(column, query)`, and `exists(query)` as imports or
expression-builder methods. Subqueries are reusable select builders; compiled SQL
snapshots are not accepted. Compilation executes no SQL.

```typescript
import { alias, exists, inQuery, outer, scalar } from 'stratom'

const titles = db
  .from(Posts)
  .select([Posts.title])
  .where((b) => b.eq(Posts.userId, b.outer(Users.id)))
  .orderBy(Posts.id, 'desc')
  .limit(1)

const rows = await db
  .from(Users)
  .select((b) => [Users.id, b.as(b.scalar(titles), 'latestTitle')])
  .execute()
// { id: number; latestTitle: string | null }[]

const ids = db.from(Posts).select([Posts.userId])
await db
  .from(Users)
  .where((b) => b.inQuery(Users.id, ids))
  .execute()
await db
  .from(Users)
  .where((b) => b.not(b.exists(titles)))
  .execute()

const employee = alias(Users, 'employee')
const manager = alias(Users, 'manager')
const managers = db
  .from(manager)
  .where((b) => b.eq(manager.id, b.outer(employee.managerId)))
await db.from(employee).where(exists(managers)).execute()
```

Scalar projections retain the selected column's value type and result mapping,
with `null` added for an empty result. An empty scalar result bypasses non-null
column conversions. Aggregate and function outputs remain `unknown`; they receive
no inferred conversion and cannot satisfy typed scalar comparisons or IN operands.
Column aliases and scalar aliases retain their literal output names.

Scalar and IN queries must project exactly one value. Known invalid tuples fail
type checking. Dynamic arrays are accepted and validated after wildcard expansion
at compilation. Chained selections count every projected value, including repeated
output names. EXISTS has no single-value restriction. Scalar comparisons work on
either side, including scalar versus literal and scalar versus scalar. The new
forms require compatible declared types after removing nullability and perform no
implicit coercion. Existing literal `null` equality and inequality still mean
`IS NULL` and `IS NOT NULL`.

Ordinary references resolve within their own query. Use `outer(column)` explicitly
for correlation; lookup starts at the nearest enclosing scope. Aliases identify
distinct occurrences of a registered table. Reuse the same alias handle when
referencing an occurrence. Unavailable or ambiguous references, duplicate aliases,
and references to relations unavailable at a JOIN ON position fail before execution.

Subquery predicates work in WHERE, HAVING, JOIN ON, and UPDATE/DELETE filters.
Subqueries in FROM, insert values, update assignments, or RETURNING expressions,
CTEs, set operations, lateral joins, and implicit correlation are not supported.
No relationship inference or nested result objects are added.

Both builders must belong to the same client scope. Separate clients, root versus
transaction clients, distinct transactions, and parent versus nested transactions
cannot be mixed, even when they share a connector or dialect. Execute through the
outer builder; it retains transaction and client lifecycle checks. Use a query
factory to reuse a definition across scopes:

```typescript
const postUserIds = (scope: typeof db) => scope.from(Posts).select([Posts.userId])

await db.transaction(async (trx) => {
  const ids = postUserIds(trx)
  await trx
    .from(Users)
    .where((b) => b.inQuery(Users.id, ids))
    .execute()
})
```

Both dialects preserve SQL three-valued logic for comparisons, IN and NOT IN,
including NULL-containing inner results. Zero scalar rows produce NULL. PostgreSQL
rejects multiple scalar rows; SQLite uses the first row. No implicit limit or
portable cardinality check is inserted. Use explicit ordering and `.limit(1)` when
one deterministic row is required.

## License

MIT
