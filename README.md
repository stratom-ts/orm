# schema-orm

A schema-first ORM for PostgreSQL: [Valibot](https://valibot.dev/) schemas, desired-state migrations, and a typed query builder. Transport is [db0](https://db0.unjs.io/); app code uses schema-orm only.

## Features

- **Schema-defined tables** — `defineTable(name, columns, options)` with Valibot `column` / `reference`
- **db0 connector** — `createDb({ connector, schemas })` owns the connection lifecycle
- **Desired-state migrations** — `db.migrate().dryRun()` / `.execute()` with safe defaults, allowlist, and advisory lock
- **Typed CRUD** — `db.from(Table).select|insert|update|delete` with column refs
- **Transactions** — callback API; nested calls use savepoints
- **Tagged errors** — `MigrationError`, `QueryError`, `ValidationError`, `SchemaError`

## Installation

```bash
pnpm add schema-orm valibot db0
# plus the driver required by your connector (e.g. pg for PostgreSQL)
```

## Usage

```typescript
import { createDb, defineTable, column } from 'schema-orm'
import { postgresql } from 'db0/connectors/postgresql'
import { number, pipe, string } from 'valibot'

const User = defineTable(
  'users',
  {
    id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
    email: pipe(string(), column({ type: 'text', unique: true })),
  },
  { primaryKey: 'id' },
)

const db = createDb({
  connector: postgresql({ url: process.env.DATABASE_URL! }),
  schemas: [User],
})

await db.migrate().execute()

const user = await db
  .from(User)
  .insert({ email: 'a@b.com' })
  .returning([User.id, User.email])
  .executeTakeFirstOrThrow()

const rows = await db
  .from(User)
  .select([User.id, User.email])
  .where(User.email, 'eq', 'a@b.com')
  .orderBy(User.email, 'asc')
  .limit(10)
  .execute()

await db.transaction(async (trx) => {
  await trx
    .from(User)
    .update({ email: 'b@c.com' })
    .where(User.id, 'eq', user.id)
    .execute()
})

await db.close()
```

### Migrations

```typescript
const plan = await db.migrate().dryRun()
await db.migrate().execute()
await db.migrate().allow('dropColumn', 'dropTable', 'dropIndex').execute()
```

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
