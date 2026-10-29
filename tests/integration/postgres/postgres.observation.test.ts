import { pipe, string } from 'valibot'
import { expect, it } from 'vitest'

import type { QueryEvent } from '@/index'
import { column, defineTable } from '@/index'

import { withPostgresDatabase } from './postgresIntegration'

it('observes native migration stages and application execution without bootstrap SQL', async () => {
  const Item = defineTable(
    'observed_items',
    { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
    { primaryKey: 'id' },
  )

  const events: QueryEvent[] = []
  await withPostgresDatabase(
    [Item],
    async ({ db }) => {
      await db.migrate().execute()
      expect(events.some((e) => e.source === 'catalog')).toBe(true)
      expect(events.some((e) => e.source === 'coordination')).toBe(true)

      expect(
        events.find((e) => e.sql.toLowerCase().startsWith('create table'))?.source,
      ).toBe('ddl')

      expect(events.find((e) => e.sql.toLowerCase() === 'commit')?.source).toBe(
        'lifecycle',
      )

      expect(events.every((e) => e.outcome === 'success')).toBe(true)
      events.length = 0

      await db.transaction(async (trx) => {
        await trx.insert(Item).values({ id: 'secret' }).execute()
        expect(await trx.from(Item).execute()).toEqual([{ id: 'secret' }])
      })

      expect(events.map((e) => e.source)).toEqual([
        'lifecycle',
        'query',
        'query',
        'lifecycle',
      ])

      expect(events[1]?.params).toEqual(['[REDACTED]'])
      events.length = 0

      await expect(db.sql`select * from missing_observation_table`).rejects.toThrow(
        'postgresql database session SQL execution failed',
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ source: 'query', outcome: 'error' })
    },
    {
      onQuery: (event) => {
        events.push(event)
      },
    },
  )
})
