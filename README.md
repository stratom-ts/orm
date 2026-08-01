# stratom

A schema-first ORM for PostgreSQL: [Valibot](https://valibot.dev/) schemas, desired-state migrations, and a typed query builder. Transport is [db0](https://db0.unjs.io/); app code uses stratom only.

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

`column({ type })` is optional. When it is omitted, stratom infers the SQL
column type directly from the Valibot schema — including length and range
refinements — so a table can be described purely in Valibot:

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
justify it. A schema type with no sensible mapping (e.g. a `union`) throws a
`SchemaError` at build time rather than silently becoming `text` — add an
explicit `column({ type })` for those.

Reach for `column({ type })` when you need an exact SQL type the inference
doesn't produce (e.g. `uuid`, `numeric(10,2)`, `char(n)`), an identity column
(`generated`), a `unique` constraint, or a `default`.

An `optional(x)` column is still `NOT NULL` in PostgreSQL. It must declare a
non-null `column({ default })`, use identity generation, or provide a Valibot
optional default so every insert has a value. Use `nullable(x)` or `nullish(x)`
when the stored value itself may be `NULL`.

## Relations

`reference(target, key, options?)` marks a column as a foreign key. The target
is another table handle (or its raw schema) and the referenced column's type is
inferred, so you don't repeat it:

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

Migrations diff registered handles against the live database. A handle owns only its exact
relation and uses complete member shape by default. Complete shape removes undeclared
columns and indexes. Extra unique and foreign-key constraints currently fail planning as an
explicit capability limit because constraint-drop steps are not yet supported. It never
owns other tables merely because they share a schema. Destructive steps are refused unless
explicitly allowed, but `allow()` grants execution permission only and never expands
ownership.

```typescript
const plan = await db.migrate().dryRun()
await db.migrate().execute()
await db.migrate().allow('dropColumn', 'dropTable', 'dropIndex').execute()
```

Use the separate `migrationOwnership` manifest to preserve undeclared members, request an
exact table deletion, or exclusively manage all observed relations in a namespace:

```typescript
const db = createDatabase({
  connector: postgresql({ url: process.env.DATABASE_URL! }),
  schemas: [User],
  migrationOwnership: [
    { kind: 'relation', relation: User, shape: 'additive' },
    {
      kind: 'absentRelation',
      relation: {
        namespace: [{ role: 'schema', spelling: 'public' }],
        relation: 'legacy_users',
      },
    },
    {
      kind: 'completeNamespace',
      namespace: [{ role: 'schema', spelling: 'audit' }],
    },
  ],
})
```

`completeNamespace` also represents an intentionally empty namespace when no handles are
registered there. The current table-only catalog can observe namespace existence through
the writable default or a table, but cannot distinguish an absent custom namespace from an
already existing empty one. In that case dry runs retain an idempotent `create_schema` step.

Unnamed indexes and constraints receive adapter-owned deterministic physical names during
migration planning. Generated names always contain a semantic digest and respect the
adapter's identifier length and collision scope. Explicit names that are too long or
collide fail planning and are never truncated.

Catalog adoption is limited to validated, non-deferrable constraints and valid simple
indexes (plain columns, default B-tree method/order/opclasses/collations, no predicate,
expressions, included columns, or `NULLS NOT DISTINCT`). PK/unique constraints must have the
same supported backing-index semantics. Rich, invalid, or unknown PostgreSQL objects fail as
unsupported drift rather than being adopted or replaced implicitly.

### Errors

| Error             | When                                               |
| ----------------- | -------------------------------------------------- |
| `MigrationError`  | Unsafe migration, lock failure, unsupported diff   |
| `QueryError`      | Execution / closed client / driver failures        |
| `ValidationError` | Insert/update Valibot validation failures          |
| `SchemaError`     | Invalid `defineTable` / metadata / registry misuse |

Use `catchTag` / `catchTags` for tagged handling.

## License

MIT
