import { nullable, number } from 'valibot'
import { expect, it } from 'vitest'

import { alias, defineTable, eq, inQuery, not, scalar } from '@/index'

import { withSqliteDatabase } from './sqliteIntegration'

const Values = defineTable(
  'subquery_values',
  { id: number(), value: nullable(number()) },
  { primaryKey: 'id' },
)

it('should use ordered first-row cardinality and native IN NULL semantics', async () => {
  await withSqliteDatabase([Values], async ({ db }) => {
    await db.migrate().execute()

    await db
      .insert(Values)
      .values([
        { id: 1, value: 1 },
        { id: 2, value: null },
      ])
      .execute()

    const inner = alias(Values, 'inner')
    const ordered = db.from(inner).select([inner.id]).orderBy(inner.id, 'desc')
    expect(
      await db
        .from(Values)
        .select((b) => [b.as(scalar(ordered), 'first')])
        .execute(),
    ).toEqual([{ first: 2 }, { first: 2 }])

    const values = db.from(inner).select([inner.value])
    expect(
      await db
        .from(Values)
        .where(inQuery(Values.id, values))
        .select([Values.id])
        .execute(),
    ).toEqual([{ id: 1 }])

    expect(
      await db
        .from(Values)
        .where(not(inQuery(Values.id, values)))
        .execute(),
    ).toEqual([])

    const absent = scalar(db.from(inner).select([inner.id]).where(eq(inner.id, 99)))
    expect(await db.from(Values).where(eq(Values.id, absent)).execute()).toEqual([])
  })
})
