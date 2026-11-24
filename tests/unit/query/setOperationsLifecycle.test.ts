import { tracingChannel } from 'node:diagnostics_channel'
import { number, pipe } from 'valibot'
import { expect, it, onTestFinished } from 'vitest'

import type { QueryEvent } from '@/index'
import {
  QUERY_CHANNEL,
  QueryError,
  column,
  createDatabase,
  defineTable,
  postgresDialect,
  withTracing,
} from '@/index'
import { createTableBuilder, createValueMapper } from '@/query'

import { deferred } from '../../helpers/deferredPromise'
import {
  createControllableProvider,
  customConnector,
} from '../helpers/operationSessionFixtures'

const Records = defineTable('set_lifecycle', { id: number() }, { primaryKey: 'id' })

it('should trace one statement and drain an accepted compound before closing', async () => {
  const started = deferred()
  const finish = deferred()
  const controls = createControllableProvider({
    beforeCall: async (_session, sql) => {
      if (sql.includes('union all')) {
        started.resolve()
        await finish.promise
      }
    },
  })

  const original = createDatabase({
    connector: customConnector('postgresql'),
    schemas: [Records],
    operationSessionProvider: controls.provider,
  })

  const db = withTracing(original, { queryParameters: 'include' })
  const events: QueryEvent[] = []
  const channel = tracingChannel(QUERY_CHANNEL)
  const subscribers = { asyncEnd: (value: unknown) => events.push(value as QueryEvent) }
  channel.subscribe(subscribers)
  onTestFinished(() => channel.unsubscribe(subscribers))

  const query = db
    .from(Records)
    .where(Records.id, 'eq', 1)
    .unionAll(db.from(Records).where(Records.id, 'eq', 2))

  expect(query.compile().params).toEqual([1, 2])
  expect(controls.calls).toEqual([])
  const running = query.execute()
  await started.promise
  const closing = db.close()

  try {
    expect(controls.closeCount).toBe(0)
    await expect(query.execute()).rejects.toThrow(/closed/i)
  } finally {
    finish.resolve()
  }

  await Promise.all([running, closing])
  expect(controls.calls).toHaveLength(1)
  expect(events).toHaveLength(1)

  expect(events[0]).toMatchObject({
    query: query.compile().sql,
    params: [1, 2],
    source: 'query',
    outcome: 'success',
  })

  expect(controls.closeCount).toBe(1)
  await expect(query.execute()).rejects.toThrow(QueryError)
})

it('should reject parent, nested and sibling transaction operands without SQL', async () => {
  const controls = createControllableProvider()
  const db = createDatabase({
    connector: customConnector('postgresql'),
    schemas: [Records],
    operationSessionProvider: controls.provider,
  })

  const root = db.from(Records)
  let expired = root.union(root)
  try {
    await db.transaction(async (tx) => {
      const a = tx.from(Records)
      expired = a.union(a)
      expect(() => a.union(root)).toThrow(/client scope/)
      expect(() => root.union(a)).toThrow(/client scope/)

      await tx.transaction(async (nested) => {
        expect(() => nested.from(Records).union(a)).toThrow(/client scope/)
      })
    })

    await expect(expired.execute()).rejects.toThrow(/transaction|active|expired/i)

    expect(controls.calls.map((c) => c.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'release savepoint sp_1',
      'commit',
    ])
  } finally {
    await db.close()
  }
})

it('should keep a database identity guard supplied only by the right operand', () => {
  const Foreign = defineTable(
    'set_foreign',
    { id: number() },
    {
      primaryKey: 'id',
      namespace: [
        { role: 'database', spelling: 'analytics' },
        { role: 'schema', spelling: 'public' },
      ],
    },
  )

  const query = postgresDialect.query.resolve([Records, Foreign])
  const mapper = createValueMapper(postgresDialect, undefined, [Records, Foreign], query)
  const executor = { execute: async () => [], run: async () => 0 }
  const from = <H extends typeof Records | typeof Foreign>(handle: H) =>
    createTableBuilder({ handle, dialect: postgresDialect, query, mapper, executor })

  const compiled = from(Records).union(from(Foreign)).compile()
  expect(compiled.assertSession).toBeTypeOf('function')
  expect(() => compiled.assertSession?.({ database: 'analytics' })).not.toThrow()
  expect(() => compiled.assertSession?.({ database: 'other' })).toThrow(/database/)
})

it('should preserve compiler and parameter mapping defects by identity', async () => {
  const defect = Object.freeze(new Error('compiler defect'))
  const resolved = postgresDialect.query.resolve([Records])
  const mapper = createValueMapper(postgresDialect, undefined, [Records], resolved)
  const query = {
    ...resolved,
    compile: () => {
      throw defect
    },
  }

  const executor = { execute: async () => [], run: async () => 0 }
  const a = createTableBuilder({
    handle: Records,
    dialect: postgresDialect,
    query,
    mapper,
    executor,
  })

  expect(() => a.union(a).compile()).toThrow(defect)
  await expect(a.union(a).execute()).rejects.toBe(defect)
  const Broken = defineTable(
    'set_broken',
    {
      id: pipe(
        number(),
        column({
          mapParam: () => {
            throw defect
          },
        }),
      ),
    },
    { primaryKey: 'id' },
  )

  const controls = createControllableProvider()
  const db = createDatabase({
    connector: customConnector('postgresql'),
    schemas: [Broken],
    operationSessionProvider: controls.provider,
  })

  try {
    const branch = db.from(Broken).where(Broken.id, 'eq', 1)
    await expect(branch.union(branch).execute()).rejects.toBe(defect)
    expect(controls.calls).toEqual([])
  } finally {
    await db.close()
  }
})
