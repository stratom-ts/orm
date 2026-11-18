# Application and physical column names

Use `column({ name })` to store an application property under an exact database column name:

```ts
const User = defineTable(
  'users',
  {
    id: pipe(string(), column({ name: 'user_id' })),
    fullName: nullable(pipe(string(), column({ name: 'displayName' }))),
  },
  { primaryKey: 'id', indexes: [{ columns: ['fullName'] }] },
)

const Post = defineTable(
  'posts',
  {
    id: string(),
    authorId: pipe(reference(User, 'id'), column({ name: 'author_id' })),
  },
  { primaryKey: 'id' },
)

await db.insert(User).values({ id: 'u1', fullName: 'Ada' }).execute()
await db.from(User).where('fullName', 'eq', 'Ada').execute()
// [{ id: 'u1', fullName: 'Ada' }]
```

Inputs, results, column references, predicates, joins, expressions, grouping, ordering,
returning clauses, conflict targets, upsert assignments, primary keys, indexes, and
references use application properties. `User.fullName.column` is `'fullName'`.
`excluded(User.fullName)` reads the proposed value of physical `displayName`.
The local reference above uses `posts.author_id` and targets `users.user_id`.
A referenced physical name never replaces the local physical name.

An explicit `name` takes precedence over the client naming function. With no
explicit name or naming function, the physical name is the application property.
Wrappers such as `nullable()` retain the metadata and application types.

Application lookup is exact in both PostgreSQL and SQLite: `'FULLNAME'` does not
address `fullName`. Physical names are not alternate application references.
Application names can match another property's physical name, and mappings can swap
names. PostgreSQL compares quoted physical names exactly; SQLite compares physical
names without ASCII case distinctions.

`createDatabase()` validates physical mappings before acquiring a database session.
Invalid runtime values, empty names, NUL characters, names beyond the dialect's
physical identifier limit, and duplicate physical names throw `SchemaError`.
PostgreSQL's 63-byte physical limit counts UTF-8 bytes. Application properties and
explicit result aliases do not have this physical limit. Compilation uses bounded,
round-trippable SQL output aliases, with internal aliases for names that SQL cannot
preserve; execution restores the exact requested names before value mapping.
`db.execute(builder.compile())` restores names but does not apply table value mapping.

All implicit selections, `selectAll()`, and `returningAll()` include declared properties
only. Extra database columns are excluded, including for tables without explicit
mappings. This deliberately changes wildcard behavior. SQLite application lookup is
now exact, even though physical comparison remains case-insensitive for ASCII.

Explicit aliases control result keys. Value mapping follows the selected source:

```ts
await db
  .from(User)
  .select((b) => [b.as(User.fullName, 'name')])
  .execute()
// [{ name: 'Ada' }]
```

Column mapping overrides take precedence over client overrides and dialect defaults.
Duplicate output names fail before execution. Joined results are flat: supply explicit
aliases when properties collide.

Migration Plans use effective physical identifiers for columns, constraints, indexes,
generated object names, and canonical ordering. Renaming application `displayName` to
`fullName` while setting `name: 'displayName'` produces an empty Migration Plan against
matching storage. Update primary keys, indexes, and references to the new application
property. Stored values and generated physical object names remain unchanged.

Changing the effective physical name is a desired storage change. Reconciliation adds
the new column; complete ownership makes the old column a drop candidate, and additive
ownership retains it. Existing destructive-operation permissions still apply. Stratom
does not infer a physical rename or copy stored values. Structured Migration Targets,
canonical relation identity, and Semantic Profile checks continue to apply.

Use `db.migrate().renameColumn({ table: User, from: 'displayName', to: 'fullName' })`
when changing actual storage. This explicit intent uses physical names and native
rename statements. It preserves supported data and dependencies. Without intent,
reconciliation retains the add/drop behavior described above. See the public
[migration contract](../README.md#migrations) for conflicts and supported limits.

## Client column naming

Use `naming.columns` to set a physical name for each column without an explicit name:

```ts
import { createDatabase, column, defineTable } from 'stratom'
import { snakeCase } from 'stratom/naming'

const User = defineTable(
  'users',
  {
    userId: number(),
    fullName: string(),
    legacyName: pipe(string(), column({ name: 'displayName' })),
  },
  { primaryKey: 'userId' },
)

const db = createDatabase({
  connector,
  schemas: [User],
  naming: { columns: snakeCase },
})
// Physical names: user_id, full_name, displayName.
// User.fullName.column remains 'fullName'.
```

The callback receives `{ column, table }`. `column` is the application property,
and `table` is the table name given to `defineTable()`. Custom functions use the same API:

```ts
naming: {
  columns: ({ column, table }) => `${table}_${column}`.toLowerCase(),
}
```

`createDatabase()` calls the function once for each column without an explicit name,
before it acquires a session. It never calls the function for an explicit name.
The client stores the resolved map. Queries, migrations, transaction clients and tracing
views share that map. Shared table handles do not change, so clients can use different
functions with the same handles. Custom function determinism is the caller's responsibility.
A function cannot produce different names within one client because resolution runs once.

A thrown callback value becomes the `cause` of a `SchemaError` that identifies the table
and application column. Invalid results and collisions also fail before session acquisition.
Names are never shortened, repaired or made unique. PostgreSQL uses exact comparison and a
63-byte UTF-8 limit. SQLite uses ASCII case-insensitive comparison and has no finite
identifier limit in Stratom's naming profile.

`snakeCase` inserts an underscore at these boundaries, unless either adjacent character
is already an underscore:

1. Before an ASCII uppercase letter after a character that is not ASCII uppercase.
2. Between two ASCII uppercase letters when an ASCII lowercase letter follows the second.
3. Before a digit after a character that is not a digit.
4. After a digit before an ASCII letter.

It then converts ASCII uppercase letters to lowercase. Other characters do not change.
It keeps existing underscores and does not use locale-dependent case conversion.

| Application property | Physical name    |
| -------------------- | ---------------- |
| `id`                 | `id`             |
| `fullName`           | `full_name`      |
| `FullName`           | `full_name`      |
| `userID`             | `user_id`        |
| `createdAtUTC`       | `created_at_utc` |
| `HTMLParser`         | `html_parser`    |
| `address2`           | `address_2`      |
| `homeAddress2`       | `home_address_2` |
| `v2Api`              | `v_2_api`        |
| `md5hash`            | `md_5_hash`      |
| `full_name`          | `full_name`      |
| `full_Name`          | `full_name`      |
| `address_2`          | `address_2`      |
| `_internalId`        | `_internal_id`   |
| `caféOwner`          | `café_owner`     |
| `ÉtatCivil2`         | `État_civil_2`   |
| `userIDs`            | `user_i_ds`      |

Applying the function again to its output leaves the result unchanged. Acronym detection
has limits: use `column({ name: 'user_ids' })` for `userIDs`. The output is a public storage
contract. Changing this output requires a semver-major release. The function is available
only from `stratom/naming`, so applications that do not import it do not bundle it.

Enabling, disabling or changing a function can change physical names. This is desired
storage change, with the same ownership and destructive-operation rules described above.
Stratom does not infer a rename or copy values. To keep existing storage and values, set
an explicit `column({ name: 'oldName' })` before you enable the function. Explicit names
remain exact, including case. Generated primary key, unique, foreign key and index names
use the effective physical names.

The Semantic Profile includes a canonical fingerprint of resolved table, application
column and physical column mappings. Lowering rejects a plan built with different effective
names, even if both clients use the same function object. Different functions that resolve
to the same map have the same fingerprint. Canonical Migration Plan ordering stays unchanged.
