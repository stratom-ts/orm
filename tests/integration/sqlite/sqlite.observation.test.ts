import { spawnSync } from 'node:child_process'
import { tracingChannel } from 'node:diagnostics_channel'
import { pipe, string } from 'valibot'
import { expect, it, onTestFinished } from 'vitest'

import type { QueryEvent } from '@/index'
import { QUERY_CHANNEL, column, defineTable, withTracing } from '@/index'

import { withSqliteDatabase } from './sqliteIntegration'

/** Checks the source contract for each distinct native migration stage. */
function expectMigrationSources(events: readonly QueryEvent[]): void {
  expect(events.some((e) => e.source === 'catalog')).toBe(true)
  expect(events.some((e) => e.source === 'coordination')).toBe(true)

  expect(events.find((e) => e.query.toLowerCase() === 'begin immediate')?.source).toBe(
    'coordination',
  )

  expect(
    events.find((e) => e.query.toLowerCase() === 'pragma main.foreign_key_check')?.source,
  ).toBe('catalog')

  expect(
    events.find((e) => e.query.toLowerCase() === 'pragma main.integrity_check')?.source,
  ).toBe('catalog')

  expect(
    events.find((e) => e.query.toLowerCase().startsWith('create table'))?.source,
  ).toBe('ddl')

  expect(events.find((e) => e.query.toLowerCase() === 'commit')?.source).toBe('lifecycle')

  expect(events.every((e) => e.outcome === 'success')).toBe(true)
}

it('should observe native migration stages and application execution without bootstrap SQL', async () => {
  const Item = defineTable(
    'observed_items',
    { id: pipe(string(), column({ physicalType: { sqlite: 'text' } })) },
    { primaryKey: 'id' },
  )

  const events: QueryEvent[] = []
  const channel = tracingChannel(QUERY_CHANNEL)
  const subscribers = {
    asyncEnd: (event: unknown) => {
      events.push(event as QueryEvent)
    },
  }

  channel.subscribe(subscribers)
  onTestFinished(() => channel.unsubscribe(subscribers))

  await withSqliteDatabase([Item], async ({ db: original }) => {
    const db = withTracing(original)
    await original.ping()
    expect(events).toEqual([])
    await db.migrate().execute()
    expectMigrationSources(events)
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
    expect(events.every((event) => Reflect.get(event, 'result') === undefined)).toBe(true)
    events.length = 0

    await expect(db.sql`select * from missing_observation_table`).rejects.toThrow(
      'sqlite database session SQL preparation failed',
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ source: 'query', outcome: 'error' })
  })
})

it.each(['throw', 'reject'])(
  'should use Node subscriber failure semantics in a subprocess: %s',
  (kind) => {
    const script = `
    import { tracingChannel } from 'node:diagnostics_channel'
    import sqlite from 'db0/connectors/node-sqlite'
    import { createDatabase, withTracing, QUERY_CHANNEL } from './dist/stratom.js'
    const db = withTracing(createDatabase({ connector: sqlite({ name: ':memory:' }), schemas: [] }))
    tracingChannel(QUERY_CHANNEL).subscribe({
      asyncEnd() {
        ${kind === 'throw' ? "throw new Error('subscriber failed')" : "return Promise.reject(new Error('subscriber failed'))"}
      },
    })
    await db.ping()
    await db.close()
  `

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 15_000,
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Error: subscriber failed')
  },
)
