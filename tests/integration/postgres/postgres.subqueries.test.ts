import { number } from 'valibot'
import { expect, it } from 'vitest'

import { alias, defineTable, scalar } from '@/index'

import { withPostgresDatabase } from './postgresIntegration'

const Values = defineTable('subquery_values', { id: number() }, { primaryKey: 'id' })
it('preserves PostgreSQL rejection of multiple scalar rows', async () => {
  await withPostgresDatabase([Values], async ({ db }) => {
    await db.migrate().execute()

    await db
      .insert(Values)
      .values([{ id: 1 }, { id: 2 }])
      .execute()

    const inner = alias(Values, 'inner')
    await expect(
      db
        .from(Values)
        .select((b) => [b.as(scalar(db.from(inner).select([inner.id])), 'value')])
        .execute(),
    ).rejects.toMatchObject({ cause: { code: '21000' } })
  })
})
