import { date, integer, number, pipe } from 'valibot'
import { expect, it } from 'vitest'

import { column, defineTable, eq } from '@/index'

import {
  NumericValues,
  assertExpressionResults,
  expressionTables,
} from '../support/expressionResultsContract'

import { withPostgresDatabase } from './postgresIntegration'

it('should returns typed native PostgreSQL expression values through query composition', async () => {
  await withPostgresDatabase(expressionTables, async ({ db }) => {
    await assertExpressionResults(db)

    expect(
      await db
        .from(NumericValues)
        .select((b) => [b.as(b.sum(NumericValues.big), 'sum')])
        .execute(),
    ).toEqual([{ sum: 18_000_000_000_000_000_000n }])
  })
})

it('should keeps PostgreSQL truncation output types and session timezone in CTE filters', async () => {
  const Dates = defineTable(
    'expression_dates',
    {
      id: pipe(number(), integer()),
      day: pipe(date(), column({ physicalType: { postgresql: 'date' } })),
      wall: pipe(date(), column({ physicalType: { postgresql: 'timestamp' } })),
      instant: pipe(date(), column({ physicalType: { postgresql: 'timestamptz' } })),
    },
    { primaryKey: 'id' },
  )

  await withPostgresDatabase([Dates], async ({ db }) => {
    await db.migrate().execute()
    const instant = new Date('2026-06-15T03:04:05.000Z')
    await db
      .insert(Dates)
      .values({ id: 1, day: instant, wall: instant, instant })
      .execute()

    await db.transaction(async (tx) => {
      await tx.sql`set local time zone 'Australia/Hobart'`
      const cte = tx.cte(
        'truncated',
        tx
          .from(Dates)
          .select((b) => [
            b.as(b.dateTrunc('day', Dates.day), 'day'),
            b.as(b.dateTrunc('day', Dates.wall), 'wall'),
            b.as(b.dateTrunc('day', Dates.instant), 'instant'),
          ]),
      )

      const rows = await tx.with(cte).from(cte).execute()
      expect(rows).toEqual([
        {
          day: new Date('2026-06-14T14:00:00.000Z'),
          wall: new Date('2026-06-15T00:00:00.000Z'),
          instant: new Date('2026-06-14T14:00:00.000Z'),
        },
      ])

      expect(
        await tx
          .with(cte)
          .from(cte)
          .where(eq(cte.day, rows[0].day))
          .where(eq(cte.wall, rows[0].wall))
          .where(eq(cte.instant, rows[0].instant))
          .execute(),
      ).toEqual(rows)
    })
  })
})
