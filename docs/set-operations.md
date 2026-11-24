# SQL set operations

PostgreSQL and SQLite support `union`, `unionAll`, `intersect`, and `except` on selects, including `db.from(Table)`.

```ts
const active = db.from(Users).select([Users.id, Users.email])
const archived = db.from(ArchivedUsers).select([ArchivedUsers.id, ArchivedUsers.email])
const rows = await active.unionAll(archived).orderBy('id', 'asc').limit(50).execute()
```

`union` removes duplicate projected rows. `unionAll` retains duplicates. `intersect` returns distinct rows present in both operands. `except` returns distinct left rows absent from the right. Equality, NULL comparison, and collation follow native database semantics. SQL compares the complete projection before result conversion. No ordering is promised without compound `orderBy`.

Each operation captures both complete operands and returns a fresh `CompoundSelectBuilder<TResult>`. Reusing either operand does not change it.

```ts
a.union(b).intersect(c) // (a UNION b) INTERSECT c
a.union(b.intersect(c)) // a UNION (b INTERSECT c)
a.orderBy('id').limit(10).unionAll(b) // limit only a
a.unionAll(b).orderBy('id').limit(10) // limit the compound
a.unionAll(b).limit(10).except(c) // the limited compound is the left operand
```

The compiler preserves this exact tree in both dialects, including nested pagination. Internal SQL wrappers do not expose a derived-table API.

A compound exposes the four set methods, `orderBy`, `limit`, `offset`, `compile`, `execute`, `executeTakeFirst`, and `executeTakeFirstOrThrow`. Build branch filters, joins, selection, and grouping before composition. Compounds do not expose these branch methods, keyset pagination, or `executeNested`.

Compound `orderBy` accepts selected application output names. It rejects column references, expressions, ordinals, and unselected names. Repeated ordering appends terms. Pagination replaces earlier values on the same compound. Output aliases use the existing bounded SQL alias machinery.

Both operands must use the same client or transaction scope. Selects from different clients, parent transactions, and sibling transactions cannot mix. Each compound executes as one statement through the owning operation scope. Compilation performs no SQL and returns an immutable snapshot.

## Compatible outputs

Registered wildcards expand before validation. Operands must have the same nonzero output count, names, and order. Use selection aliases to reconcile source names. Duplicate or unresolved names reject. Known TypeScript shape, order, and non-null type mismatches fail statically. Dynamic selections also receive runtime validation.

Non-null output types must match, including literal, branded, and structured types. `any` and `unknown` do not prove compatibility. `union`, `unionAll`, and conservatively `intersect` widen SQL nullability in either operand order. `except` retains the left type and nullability. Outer-join and scalar-subquery NULLs count as SQL nullability. Defaults and omitted write inputs do not make returned properties optional.

The initial runtime proof supports built-in PostgreSQL and SQLite outputs with matching normalized physical SQL types and logical result representations. It supports string, number, bigint, boolean, Date, and compatible JSON column outputs, including aliases and different source tables. Temporal formats, numeric precision behavior, and JSON representation must match. SQLite affinity alone does not prove compatibility.

Projected custom column or client result mappings reject because SQL set operations do not retain branch provenance. Custom parameter mappings in branch predicates still run normally. Custom dialects and expressions without source/storage evidence also reject. There are no implicit casts, heterogeneous unions, or result-mapping overrides. Validation happens before SQL, even for empty operands. Diagnostics identify the output name or position.

## Subqueries

Compounds work with `scalar`, `inQuery`, and `exists`. Scalar and IN require one output. Scalar adds NULL when no row exists. Multiple-row scalar behavior follows the selected database. Explicit `outer(...)` references can use a permitted enclosing query scope. Set operands are sibling scopes and cannot reference each other implicitly.
