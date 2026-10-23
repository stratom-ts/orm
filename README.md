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
the complete registered graph. PostgreSQL then infers a SQL column type from
the Valibot schema, including length and range refinements:

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

Inference rules (PostgreSQL):

| Valibot schema                                                      | Inferred type                     |
| ------------------------------------------------------------------- | --------------------------------- |
| `string()`                                                          | `text`                            |
| `pipe(string(), uuid())`                                            | `uuid`                            |
| `pipe(string(), ip())` / `ipv4()` / `ipv6()`                        | `inet`                            |
| `pipe(string(), mac48())`                                           | `macaddr`                         |
| `pipe(string(), mac())` / `mac64()`                                 | `macaddr8`                        |
| `pipe(string(), decimal())`                                         | `numeric`                         |
| `pipe(string(), maxLength(n))` (n ≤ 255)                            | `varchar(n)`                      |
| `number()`                                                          | `double precision`                |
| `pipe(number(), integer())`                                         | `integer`                         |
| `pipe(number(), integer(), minValue, maxValue)` in int16            | `smallint`                        |
| `pipe(number(), integer())` with a bound outside int32              | `bigint`                          |
| `boolean()`                                                         | `boolean`                         |
| `bigint()`                                                          | `numeric`                         |
| `pipe(number(), safeInteger())`                                     | `bigint`                          |
| `pipe(string(), toNumber(), integer(), minValue(0), maxValue(100))` | `smallint`                        |
| `date()`                                                            | `timestamptz`                     |
| String `enum(...)` / `picklist([...])`                              | `text`                            |
| Integer-number choices within int16 / int32 / JS-safe range         | `smallint` / `integer` / `bigint` |
| Fractional-number choices                                           | `double precision`                |
| Bigint choices within / beyond signed int64                         | `bigint` / `numeric`              |
| `object(...)` / `array(...)` / `record(...)`                        | `jsonb`                           |
| `nullable(x)` / `nullish(x)`                                        | wrapped column becomes NULL-able  |
| `union([x, null()])`                                                | `x` storage, NULL allowed         |
| `optional(x)`                                                       | may be omitted; remains NOT NULL  |

For PostgreSQL strings, a selected `physicalType.postgresql` override wins first.
Otherwise, the format validators above select native storage before `minLength`,
`maxLength`, or `length` can select length-based storage. The length validators still run.
Format inference works through `optional`, `exactOptional`, `undefinedable`,
`nullable`, `nullish`, `nonOptional`, `nonNullable`, and `nonNullish`, including
nested pipes. A reference inherits the target column's selected physical type,
including inferred native storage or an explicit `text` or `varchar(n)` override.
An override for SQLite does not suppress PostgreSQL inference.

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
SQLite stores UUID, IP, MAC, and decimal strings and references as `TEXT` unless
its own physical type is selected explicitly. It preserves exact string spelling,
including leading and trailing decimal zeros.

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
follows transformations in order. For example, `pipe(string(), toNumber())`
accepts a string on insert and returns a number on select:

```typescript
const Count = defineTable(
  'counts',
  { value: pipe(string(), toNumber()) },
  { primaryKey: 'value' },
)
await db.insert(Count).values({ value: '42' }).execute()
const row = await db.from(Count).executeTakeFirstOrThrow() // row.value is 42
```

`parseJson()` needs a following supported structured schema, such as
`pipe(string(), parseJson(), object({ enabled: boolean() }))`, to establish its
output type. A later supported schema can also recover output inference after an
unknown transformation. Unknown output without that recovery requires an explicit
selected `physicalType`; SQLite additionally needs both parameter and result mapping
hooks. Known conversions clear facts from the input type, so old string lengths,
string formats, or numeric bounds do not narrow the converted output. Later constraints
apply to that output.

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
create native ENUM types. SQLite keeps its own INTEGER, REAL, and BIGINT choice
rules and rejects bigint choices outside signed int64.

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

An `optional(x)` column is still `NOT NULL` in PostgreSQL. It must declare a
non-null `column({ databaseDefault })`, use identity generation, or provide a Valibot
optional default so every insert has a value. Use `nullable(x)` or `nullish(x)`
when the stored value itself may be `NULL`.

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

// A required row is missing: change the lookup or respond with 404.
try {
  await db.from(User).where(User.id, 'eq', -1).executeTakeFirstOrThrow()
} catch (error: unknown) {
  if (isErrorTag(error, 'QueryError')) console.log(error.message)
  else throw error
}

// A unique constraint rejected an insert: handle the conflict by kind.
try {
  await db.insert(User).values({ email: 'a@b.com', fullName: 'Another user' }).execute()
} catch (error: unknown) {
  if (isErrorTag(error, 'DriverError') && error.kind === 'uniqueViolation') {
    console.log('Email is already in use', error.constraint)
  } else throw error
}

// A transient database failure may be retried by the caller's retry policy.
try {
  await db.from(User).execute()
} catch (error: unknown) {
  if (isErrorTag(error, 'DriverError') && error.retryable) {
    console.log('Retry the operation', error.code)
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
unchanged.

For a caller error report, include the tag, operation, relevant inputs, and the
structured fields such as `ValidationError.issues` or `MigrationError.stage`,
`outcome`, and `capabilityIssues`. For a dependency failure, include
`DriverError.dialect`, `kind`, `retryable`, `code`, `sql`, and the native `cause` and
its original stack. For a suspected Stratom bug, include the stack, reproduction,
and any `InvariantError` message or `MigrationError` defect `cause`. Inspect SQL
before sharing it: bound values are separate, but SQL text can contain authored
literals or sensitive identifiers.

## License

MIT
