# schema-orm

A schema-driven ORM for PostgreSQL, built on [Valibot](https://valibot.dev/) and [Kysely](https://kysely.dev/).

Define your database schema using Valibot schemas with custom metadata actions, and schema-orm handles type inference, schema diffing, and safe migrations.

## Features

- **Schema-defined tables** — Define tables and columns using Valibot schemas with metadata actions
- **PostgreSQL type inference** — Automatically maps Valibot types (string, number, boolean, date, etc.) to PostgreSQL column types
- **Schema diffing** — Compare local schema definitions against live database schemas
- **Safe migrations** — Generate and run ALTER TABLE migrations with data integrity checks (prevents dropping columns with data, setting NOT NULL on columns with NULL values)
- **Index management** — Create indexes from table metadata
- **Foreign key references** — Define relationships using the `references()` helper

## Installation

```bash
pnpm add schema-orm valibot kysely
```

## Usage

```typescript
import { pipe, object, string, number, title } from 'valibot'
import { column, table, runMigrations } from 'schema-orm'

const UserSchema = pipe(
  object({
    id: pipe(string(), column({ type: 'uuid' })),
    name: pipe(string(), column({ type: 'varchar(255)' })),
    email: pipe(string(), column({ type: 'varchar(255)', unique: true })),
    age: pipe(number(), column({ type: 'integer' })),
  }),
  title('users'),
  table({ name: 'users', primaryKey: 'id' }),
)

// Run migrations against your database
await runMigrations(db, [UserSchema])
```

## License

MIT
