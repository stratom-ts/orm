# stratom

A schema-first ORM with dialect-neutral authoring and PostgreSQL lowering:
[Valibot](https://valibot.dev/) schemas, desired-state migrations, and a typed
query builder. Transport is [db0](https://db0.unjs.io/); app code uses stratom
only.

## Features

- **Schema-defined tables** — `defineTable(name, columns, options)` with Valibot `column` / `reference`
- **db0 connector** — `createDatabase({ connector, schemas })` owns the connection lifecycle
- **Desired-state migrations** — `db.migrate().dryRun()` / `.execute()` with safe defaults, allowlist, and advisory lock
- **Typed CRUD** — `db.from(Table).select|insert|update|delete` with column refs
- **Transactions** — callback API; nested calls use savepoints
- **Tagged errors** — `MigrationError`, `QueryError`, `ValidationError`, `SchemaError`

## Installation

```bash
pnpm add stratom valibot db0
# plus the driver required by your connector (e.g. pg for PostgreSQL)
```

## Quick start

```typescript
import { createDatabase, defineTable, column } from 'stratom'
import { postgresql } from 'db0/connectors/postgresql'
import { boolean, number, pipe, string } from 'valibot'

const User = defineTable(
  'users',
  {
    id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
    email: pipe(string(), column({ type: 'text', unique: true })),
    fullName: pipe(string(), column({ type: 'text' })),
    active: pipe(boolean(), column({ type: 'boolean', default: true })),
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
    orgId: pipe(string(), column({ type: 'uuid' })),
    userId: pipe(string(), column({ type: 'uuid' })),
    role: pipe(string(), column({ type: 'text', default: 'member' })),
  },
  {
    schema: 'public', // Postgres namespace (optional; defaults to search_path)
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

`primaryKey` and every index `columns` entry are constrained to the table's own
column names, so a typo is a compile error:

```typescript
defineTable(
  'users',
  { id: pipe(number(), column({ type: 'integer' })) },
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

Inference rules (PostgreSQL):

| Valibot schema                                           | Inferred type                    |
| -------------------------------------------------------- | -------------------------------- |
| `string()`                                               | `text`                           |
| `pipe(string(), maxLength(n))` (n ≤ 255)                 | `varchar(n)`                     |
| `number()`                                               | `double precision`               |
| `pipe(number(), integer())`                              | `integer`                        |
| `pipe(number(), integer(), minValue, maxValue)` in int16 | `smallint`                       |
| `pipe(number(), integer())` with a bound outside int32   | `bigint`                         |
| `boolean()`                                              | `boolean`                        |
| `bigint()`                                               | `bigint`                         |
| `date()`                                                 | `timestamptz`                    |
| `enum(...)` / `picklist([...])`                          | `text`                           |
| `object(...)` / `array(...)` / `record(...)`             | `jsonb`                          |
| `nullable(x)` / `nullish(x)`                             | wrapped column becomes NULL-able |
| `optional(x)`                                            | may be omitted; remains NOT NULL |

The defaults favour safe, unsurprising types: a JS `number` is a double, so
`number()` maps to `double precision` (not `real`, which would lose precision),
and integer widths only narrow/widen when an `integer()` constraint and bounds
justify it. A schema type with no sensible selected-adapter mapping (for
example, a `union`) throws `MigrationError` during desired-schema lowering
rather than silently becoming text.

For new portable authoring, use `physicalType` when you need exact
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

#### Dialect adapter migration

The publicly re-exported `Dialect` contract now requires whole-graph desired-schema
lowering. Third-party adapters must add and implement:

```typescript
lowerDesiredSchema(graph: AuthoredDesiredSchema): LoweredDesiredSchema
```

The implementation must preserve each table handle and canonical identity while
returning one physical `CreateTableAst` per table. Adapters should report unsupported
type mappings and capabilities with `MigrationError`.

`type`, primitive `default`, `generated`, and `autoIncrement` remain available
as the PostgreSQL compatibility ingress. Legacy expression-like defaults keep
their existing PostgreSQL interpretation. Prefer the tagged forms in new code:
a tagged literal string is always a literal, while a tagged expression is
always an expression. `autoIncrement: true` and by-default identity may be
omitted on insert or explicitly supplied; always identity and computed columns
are non-insertable.

Valibot defaults, such as `optional(string(), 'new')`, are application defaults
applied during validation. They are not database defaults and do not satisfy a
foreign key using `SET DEFAULT`.

An `optional(x)` column is still `NOT NULL` in PostgreSQL. It must declare a
non-null `column({ default })`, use identity generation, or provide a Valibot
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
    id: pipe(string(), column({ type: 'uuid' })),
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
// bulk insert (returns all inserted rows by default)
await db
  .insert(User)
  .values([
    { email: 'a@b.com', fullName: 'A' },
    { email: 'c@d.com', fullName: 'C' },
  ])
  .execute()

// update requires where(...) or .all()
await db.update(User).set({ fullName: 'Ada L.' }).where(User.id, 'eq', user.id).execute()

// delete returns the deleted rows by default
const deleted = await db
  .delete(User)
  .where(User.id, 'eq', user.id)
  .returning([User.id])
  .execute()
```

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
const plan = await db.migrate().dryRun()
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

### Errors

| Error             | When                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `MigrationError`  | Unsafe migration, lock failure, unsupported diff, schema-type mapping, or dialect capability failure |
| `QueryError`      | Execution / closed client / driver failures                                                          |
| `ValidationError` | Insert/update Valibot validation failures                                                            |
| `SchemaError`     | Invalid `defineTable` / metadata / registry misuse                                                   |

Use `catchTag` / `catchTags` for tagged handling.

## License

MIT
