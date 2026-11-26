import { date, integer, number, pipe } from 'valibot'
import { expect, it } from 'vitest'

import { column, defineTable, eq, scalar } from '@/index'

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

it('should support PostgreSQL physical type aliases in helpers and widened comparisons', async () => {
  const Aliases = defineTable(
    'expression_aliases',
    {
      id: pipe(number(), integer(), column({ physicalType: { postgresql: 'int4' } })),
      small: pipe(number(), integer(), column({ physicalType: { postgresql: 'int2' } })),
      wide: pipe(number(), integer(), column({ physicalType: { postgresql: 'int8' } })),
      real: pipe(number(), column({ physicalType: { postgresql: 'float4' } })),
      double: pipe(number(), column({ physicalType: { postgresql: 'float8' } })),
    },
    { primaryKey: 'id' },
  )

  await withPostgresDatabase([Aliases], async ({ db }) => {
    await db.migrate().execute()

    await db
      .insert(Aliases)
      .values([
        { id: 1, small: 2, wide: 3, real: 1.5, double: 2.5 },
        { id: 2, small: 4, wide: 5, real: 2.5, double: 3.5 },
      ])
      .execute()

    expect(
      await db
        .from(Aliases)
        .select((b) => [
          b.as(b.sum(Aliases.id), 'id'),
          b.as(b.sum(Aliases.small), 'small'),
          b.as(b.sum(Aliases.wide), 'wide'),
          b.as(b.sum(Aliases.real), 'real'),
          b.as(b.sum(Aliases.double), 'double'),
          b.as(b.min(Aliases.small), 'min'),
          b.as(b.max(Aliases.wide), 'max'),
        ])
        .execute(),
    ).toEqual([{ id: 3, small: 6, wide: 8, real: 4, double: 6, min: 2, max: 5 }])

    const counts = db.from(Aliases).select((b) => [b.as(b.countAll(), 'n')])
    expect(
      await db
        .from(Aliases)
        .where(eq(Aliases.id, scalar(counts)))
        .select([Aliases.id])
        .execute(),
    ).toEqual([{ id: 2 }])
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
