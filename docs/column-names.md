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

An explicit `name` takes precedence over any future naming convention. With no
explicit name, the physical name is the application property. No global convention
option exists yet. Wrappers such as `nullable()` retain the metadata and application types.

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
