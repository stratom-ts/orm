# Keyset pagination

`after(order, values)` and `before(order, values)` return ordinary predicates for `.where()`.
Each order term requires `column`, `direction` (`asc` or `desc`), and `nulls` (`first` or `last`).
Pass the same columns, directions, and null placement to `.orderBy(column, direction, nulls)`.
Cursor values are application values in order-term order. Existing value mapping applies during query compilation.

The cursor boundary is exclusive. Append a unique, nonnullable tie-breaker, such as the primary key, to the order and cursor tuple.
Without a unique order, equal rows can fall across a page boundary and be skipped.
The helpers do not infer a primary key or validate uniqueness in the database.
Use a consistent database snapshot if concurrent writes must not change traversal results.

```ts
const order = [
  { column: Users.score, direction: 'asc', nulls: 'last' },
  { column: Users.id, direction: 'asc', nulls: 'last' },
] as const
const page = await db
  .from(Users)
  .where(eq(Users.active, true))
  .where(after(order, [last.score, last.id]))
  .orderBy(Users.score, 'asc', 'last')
  .orderBy(Users.id, 'asc', 'last')
  .limit(20)
  .execute()
```

For a single unique column, use one term and one cursor value:

```ts
const idOrder = [{ column: Users.id, direction: 'asc', nulls: 'last' }] as const
const predicate = after(idOrder, [last.id])
```

`before` selects rows before the cursor in the declared order. It does not reverse the query order.
For the nearest previous page, reverse every direction and null placement in the query, then reverse the returned rows:

```ts
const previous = await db
  .from(Users)
  .where(eq(Users.active, true))
  .where(before(order, [first.score, first.id]))
  .orderBy(Users.score, 'desc', 'first')
  .orderBy(Users.id, 'desc', 'first')
  .limit(20)
  .execute()
previous.reverse()
```

Null cursor values compare equal to null for prefix matching. Null placement is independent of sort direction.
Empty orders, mismatched cursor lengths, undefined values, and invalid order terms throw `QueryError`.
An omitted `orderBy` null placement retains the dialect default. Always specify it for keyset pagination.
Opaque cursor tokens are outside this API. Applications can store or encode the cursor tuple using their own value format.
