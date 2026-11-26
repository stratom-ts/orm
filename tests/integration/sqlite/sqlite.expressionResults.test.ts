import { date } from 'valibot'
import { expect, it } from 'vitest'

import { defineTable, eq } from '@/index'

import {
  NumericValues,
  assertExpressionResults,
  expressionTables,
} from '../support/expressionResultsContract'

import { withSqliteDatabase } from './sqliteIntegration'

it('should returns typed native SQLite expression values through query composition', async () => {
  await withSqliteDatabase(expressionTables, async ({ db }) => {
    await assertExpressionResults(db)

    await expect(
      db
        .from(NumericValues)
        .select((b) => [b.as(b.sum(NumericValues.big), 'sum')])
        .execute(),
    ).rejects.toMatchObject({ cause: { message: 'integer overflow' } })
  })
})

it('should rejects SQLite date truncation before execution', async () => {
  const Dates = defineTable(
    'unsupported_trunc',
    { created: date() },
    { primaryKey: 'created' },
  )

  await withSqliteDatabase([Dates], async ({ db }) => {
    expect(() =>
      db
        .from(Dates)
        .select((b) => [b.as(b.dateTrunc('day', Dates.created), 'day')])
        .compile(),
    ).toThrow(/does not support date_trunc/)
  })
})

it('should filters a native SQLite current timestamp CTE with its decoded Date parameter', async () => {
  const Dates = defineTable('clock_rows', { created: date() }, { primaryKey: 'created' })
  await withSqliteDatabase([Dates], async ({ db, native }) => {
    await db.migrate().execute()

    await db
      .insert(Dates)
      .values({ created: new Date('2026-06-15T03:04:05Z') })
      .execute()

    // Fix the clock to test native timestamp spelling without a second-boundary race.
    native.function('current_timestamp', () => '2026-06-15 03:04:05')
    const clock = db.cte(
      'clock',
      db.from(Dates).select((b) => [b.as(b.now(), 'now')]),
    )

    const row = await db.with(clock).from(clock).executeTakeFirstOrThrow()
    expect(
      await db.with(clock).from(clock).where(eq(clock.now, row.now)).execute(),
    ).toEqual([row])
  })
})
